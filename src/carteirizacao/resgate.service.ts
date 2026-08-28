import { Injectable, Logger } from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { WhatsappRepository } from '../whatsapp/whatsapp.repository';

/**
 * Esteira de resgate + painel esforço × resultado (fase 1, Sprint 3).
 *
 * A esteira: um EPISÓDIO abre quando o cliente entra em risco de inativação
 * (45+ dias sem compra) e acompanha até o desfecho. O estágio avança SOZINHO
 * por sinal observado — nenhum card é arrastado:
 *
 *   A_CONTATAR -> CONTATADO (mensagem enviada, sensor WAHA)
 *              -> PROPOSTA  (orçamento novo no Celta)
 *              -> RECUPERADO (venda) | PERDIDO (chegou aos 60d e inativou)
 *
 * O SLA de primeiro contato (48h, curva A — mesmo env da fila) fica gravado no
 * episódio; "cumpriu ou não" é o número que o painel leva à reunião semanal.
 *
 * O painel: por vendedor, na janela — orçamentos emitidos (esforço bruto, ERP),
 * mensagens (sensor), tarefas concluídas por sinal, escaladas em aberto,
 * resgates recuperados/perdidos, SLA e motivos de perda respondidos.
 */

const DIA_MS = 86_400_000;

/** Uma linha do painel esforço × resultado (um vendedor na janela). */
export interface LinhaEsforco {
  rep_codigo: number;
  rep_nome: string;
  clientes_carteira: number;
  orcamentos: number;
  valor_orcado: number;
  msgs_enviadas: number;
  msgs_recebidas: number;
  concluidas_venda: number;
  concluidas_orcamento: number;
  concluidas_mensagem: number;
  escaladas_abertas: number;
  resgates_recuperados: number;
  resgates_perdidos: number;
  sla_cumprido: number;
  sla_total: number;
  motivos_respondidos: number;
}

const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

@Injectable()
export class ResgateService {
  private readonly logger = new Logger(ResgateService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly erp: CarteirizacaoErpRepository,
    private readonly wa: WhatsappRepository,
  ) {}

  private get slaHoras(): number {
    return envNum('FILA_PRAZO_RESGATE_HORAS', 48);
  }

  // ------------------------------------------------------------ reconciliar
  /**
   * Roda em toda leitura da esteira (e após a carga diária): fecha e avança os
   * episódios pelos sinais, e abre episódio para quem acabou de entrar em risco.
   */
  async reconciliar(clientesParam?: ClienteCarteira[]) {
    const clientes = clientesParam ?? (await this.carteirizacao.snapshotCarteira());
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const [abertos, msgEnviada] = await Promise.all([
      this.repo.resgatesAbertos(),
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);

    const agora = new Date();
    const comEpisodio = new Set<number>();

    for (const r of abertos) {
      comEpisodio.add(r.cli_codigo);
      const cli = mapa.get(r.cli_codigo);
      const aberto = new Date(r.aberto_em).getTime();

      // Cliente sumiu da base do atacado no meio do episódio: perdeu.
      if (!cli || !cli.em_carteira) {
        await this.repo.atualizarResgate(r.id, { estagio: 'PERDIDO', fechado_em: agora });
        continue;
      }

      const depois = (d: Date | null | undefined) =>
        d && new Date(d).getTime() > aberto ? new Date(d) : null;
      const venda = depois(cli.data_ult_compra);
      const orc = depois(cli.ult_orcamento);
      const msg = depois(msgEnviada.get(r.cli_codigo));
      const primeiroSinal = [venda, orc, msg]
        .filter((d): d is Date => d != null)
        .sort((a, b) => a.getTime() - b.getTime())[0];

      const data: Parameters<CarteirizacaoPrismaRepository['atualizarResgate']>[1] = {};

      // Carteira trocou de dono no meio do episódio: o card segue o cliente.
      if (cli.rep_codigo !== r.rep_codigo) {
        data.rep_codigo = cli.rep_codigo;
        data.rep_nome = cli.rep_nome;
      }

      // Marcos monotônicos: gravados uma vez, na primeira reconciliação que os vê.
      if (!r.contatado_em && primeiroSinal) data.contatado_em = primeiroSinal;
      if (!r.proposta_em && orc) data.proposta_em = orc;

      // SLA avaliado uma única vez: cumpriu se o 1º sinal veio dentro do prazo;
      // falhou quando o prazo passou sem sinal nenhum.
      if (r.sla_em && r.sla_cumprido == null) {
        const prazo = new Date(r.sla_em).getTime();
        if (primeiroSinal && primeiroSinal.getTime() <= prazo) data.sla_cumprido = true;
        else if (!primeiroSinal && agora.getTime() > prazo) data.sla_cumprido = false;
        else if (primeiroSinal && primeiroSinal.getTime() > prazo) data.sla_cumprido = false;
      }

      // Estágio = o mais avançado que os sinais sustentam.
      if (venda) {
        data.estagio = 'RECUPERADO';
        data.fechado_em = venda;
      } else if (cli.status === 'INATIVO') {
        data.estagio = 'PERDIDO';
        data.fechado_em = agora;
      } else if (orc && r.estagio !== 'PROPOSTA') data.estagio = 'PROPOSTA';
      else if (msg && r.estagio === 'A_CONTATAR') data.estagio = 'CONTATADO';

      if (Object.keys(data).length) await this.repo.atualizarResgate(r.id, data);
    }

    // Abertura: quem entrou em risco e ainda não tem episódio em andamento.
    const novos = clientes
      .filter(
        (c) =>
          c.risco_inativacao &&
          c.em_carteira &&
          c.rep_codigo != null &&
          !c.revisao &&
          !comEpisodio.has(c.cli_codigo),
      )
      .map((c) => ({
        cli_codigo: c.cli_codigo,
        cli_nome: c.cli_nome,
        rep_codigo: c.rep_codigo,
        rep_nome: c.rep_nome,
        curva: c.curva_abc,
        faturamento_total: c.faturamento_total,
        dias_sem_compra_abertura: c.dias_sem_compra,
        // SLA de 1º contato só para curva A — onde a perda dói mais rápido.
        sla_em: c.curva_abc === 'A' ? new Date(Date.now() + this.slaHoras * 3_600_000) : null,
      }));
    await this.repo.abrirResgates(novos);
    if (novos.length) this.logger.log(`Esteira de resgate: ${novos.length} episódios abertos.`);
    return { abertos: abertos.length, novos: novos.length };
  }

  // ----------------------------------------------------------------- listar
  /** A esteira: colunas em andamento + desfechos da janela, com contexto p/ agir. */
  async listar(params: { rep_codigo?: number; janelaDias?: number }) {
    const janela = Math.max(1, Math.min(90, params.janelaDias ?? 30));
    const clientes = await this.carteirizacao.snapshotCarteira();
    await this.reconciliar(clientes);

    const desde = new Date(Date.now() - janela * DIA_MS);
    const [abertos, fechados] = await Promise.all([
      this.repo.resgatesAbertos(),
      this.repo.resgatesFechadosDesde(desde, params.rep_codigo),
    ]);
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));

    const card = (r: (typeof abertos)[number]) => {
      const cli = mapa.get(r.cli_codigo);
      return {
        id: r.id,
        estagio: r.estagio,
        cli_codigo: r.cli_codigo,
        cli_nome: cli?.cli_nome ?? r.cli_nome,
        rep_codigo: r.rep_codigo,
        rep_nome: r.rep_nome,
        curva: r.curva,
        faturamento_total: Number(r.faturamento_total),
        aberto_em: r.aberto_em,
        contatado_em: r.contatado_em,
        proposta_em: r.proposta_em,
        fechado_em: r.fechado_em,
        sla_em: r.sla_em,
        sla_cumprido: r.sla_cumprido,
        dias_sem_compra: cli?.dias_sem_compra ?? null,
        fone: cli?.fone ?? null,
        valor_orcado_90d: cli?.valor_orcado_90d ?? 0,
      };
    };

    let cards = abertos.map(card);
    if (params.rep_codigo != null) {
      cards = cards.filter((c) => c.rep_codigo === Number(params.rep_codigo));
    }
    // Dentro de cada estágio, o maior valor em jogo primeiro.
    cards.sort((a, b) => b.faturamento_total - a.faturamento_total);

    return {
      janela_dias: janela,
      estagios: {
        a_contatar: cards.filter((c) => c.estagio === 'A_CONTATAR'),
        contatado: cards.filter((c) => c.estagio === 'CONTATADO'),
        proposta: cards.filter((c) => c.estagio === 'PROPOSTA'),
        recuperado: fechados.filter((f) => f.estagio === 'RECUPERADO').map(card),
        perdido: fechados.filter((f) => f.estagio === 'PERDIDO').map(card),
      },
    };
  }

  // ------------------------------------------------- painel esforço×resultado
  /** Por vendedor, na janela: o que foi tentado e o que virou resultado. */
  async painelEsforco(janelaDias = 7) {
    const janela = Math.max(1, Math.min(90, janelaDias));
    const desde = new Date(Date.now() - janela * DIA_MS);
    const desdeYmd = desde.toISOString().slice(0, 10);

    // Reconciliar antes de medir: os números refletem o constatado agora.
    const clientes = await this.carteirizacao.snapshotCarteira();
    await this.reconciliar(clientes);

    const [vendedores, orcs, msgs, concluidas, escaladas, sla, fechadosJanela, desfechos, motivos] =
      await Promise.all([
        this.carteirizacao.listarVendedores(),
        this.erp.orcamentosPorRep(desdeYmd).catch(() => []),
        this.wa.mensagensPorRepDesde(desde),
        this.repo.tarefasConcluidasPorRepDesde(desde),
        this.repo.escaladasPorRep(),
        this.repo.slaResgatePorRepDesde(desde),
        this.repo.resgatesFechadosDesde(desde),
        this.repo.desfechosPorRepDesde(desde),
        this.repo.resumoMotivosDesde(desde),
      ]);

    const linhas = new Map<number, LinhaEsforco>();
    const linha = (rep: number | null): LinhaEsforco | null => {
      if (rep == null) return null;
      if (!linhas.has(rep)) {
        linhas.set(rep, {
          rep_codigo: rep,
          rep_nome: `Rep ${rep}`,
          clientes_carteira: 0,
          orcamentos: 0,
          valor_orcado: 0,
          msgs_enviadas: 0,
          msgs_recebidas: 0,
          concluidas_venda: 0,
          concluidas_orcamento: 0,
          concluidas_mensagem: 0,
          escaladas_abertas: 0,
          resgates_recuperados: 0,
          resgates_perdidos: 0,
          sla_cumprido: 0,
          sla_total: 0,
          motivos_respondidos: 0,
        });
      }
      return linhas.get(rep)!;
    };

    for (const v of vendedores) {
      const l = linha(v.rep_codigo)!;
      l.rep_nome = v.rep_nome;
      l.clientes_carteira = v.clientes_carteira;
    }
    for (const o of orcs) {
      const l = linha(o.rep_codigo);
      if (l) {
        l.orcamentos = o.qtd;
        l.valor_orcado = o.valor;
      }
    }
    for (const m of msgs) {
      const l = linha(m.rep_codigo);
      if (!l) continue;
      if (m.direcao === 'ENVIADA') l.msgs_enviadas = m._count._all;
      else l.msgs_recebidas = m._count._all;
    }
    for (const c of concluidas) {
      const l = linha(c.rep_codigo);
      if (!l) continue;
      if (c.conclusao_sinal === 'VENDA') l.concluidas_venda = c._count._all;
      else if (c.conclusao_sinal === 'ORCAMENTO') l.concluidas_orcamento = c._count._all;
      else if (c.conclusao_sinal === 'MENSAGEM') l.concluidas_mensagem = c._count._all;
    }
    for (const e of escaladas) {
      const l = linha(e.rep_codigo);
      if (l) l.escaladas_abertas = e._count._all;
    }
    for (const s of sla) {
      const l = linha(s.rep_codigo);
      if (!l) continue;
      l.sla_total += s._count._all;
      if (s.sla_cumprido) l.sla_cumprido += s._count._all;
    }
    for (const f of fechadosJanela) {
      const l = linha(f.rep_codigo);
      if (!l) continue;
      if (f.estagio === 'RECUPERADO') l.resgates_recuperados++;
      else l.resgates_perdidos++;
    }
    for (const d of desfechos) {
      const l = linha(d.rep_codigo);
      if (l) l.motivos_respondidos = d._count._all;
    }

    // Só quem tem carteira ou atividade na janela — sem linha morta no painel.
    const itens = [...linhas.values()]
      .filter(
        (l) =>
          l.clientes_carteira > 0 ||
          l.orcamentos > 0 ||
          l.msgs_enviadas > 0 ||
          l.concluidas_venda + l.concluidas_orcamento + l.concluidas_mensagem > 0,
      )
      .sort((a, b) => b.valor_orcado - a.valor_orcado);

    return {
      janela_dias: janela,
      vendedores: itens,
      motivos: motivos.sort((a, b) => b.quantidade - a.quantidade),
      totais: {
        orcamentos: itens.reduce((s, l) => s + l.orcamentos, 0),
        valor_orcado: itens.reduce((s, l) => s + l.valor_orcado, 0),
        recuperados: itens.reduce((s, l) => s + l.resgates_recuperados, 0),
        perdidos: itens.reduce((s, l) => s + l.resgates_perdidos, 0),
        escaladas: itens.reduce((s, l) => s + l.escaladas_abertas, 0),
      },
    };
  }
}
