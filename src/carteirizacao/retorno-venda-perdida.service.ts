import { Injectable, Logger } from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { hojeYmd, inicioDia } from './supervisao.indicadores';
import {
  CfgRetorno,
  MudancaRetorno,
  GrupoRetorno,
  Retorno,
  agruparPorCliente,
  candidatos,
  conversao,
  destino,
  elegivel,
  sinalDeContato,
  transicao,
} from './retorno-venda-perdida';

/**
 * Retorno de venda perdida ("produto chegou"): uma vez por dia (carga diária e botão
 * "gerar" da fila) reconcilia os retornos existentes e gera os novos. A regra mora em
 * retorno-venda-perdida.ts; aqui só se leem as fontes e se grava.
 *
 * Config (env, padrão no código):
 *   VP_RETORNO_PRAZO_DIAS      (3)  dias para o vendedor fazer o contato
 *   VP_RETORNO_VALIDADE_DIAS   (90) idade máxima da venda perdida
 *   VP_RETORNO_CONVERSAO_DIAS  (15) janela em que a venda do par conta como conversão
 *   VP_RETORNO_INICIO          (2026-10-15) venda perdida anterior não gera retorno
 *
 * Saldo (ERP) e notas (BI) são lidos uma vez por execução. Se um dos dois falhar, a
 * execução para depois de gravar o contato/prazo: sem saldo não se cancela nem se gera.
 */
export interface ResumoRetornos {
  geradas: number;
  contatadas: number;
  negligenciadas: number;
  canceladas: number;
  convertidas: number;
  /** Clientes distintos com retorno novo, por vendedor (aviso do dia). */
  chegouPorRep: Map<number, number>;
}

const DIA_MS = 86_400_000;

// Local, como nos outros serviços da fila: importar de supervisao.service fecharia o
// ciclo fila.service -> este serviço -> supervisao.service -> fila.service (DI do Nest).
const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

/** O que a reconciliação grava num retorno: transição de estado e/ou conversão. */
type Mudanca = MudancaRetorno & Partial<ReturnType<typeof conversao>>;

@Injectable()
export class RetornoVendaPerdidaService {
  private readonly logger = new Logger(RetornoVendaPerdidaService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly orcamento: OrcamentoService,
    private readonly avisosVendas: AvisosVendasService,
  ) {}

  private get cfg(): CfgRetorno {
    const inicio = process.env.VP_RETORNO_INICIO ?? '';
    return {
      prazoDias: envNum('VP_RETORNO_PRAZO_DIAS', 3),
      validadeDias: envNum('VP_RETORNO_VALIDADE_DIAS', 90),
      conversaoDias: envNum('VP_RETORNO_CONVERSAO_DIAS', 15),
      inicio: /^\d{4}-\d{2}-\d{2}$/.test(inicio) ? inicio : '2026-10-15',
    };
  }

  private processando: Promise<ResumoRetornos> | null = null;

  /** Carga diária e botão podem coincidir: quem chega com uma execução em curso espera a mesma. */
  async processar(): Promise<ResumoRetornos> {
    if (this.processando) return this.processando;
    this.processando = this.processarAgora().finally(() => {
      this.processando = null;
    });
    return this.processando;
  }

  /**
   * Bloco "produto chegou" da fila do dia (GET /carteirizacao/fila). Na leitura só se
   * reconciliam contato e prazo dos abertos (sem ERP/BI: saldo desconhecido nunca
   * cancela); cancelamento, conversão e geração ficam para processar().
   */
  async listar(params: { rep_codigo?: number }, clientes: ClienteCarteira[]): Promise<GrupoRetorno[]> {
    const cfg = this.cfg;
    const agora = new Date();
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const [abertos, msg] = await Promise.all([
      this.repo.retornosEmAberto() as Promise<Retorno[]>,
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);
    for (const ret of abertos) {
      const cli = mapa.get(ret.cli_codigo);
      const sinal = sinalDeContato(ret.gerada_em, {
        data_ult_compra: cli?.data_ult_compra,
        ult_orcamento: cli?.ult_orcamento,
        mensagem: msg.get(ret.cli_codigo),
      });
      const m = transicao(ret, { sinal, agora }, cfg);
      if (m) await this.repo.atualizarRetorno(ret.id, m);
    }
    const doVendedor = (await this.repo.retornosEmAberto(params.rep_codigo)) as Retorno[];
    return agruparPorCliente(doVendedor, new Map(clientes.map((c) => [c.cli_codigo, c.fone])));
  }

  private async processarAgora(): Promise<ResumoRetornos> {
    const cfg = this.cfg;
    const agora = new Date();
    const janela = new Date(agora.getTime() - (cfg.conversaoDias + 1) * DIA_MS);
    const r: ResumoRetornos = { geradas: 0, contatadas: 0, negligenciadas: 0, canceladas: 0, convertidas: 0, chegouPorRep: new Map() };

    const gravar = async (ret: Retorno, m: Mudanca) => {
      const antes = ret.status;
      await this.repo.atualizarRetorno(ret.id, m);
      Object.assign(ret, m);
      if (ret.status === antes) return;
      if (ret.status === 'CONTATADA') r.contatadas++;
      else if (ret.status === 'NEGLIGENCIADA') r.negligenciadas++;
      else if (ret.status === 'CANCELADA') r.canceladas++;
    };

    // 1. Contato e prazo — não dependem de ERP/BI.
    const [clientes, retornos, msg] = await Promise.all([
      this.carteirizacao.snapshotCarteira(),
      this.repo.retornosParaReconciliar(janela) as Promise<Retorno[]>,
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    for (const ret of retornos) {
      // ponytail: cliente fora do snapshot (fora da base do atacado) só tem a mensagem de
      // WhatsApp como contato; a venda dele entra só pela conversão (BI).
      const cli = mapa.get(ret.cli_codigo);
      const sinal = sinalDeContato(ret.gerada_em, {
        data_ult_compra: cli?.data_ult_compra,
        ult_orcamento: cli?.ult_orcamento,
        mensagem: msg.get(ret.cli_codigo),
      });
      const m = transicao(ret, { sinal, agora }, cfg);
      if (m) await gravar(ret, m);
    }

    // 2. Candidatos, saldo e notas — uma leitura de cada.
    const corte = new Date(Math.max(agora.getTime() - cfg.validadeDias * DIA_MS, inicioDia(cfg.inicio).getTime()));
    const vendas = await this.repo.vendasPerdidasComCliente(corte);
    const existentes = await this.repo.retornosDosClientes([...new Set(vendas.map((v) => v.cli_codigo!))], corte);
    const cands = candidatos(vendas, existentes, cfg, agora);
    const abertos = retornos.filter((x) => x.encerrada_em == null);
    const naJanela = retornos.filter((x) => new Date(x.gerada_em) >= janela);
    const dias = [...naJanela.map((x) => hojeYmd(new Date(x.gerada_em))), ...cands.map((c) => hojeYmd(c.venda_perdida_em))].sort();
    const saldos = await this.orcamento.saldosPorCodigo([...abertos, ...cands].map((x) => x.pro_codigo));
    const linhas = dias.length ? await this.orcamento.vendasPorPar([...naJanela, ...cands], dias[0]) : [];

    // 3. Cancelamento por saldo, saída da lista e conversão.
    for (const ret of retornos) {
      const m: Mudanca = { ...transicao(ret, { sinal: null, saldo: saldos.get(ret.pro_codigo)?.saldo, agora }, cfg) };
      if (new Date(ret.gerada_em) >= janela) {
        const c = conversao(ret, linhas, cfg);
        const mudou =
          (c.convertida_em?.getTime() ?? null) !== (ret.convertida_em ? new Date(ret.convertida_em).getTime() : null) ||
          c.convertida_qtd !== (ret.convertida_qtd == null ? null : Number(ret.convertida_qtd)) ||
          c.convertida_valor !== (ret.convertida_valor == null ? null : Number(ret.convertida_valor));
        if (mudou) {
          Object.assign(m, c);
          if (c.convertida_em && !ret.convertida_em) r.convertidas++;
          if (c.convertida_em && ret.encerrada_em == null) {
            m.encerrada_em ??= agora;
            // Venda do par é sinal de contato: o retorno não sai da lista como ABERTA nem como
            // CANCELADA (a própria venda pode ter zerado o saldo).
            if ((m.status ?? ret.status) !== 'NEGLIGENCIADA') {
              m.status = c.convertida_em.getTime() <= new Date(ret.prazo_em).getTime() ? 'CONTATADA' : 'NEGLIGENCIADA';
              m.contato_em = c.convertida_em;
              m.contato_sinal = 'VENDA';
              delete m.cancelada_em;
            }
          }
        }
      }
      if (Object.keys(m).length) await gravar(ret, m);
    }

    // 4. Novos retornos.
    const elegiveis = cands.filter((c) => elegivel(c, saldos.get(c.pro_codigo), linhas));
    if (elegiveis.length) {
      const [coberturas, ativos] = await Promise.all([
        // Dia de Cuiabá como a coluna @db.Date guarda (o hojeCuiaba da fila; importar dela fecharia ciclo).
        this.repo.coberturasAtivas(new Date(`${hojeYmd(agora)}T00:00:00Z`)),
        this.carteirizacao.vendedoresAtivosAtacado(),
      ]);
      const novos: Parameters<CarteirizacaoPrismaRepository['criarRetornos']>[0] = [];
      for (const c of elegiveis) {
        const cli = mapa.get(c.cli_codigo);
        const cob = coberturas.find((x) => cli?.rep_codigo != null && x.rep_titular_codigo === cli.rep_codigo);
        const d = destino(c, cli, cob, ativos);
        if (!d) continue;
        const produto = saldos.get(c.pro_codigo)!;
        novos.push({
          venda_perdida_id: c.venda_perdida_id,
          venda_perdida_em: c.venda_perdida_em,
          cli_codigo: c.cli_codigo,
          cli_nome: cli?.cli_nome ?? c.cli_nome ?? null,
          pro_codigo: c.pro_codigo,
          descricao: c.descricao ?? produto.descricao,
          quantidade_pedida: c.quantidade_pedida,
          saldo_na_geracao: produto.saldo,
          rep_codigo: d.rep_codigo,
          rep_nome: d.rep_nome ?? (await this.carteirizacao.resolverNomeRep(d.rep_codigo)),
          gerada_em: agora,
          prazo_em: new Date(agora.getTime() + cfg.prazoDias * DIA_MS),
        });
      }
      await this.repo.criarRetornos(novos);
      r.geradas = novos.length;
      const clis = new Map<number, Set<number>>();
      for (const n of novos) clis.set(n.rep_codigo, (clis.get(n.rep_codigo) ?? new Set()).add(n.cli_codigo));
      for (const [rep, s] of clis) r.chegouPorRep.set(rep, s.size);
    }

    // Aviso "fila do dia" com os clientes do produto que chegou. Mesmo ref (rep:data) do
    // aviso que fila.gerar() emite, então os dois se agrupam; as tarefas da régua geradas
    // hoje entram na conta. Negligência de retorno não gera aviso.
    const desde = inicioDia(hojeYmd(agora));
    for (const [rep, chegou] of r.chegouPorRep) {
      const tarefas = await this.repo.tarefasEmAndamento(rep).catch(() => null);
      const hoje = (tarefas ?? []).filter((t) => t.gerada_em >= desde);
      const resgates = hoje.filter((t) => t.tipo === 'RESGATE').length;
      void this.avisosVendas.filaDia(rep, { total: hoje.length + chegou, resgates, escaladas: 0, chegou });
    }

    this.logger.log(
      `Retorno de venda perdida: ${r.geradas} novos, ${r.contatadas} contatados, ${r.negligenciadas} negligenciados, ` +
        `${r.canceladas} cancelados, ${r.convertidas} convertidos.`,
    );
    return r;
  }
}
