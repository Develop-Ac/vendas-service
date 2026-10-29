import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira, RESGATE_DIAS } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import {
  CriarCoberturaDto,
  DelegarTarefaDto,
  DesfechoOrcamentoDto,
  EncerrarCoberturaDto,
} from './dto/carteirizacao.dto';
import { ehGestaoVendas } from './papel';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';

/**
 * Fila do dia do CRM do Atacado (fase 1) — o princípio inegociável é ESFORÇO DO
 * VENDEDOR ZERO: a fila se gera sozinha pela régua por curva e a tarefa fecha
 * sozinha quando o sinal observado aparece (orçamento novo ou venda do cliente
 * depois da geração). Ninguém marca checkbox; prazo estourado sem sinal vira
 * ESCALADA e fica visível ao supervisor.
 *
 * A régua (dias sem contato por curva ABC) e os prazos são configuráveis por
 * env — a calibração com o supervisor muda configuração, não código:
 *   FILA_REGUA_A / FILA_REGUA_B / FILA_REGUA_C   (padrão 15 / 30 / 60 dias; curva D = C,
 *                                                  60 dias é a própria inativação)
 *   FILA_PRAZO_CONTATO_DIAS                       (padrão 3 dias)
 *   FILA_PRAZO_RESGATE_HORAS                      (padrão 48h — 1º contato do resgate)
 * A janela de resgate (curva A 30 d, B 45 d, C sem resgate) é RESGATE_DIAS no
 * carteirizacao.service — acordo com o atacado em 26/10/2026.
 *
 * "Contato" hoje = compra ou orçamento (os dois sinais que o ERP enxerga).
 * Quando o sensor WhatsApp entrar (piloto WAHA), a mensagem enviada vira o
 * terceiro sinal — mesmo mecanismo, mais um comparando.
 *
 * Executor × titular: `rep_codigo` é quem trabalha a tarefa (é quem a fila,
 * os avisos e os indicadores cobram); `rep_titular_codigo` só é preenchido
 * quando a supervisão passou a tarefa a outro vendedor, e guarda o dono da
 * carteira. A troca real de carteira é comparada com o titular — tarefa
 * passada adiante não é cancelada como órfã.
 *
 * Cobertura por período (`ven_fila_cobertura`): enquanto vale (datas de
 * Cuiabá, inclusive), toda tarefa em andamento do titular ainda não passada vai
 * ao substituto e tarefa nova da régua já nasce nele, com `cobertura_id`. No fim
 * (data passou ou encerrada) só as tarefas daquela cobertura voltam ao titular.
 */

type Tarefa = Awaited<ReturnType<CarteirizacaoPrismaRepository['tarefasEmAndamento']>>[number];
type Cobertura = NonNullable<Awaited<ReturnType<CarteirizacaoPrismaRepository['obterCobertura']>>>;

/** Dia corrente em Cuiabá, como a coluna @db.Date guarda (meia-noite UTC). */
const hojeCuiaba = (): Date =>
  new Date(`${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Cuiaba' })}T00:00:00Z`);

/** 'yyyy-mm-dd' válido -> Date da coluna @db.Date; qualquer outra coisa -> null. */
const diaDe = (s: unknown): Date | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? d : null;
};

const fmtCobertura = (c: Cobertura) => ({
  ...c,
  inicio: c.inicio.toISOString().slice(0, 10),
  fim: c.fim.toISOString().slice(0, 10),
});

export const MOTIVOS_DESFECHO = [
  'PRECO',
  'PRAZO_FRETE',
  'SEM_ESTOQUE',
  'CONCORRENTE',
  'CLIENTE_ADIOU',
  'CREDITO_BLOQUEADO',
] as const;
export type MotivoDesfecho = (typeof MOTIVOS_DESFECHO)[number];

const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

const DIA_MS = 86_400_000;

@Injectable()
export class FilaService {
  private readonly logger = new Logger(FilaService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly avisosVendas: AvisosVendasService,
  ) {}

  private get regua(): Record<'A' | 'B' | 'C', number> {
    return {
      A: envNum('FILA_REGUA_A', 15),
      B: envNum('FILA_REGUA_B', 30),
      C: envNum('FILA_REGUA_C', 60),
    };
  }

  private get prazoContatoDias(): number {
    return envNum('FILA_PRAZO_CONTATO_DIAS', 3);
  }

  private get prazoResgateHoras(): number {
    return envNum('FILA_PRAZO_RESGATE_HORAS', 48);
  }

  // ------------------------------------------------------------------ gerar
  /**
   * Geração pela régua. Roda depois da carga diária (scheduler) e no botão da
   * tela; é idempotente — cliente que já tem tarefa em andamento não entra de
   * novo. Também é aqui que tarefa órfã (cliente saiu da carteira ou trocou de
   * vendedor) é cancelada, para a fila nunca cobrar a pessoa errada.
   */
  async gerar() {
    const clientes = await this.carteirizacao.snapshotCarteira();

    // Sem a leitura de orçamentos a régua não sabe quem já foi trabalhado e
    // geraria tarefa para quem orçou ontem. Melhor falhar claro que gerar errado.
    if (!clientes.some((c) => c.quadrante != null)) {
      throw new ServiceUnavailableException(
        'A geração da fila precisa da leitura de orçamentos (erp-firebird-api). ' +
          'Sem ela, a régua cobraria contato de cliente que acabou de ser orçado.',
      );
    }

    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const ativas = await this.aplicarCoberturas();
    const coberturaDo = new Map(ativas.map((c) => [c.rep_titular_codigo, c]));
    // Cliente de titular coberto: a tarefa nasce no substituto, guardando o titular.
    const executor = (cli: ClienteCarteira) => {
      const c = cli.rep_codigo != null ? coberturaDo.get(cli.rep_codigo) : undefined;
      if (!c) return { rep_codigo: cli.rep_codigo, rep_nome: cli.rep_nome };
      return {
        rep_codigo: c.rep_substituto_codigo,
        rep_nome: c.rep_substituto_nome,
        rep_titular_codigo: cli.rep_codigo,
        rep_titular_nome: cli.rep_nome,
        delegada_por: `cobertura:${c.id}`,
        delegada_em: new Date(),
        cobertura_id: c.id,
      };
    };
    const [emAndamento, msgEnviada] = await Promise.all([
      this.repo.tarefasEmAndamento(),
      // Terceiro sinal (sensor WAHA): mensagem enviada também é contato — sem o
      // piloto no ar o mapa vem vazio e a régua segue só com compra/orçamento.
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);

    // 1) Cancela tarefas órfãs (a fila segue a carteira, que é do ERP).
    let canceladas = 0;
    const clientesComTarefa = new Set<number>();
    for (const t of emAndamento) {
      const cli = mapa.get(t.cli_codigo);
      if (!cli || !cli.em_carteira || cli.status === 'DISPONIVEL') {
        await this.repo.cancelarTarefa(t.id, 'Cliente saiu da carteira do atacado');
        canceladas++;
        continue;
      }
      if (cli.rep_codigo !== (t.rep_titular_codigo ?? t.rep_codigo)) {
        await this.repo.cancelarTarefa(
          t.id,
          `Carteira trocou de vendedor (${t.rep_nome ?? t.rep_codigo} → ${cli.rep_nome ?? cli.rep_codigo})`,
        );
        canceladas++;
        continue;
      }
      clientesComTarefa.add(t.cli_codigo);
    }

    // 2) Gera pela régua.
    const agora = Date.now();
    const regua = this.regua;
    const ciclo = await this.cicloAtrasado();
    const novas: Parameters<CarteirizacaoPrismaRepository['criarTarefas']>[0] = [];
    for (const cli of clientes) {
      if (!cli.em_carteira || cli.rep_codigo == null) continue;
      if (cli.status === 'DISPONIVEL' || cli.revisao) continue;
      if (clientesComTarefa.has(cli.cli_codigo)) continue;

      const diasCompra = cli.dias_sem_compra ?? Infinity;
      const diasOrc = cli.dias_sem_orcamento ?? Infinity;
      const ultimaMsg = msgEnviada.get(cli.cli_codigo);
      const diasMsg = ultimaMsg
        ? Math.floor((agora - ultimaMsg.getTime()) / DIA_MS)
        : Infinity;
      const diasSemContato = Math.min(diasCompra, diasOrc, diasMsg);
      const limite = regua[cli.curva_abc];

      // Resgate: curva A/B na janela de resgate (RESGATE_DIAS sem compra, orçamento
      // nem mensagem) — prioridade com prazo curto. Curva C não tem resgate.
      const limiteResgate = RESGATE_DIAS[cli.curva_abc];
      if (cli.risco_inativacao && limiteResgate != null && diasMsg >= limiteResgate) {
        novas.push({
          tipo: 'RESGATE',
          cli_codigo: cli.cli_codigo,
          cli_nome: cli.cli_nome,
          ...executor(cli),
          curva: cli.curva_abc,
          motivo_geracao: `Curva ${cli.curva_abc} a ${diasSemContato}d sem contato (resgate aos ${limiteResgate}d) — ${this.prazoResgateHoras}h para o primeiro contato`,
          prazo_em: new Date(agora + this.prazoResgateHoras * 3_600_000),
        });
        continue;
      }

      // Ciclo próprio: cliente grande que compra a cada poucos dias some muito antes
      // de a régua da curva perceber. Só vale se ninguém falou com ele desde a última compra.
      const c = ciclo.get(cli.cli_codigo);
      if (c && diasSemContato >= c.dias_sem_compra) {
        novas.push({
          tipo: 'CONTATO',
          cli_codigo: cli.cli_codigo,
          cli_nome: cli.cli_nome,
          ...executor(cli),
          curva: cli.curva_abc,
          motivo_geracao: `Fora do ritmo: ${c.dias_sem_compra}d sem compra e costuma comprar a cada ${Math.round(c.intervalo_dias)}d`,
          prazo_em: new Date(agora + this.prazoContatoDias * DIA_MS),
        });
        continue;
      }

      if (diasSemContato > limite) {
        const semCompra = diasCompra === Infinity ? 'nunca comprou' : `${diasCompra}d sem compra`;
        const semOrc = diasOrc === Infinity ? 'nunca orçado' : `${diasOrc}d sem orçamento`;
        novas.push({
          tipo: 'CONTATO',
          cli_codigo: cli.cli_codigo,
          cli_nome: cli.cli_nome,
          ...executor(cli),
          curva: cli.curva_abc,
          motivo_geracao: `Curva ${cli.curva_abc}: ${semCompra}, ${semOrc} (régua ${limite}d)`,
          prazo_em: new Date(agora + this.prazoContatoDias * DIA_MS),
        });
      }
    }

    await this.repo.criarTarefas(novas);

    // Aviso "fila do dia" por vendedor (leva ao bloco de tarefas da tela de Orçamentos) — fora do caminho crítico.
    const porRep = new Map<number, { total: number; resgates: number }>();
    for (const n of novas) {
      if (n.rep_codigo == null) continue;
      const a = porRep.get(n.rep_codigo) ?? { total: 0, resgates: 0 };
      a.total++;
      if (n.tipo === 'RESGATE') a.resgates++;
      porRep.set(n.rep_codigo, a);
    }
    for (const [rep, a] of porRep) void this.avisosVendas.filaDia(rep, { total: a.total, resgates: a.resgates, escaladas: 0 });
    const resumo = {
      geradas: novas.length,
      resgates: novas.filter((n) => n.tipo === 'RESGATE').length,
      canceladas,
      ja_em_andamento: clientesComTarefa.size,
      regua,
    };
    this.logger.log(
      `Fila gerada: ${resumo.geradas} novas (${resumo.resgates} resgates), ` +
        `${resumo.canceladas} canceladas, ${resumo.ja_em_andamento} já em andamento.`,
    );
    return resumo;
  }

  /**
   * Clientes grandes em silêncio pelo próprio ritmo de compra, calculados toda noite
   * pelo analytics-atacado-service. Opcional: sem ANALYTICS_ATACADO_URL, com o serviço
   * fora ou lento, a fila sai só pela régua.
   */
  private async cicloAtrasado(): Promise<Map<number, { dias_sem_compra: number; intervalo_dias: number }>> {
    const minimo = envNum('FILA_CICLO_MINIMO_12M', 50_000);
    const linhas = await analyticsAtacadoGet<{ cli: number; dias_sem_compra: number; intervalo_dias: number }[]>(
      `/alertas/ciclo-atrasado?minimo=${minimo}`,
    );
    return new Map((linhas ?? []).map((l) => [l.cli, l]));
  }

  // ------------------------------------------------------------ reconciliar
  /**
   * Auto-conclusão + escalonamento — roda em toda leitura da fila, então o
   * estado que a tela mostra é sempre o constatado agora:
   *  - sinal depois da geração (venda ou orçamento do cliente) -> CONCLUIDA,
   *    com `concluida_em` = a data do próprio sinal;
   *  - prazo estourado sem sinal -> ESCALADA (vira pauta do supervisor).
   */
  private reconciliando: Promise<void> | null = null;

  /**
   * Várias leituras chegam juntas (lista, bloco de tarefas, tela do supervisor):
   * quem chega com uma reconciliação em curso espera a mesma — senão duas
   * execuções escalariam a mesma tarefa e avisariam duas vezes.
   */
  async reconciliar(clientes: ClienteCarteira[]) {
    if (this.reconciliando) return this.reconciliando;
    this.reconciliando = this.reconciliarAgora(clientes).finally(() => {
      this.reconciliando = null;
    });
    return this.reconciliando;
  }

  private async reconciliarAgora(clientes: ClienteCarteira[]) {
    await this.aplicarCoberturas();
    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const [emAndamento, msgEnviada] = await Promise.all([
      this.repo.tarefasEmAndamento(),
      this.repo.ultimaMensagemEnviadaPorCliente(),
    ]);
    const agora = new Date();
    let escalouAgora = false;

    for (const t of emAndamento) {
      const cli = mapa.get(t.cli_codigo);
      if (cli) {
        const gerada = new Date(t.gerada_em).getTime();
        const depois = (d: Date | null | undefined) =>
          d && new Date(d).getTime() > gerada ? new Date(d) : null;
        const compra = depois(cli.data_ult_compra);
        const orc = depois(cli.ult_orcamento);
        const msg = depois(msgEnviada.get(t.cli_codigo));
        if (compra || orc || msg) {
          // No rótulo, o sinal mais forte vence: venda (resultado) > orçamento
          // (proposta) > mensagem (contato, via sensor WAHA).
          const sinal = compra ? 'VENDA' : orc ? 'ORCAMENTO' : 'MENSAGEM';
          await this.repo.concluirTarefa(t.id, sinal, compra ?? orc ?? msg!);
          continue;
        }
      }
      if (t.status === 'ABERTA' && new Date(t.prazo_em) < agora) {
        await this.repo.escalarTarefa(t.id);
        void this.avisosVendas.filaEscalada(t);
        escalouAgora = true;
      }
    }
    // O aviso do supervisor é um por dia (agrupado): leva o total do dia inteiro,
    // não só o desta execução — senão a escalada das 10h "apagaria" as das 5h.
    if (escalouAgora) {
      const hoje0h = new Date();
      hoje0h.setHours(0, 0, 0, 0);
      const doDia = await this.repo.escaladasDesde(hoje0h);
      const porVendedor = new Map<string, number>();
      for (const e of doDia) {
        const nome = e.rep_nome ?? (e.rep_codigo != null ? `Rep ${e.rep_codigo}` : 'Sem vendedor');
        porVendedor.set(nome, (porVendedor.get(nome) ?? 0) + 1);
      }
      void this.avisosVendas.escaladasSupervisor(porVendedor);
    }
  }

  /**
   * Coloca as tarefas em andamento de acordo com as coberturas do dia: devolve
   * ao titular o que veio de cobertura vencida/encerrada e passa ao substituto
   * o que o titular coberto tem em mãos. Devolve as coberturas ativas.
   */
  private async aplicarCoberturas() {
    const hoje = hojeCuiaba();
    for (const id of await this.repo.coberturasVencidasComTarefas(hoje)) {
      await this.repo.devolverTarefasDaCobertura(id);
    }
    const ativas = await this.repo.coberturasAtivas(hoje);
    for (const c of ativas) await this.repo.delegarTarefasDoTitular(c.rep_titular_codigo, c);
    return ativas;
  }

  // ------------------------------------------------------------------ listar
  /** A fila do dia de um vendedor (ou de todos, no gerencial). */
  async listar(params: { rep_codigo?: number }) {
    const clientes = await this.carteirizacao.snapshotCarteira();
    await this.reconciliar(clientes);

    const hoje0h = new Date();
    hoje0h.setHours(0, 0, 0, 0);
    const [tarefas, concluidasHoje] = await Promise.all([
      this.repo.tarefasEmAndamento(params.rep_codigo),
      this.repo.tarefasConcluidasDesde(hoje0h, params.rep_codigo),
    ]);

    const mapa = new Map(clientes.map((c) => [c.cli_codigo, c]));
    const enriquecer = (t: Tarefa) => this.enriquecer(t, mapa.get(t.cli_codigo));

    // Escaladas primeiro (pauta do supervisor), depois pelo prazo mais apertado.
    const itens = tarefas.map(enriquecer).sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ESCALADA' ? -1 : 1;
      return new Date(a.prazo_em).getTime() - new Date(b.prazo_em).getTime();
    });

    return {
      resumo: {
        abertas: itens.filter((t) => t.status === 'ABERTA').length,
        escaladas: itens.filter((t) => t.status === 'ESCALADA').length,
        resgates: itens.filter((t) => t.tipo === 'RESGATE').length,
        concluidas_hoje: concluidasHoje.length,
        regua: this.regua,
        prazo_contato_dias: this.prazoContatoDias,
        prazo_resgate_horas: this.prazoResgateHoras,
      },
      itens,
      concluidas_hoje: concluidasHoje.map(enriquecer),
    };
  }

  private enriquecer(t: Tarefa, cli: ClienteCarteira | undefined) {
    return {
      id: t.id,
      tipo: t.tipo,
      status: t.status,
      cli_codigo: t.cli_codigo,
      cli_nome: cli?.cli_nome ?? t.cli_nome,
      rep_codigo: t.rep_codigo,
      rep_nome: t.rep_nome,
      rep_titular_codigo: t.rep_titular_codigo,
      rep_titular_nome: t.rep_titular_nome,
      cobertura_id: t.cobertura_id,
      curva: t.curva,
      motivo_geracao: t.motivo_geracao,
      gerada_em: t.gerada_em,
      prazo_em: t.prazo_em,
      escalada_em: t.escalada_em,
      concluida_em: t.concluida_em,
      conclusao_sinal: t.conclusao_sinal,
      // contexto do cliente para agir sem trocar de tela
      fone: cli?.fone ?? null,
      cidade: cli?.cidade ?? null,
      uf: cli?.uf ?? null,
      dias_sem_compra: cli?.dias_sem_compra ?? null,
      dias_sem_orcamento: cli?.dias_sem_orcamento ?? null,
      faturamento_3m: cli?.faturamento_3m ?? 0,
      faturamento_total: cli?.faturamento_total ?? 0,
      valor_orcado_90d: cli?.valor_orcado_90d ?? 0,
      score: cli?.score ?? null,
      quadrante: cli?.quadrante ?? null,
      crediario_bloqueado: cli != null && cli.crediario != null && !cli.crediario_liberado,
    };
  }

  // ------------------------------------------------------ delegar (passar)
  /**
   * A supervisão passa uma tarefa em andamento a outro vendedor sem mexer na
   * carteira. O titular é preservado: passar de novo mantém o dono original,
   * e a geração segue comparando a carteira com ele.
   */
  async delegar(id: string, dto: DelegarTarefaDto) {
    const u = await this.exigirGestao(dto.usuario_id, 'passam tarefas entre vendedores');

    const t = await this.repo.obterTarefa(id);
    if (!t || (t.status !== 'ABERTA' && t.status !== 'ESCALADA')) {
      throw new BadRequestException('Só dá para passar tarefa aberta ou escalada.');
    }
    const rep = Number(dto.rep_codigo);
    if (!Number.isInteger(rep) || rep <= 0) throw new BadRequestException('Informe o vendedor de destino.');
    if (rep === t.rep_codigo) throw new BadRequestException('A tarefa já está com este vendedor.');
    const rep_nome = await this.carteirizacao.resolverNomeRep(rep);
    if (!rep_nome) throw new BadRequestException('Vendedor inexistente.');

    const titular = t.rep_titular_codigo ?? t.rep_codigo;
    const titularNome = t.rep_titular_codigo != null ? t.rep_titular_nome : t.rep_nome;
    // Voltar ao titular desfaz a passagem (a tarefa deixa de aparecer como "cobrindo").
    const devolvida = rep === titular;
    const atualizada = await this.repo.delegarTarefa(id, {
      rep_codigo: rep,
      rep_nome,
      rep_titular_codigo: devolvida ? null : titular,
      rep_titular_nome: devolvida ? null : titularNome,
      delegada_por: u.nome,
      delegada_em: new Date(),
      cobertura_id: null,
    });
    const clientes = await this.carteirizacao.snapshotCarteira();
    return this.enriquecer(atualizada, clientes.find((c) => c.cli_codigo === atualizada.cli_codigo));
  }

  private async exigirGestao(usuario_id: string | undefined, acao: string) {
    const u = await this.repo.usuarioVendas(usuario_id);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGestaoVendas(u)) throw new ForbiddenException(`Só a supervisão e a gerência ${acao}.`);
    return u;
  }

  // ----------------------------------------------- cobertura por período
  /** Ativas, futuras e as que acabaram nos últimos 30 dias. */
  async coberturas(usuario_id?: string) {
    await this.exigirGestao(usuario_id, 'veem as coberturas de ausência');
    const lista = await this.repo.listarCoberturas(new Date(hojeCuiaba().getTime() - 30 * DIA_MS));
    return lista.map(fmtCobertura);
  }

  async criarCobertura(dto: CriarCoberturaDto) {
    const u = await this.exigirGestao(dto.usuario_id, 'cadastram cobertura de ausência');
    const titular = Number(dto.rep_titular_codigo);
    const substituto = Number(dto.rep_substituto_codigo);
    if (!Number.isInteger(titular) || titular <= 0) throw new BadRequestException('Informe o vendedor ausente.');
    if (!Number.isInteger(substituto) || substituto <= 0) throw new BadRequestException('Informe o vendedor que vai cobrir.');
    if (substituto === titular) throw new BadRequestException('O substituto precisa ser outro vendedor.');
    const inicio = diaDe(dto.inicio);
    const fim = diaDe(dto.fim);
    if (!inicio || !fim) throw new BadRequestException('Data inválida: informe início e fim no formato AAAA-MM-DD.');
    if (fim < inicio) throw new BadRequestException('A data final não pode ser antes da inicial.');

    const [titularNome, substitutoNome] = await Promise.all([
      this.carteirizacao.resolverNomeRep(titular),
      this.carteirizacao.resolverNomeRep(substituto),
    ]);
    if (!titularNome || !substitutoNome) throw new BadRequestException('Vendedor inexistente.');

    const [doTitular, doSubstituto] = await Promise.all([
      this.repo.coberturasSobrepostas(titular, inicio, fim),
      this.repo.coberturasSobrepostas(substituto, inicio, fim),
    ]);
    if (doTitular.some((c) => c.rep_titular_codigo === titular)) {
      throw new BadRequestException(`${titularNome} já tem cobertura que cruza esse período.`);
    }
    if (doTitular.some((c) => c.rep_substituto_codigo === titular)) {
      throw new BadRequestException(`${titularNome} está cobrindo outro vendedor nesse período.`);
    }
    if (doSubstituto.some((c) => c.rep_titular_codigo === substituto)) {
      throw new BadRequestException(`${substitutoNome} também está ausente (coberto) nesse período.`);
    }

    const criada = await this.repo.criarCobertura({
      rep_titular_codigo: titular,
      rep_titular_nome: titularNome,
      rep_substituto_codigo: substituto,
      rep_substituto_nome: substitutoNome,
      inicio,
      fim,
      criado_por: u.nome,
    });
    // Começando hoje, as tarefas abertas do titular já passam agora.
    await this.aplicarCoberturas();
    return fmtCobertura(criada);
  }

  async encerrarCobertura(id: string, dto: EncerrarCoberturaDto) {
    const u = await this.exigirGestao(dto.usuario_id, 'encerram cobertura de ausência');
    const c = await this.repo.obterCobertura(id);
    if (!c) throw new BadRequestException('Cobertura não encontrada.');
    if (c.encerrada_em) throw new BadRequestException('Esta cobertura já foi encerrada.');
    const cobertura = await this.repo.encerrarCobertura(id, u.nome);
    const devolvidas = await this.repo.devolverTarefasDaCobertura(id);
    return { cobertura: fmtCobertura(cobertura), devolvidas };
  }

  // ------------------------------------------------------ desfecho (motivo)
  /**
   * A única digitação nova do vendedor em toda a fase 1: o motivo do orçamento
   * que não fechou (1 toque, 6 opções). Upsert — remarcar corrige o motivo.
   */
  async registrarDesfecho(orcamento: number, dto: DesfechoOrcamentoDto) {
    if (!MOTIVOS_DESFECHO.includes(dto.motivo as MotivoDesfecho)) {
      throw new BadRequestException(
        `Motivo inválido. Use um de: ${MOTIVOS_DESFECHO.join(', ')}.`,
      );
    }
    if (dto.cli_codigo == null) {
      throw new BadRequestException('cli_codigo é obrigatório.');
    }
    const salvo = await this.repo.upsertDesfecho({
      orcamento,
      emissao: dto.emissao ? new Date(dto.emissao) : null,
      cli_codigo: Number(dto.cli_codigo),
      cli_nome: dto.cli_nome ?? null,
      rep_codigo: dto.rep_codigo ?? null,
      rep_nome: dto.rep_nome ?? null,
      total: dto.total ?? 0,
      motivo: dto.motivo,
      observacao: dto.observacao ?? null,
      usuario_id: dto.usuario_id ?? null,
      usuario_nome: dto.usuario_nome ?? null,
    });
    return { ok: true, orcamento, motivo: salvo.motivo };
  }
}
