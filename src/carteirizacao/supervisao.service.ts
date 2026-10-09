import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { CarteirizacaoService, ClienteCarteira, REP_DISPONIVEL } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { FilaService } from './fila.service';
import { ResgateService } from './resgate.service';
import { ehGerenciaVendas } from './papel';
import { GravarMetaAtacadoDto } from './dto/carteirizacao.dto';
import {
  Cor,
  DefIndicador,
  INDICADOR,
  INDICADORES,
  MetaLinha,
  metaVigente,
  pct,
  piorCor,
  semaforo,
  somarDiasUteis,
  diaDaSemana,
  fimDia,
  hojeYmd,
  inicioDia,
  mesComissionalDe,
  periodoComissional,
  somarDias,
} from './supervisao.indicadores';

const DIA_MS = 86_400_000;
const CARENCIA_DIAS = 7;

const envNum = (nome: string, padrao: number): number => {
  const n = Number(process.env[nome]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
};

const menosDias = (ymd: string, n: number) => somarDias(ymd, -n);
/** Dia (aaaa-mm-dd) da emissão como o ERP gravou — sem passar por fuso. */
const diaEmissao = (o: { emissao: Date; emissao_ymd?: string }) => o.emissao_ymd ?? hojeYmd(o.emissao);
const mesAtual = () => {
  const m = mesComissionalDe(hojeYmd());
  return periodoComissional(m.ano, m.mes);
};

export interface ValorVendedor {
  rep_codigo: number | null;
  rep_nome: string;
  valor: number | null;
  num?: number;
  den?: number;
  semaforo?: Cor | null;
}

export interface Kpi {
  chave: string;
  nome: string;
  descricao: string;
  unidade: DefIndicador['unidade'];
  sentido: DefIndicador['sentido'];
  valor: number | null;
  anterior: number | null;
  meta: number;
  faixa_amarela: number;
  vigente_desde: string | null;
  semaforo: Cor | null;
  nota: string | null;
  detalhe: Record<string, number | null> | null;
  por_vendedor: ValorVendedor[];
}

export interface CriterioEsforco {
  valor: number | null;
  num: number;
  den: number;
  semaforo: Cor | null;
}

export interface EsforcoVendedor {
  rep_codigo: number;
  rep_nome: string;
  semaforo: Cor | null;
  criterios: Record<string, CriterioEsforco>;
  /** Curva A fora da régua — nominal, para o supervisor saber de quem cobrar. */
  curva_a_fora: Array<{ cli_codigo: number; cli_nome: string; dias_sem_contato: number | null }>;
}

/** O que a medição compartilha entre KPIs e esforço numa mesma chamada. */
interface Contexto {
  clientes: ClienteCarteira[];
  msgEnviada: Map<number, Date>;
  nomes: Map<number, string>;
  metas: MetaLinha[];
}

/**
 * Tela do supervisor do atacado: os 9 KPIs do departamento no mês comissional
 * e os 4 critérios de esforço mínimo do vendedor na semana, cada um contra a
 * meta da gerência (com vigência) e com o semáforo de `supervisao.indicadores`.
 *
 * Tudo é sinal observado — nada aqui depende de o vendedor preencher algo além
 * do motivo do orçamento perdido. Antes de medir, fila e resgate reconciliam:
 * os números refletem o constatado agora, igual à fila e à esteira.
 */
@Injectable()
export class SupervisaoService {
  private readonly logger = new Logger(SupervisaoService.name);

  constructor(
    private readonly carteirizacao: CarteirizacaoService,
    private readonly repo: CarteirizacaoPrismaRepository,
    private readonly erp: CarteirizacaoErpRepository,
    private readonly fila: FilaService,
    private readonly resgate: ResgateService,
  ) {}

  private get reguaA(): number {
    return envNum('FILA_REGUA_A', 15);
  }

  private get inicioApontamento(): string | null {
    const v = process.env.FILA_DESFECHO_INICIO;
    return v && !Number.isNaN(Date.parse(v)) ? v.slice(0, 10) : null;
  }

  // ------------------------------------------------------------------ metas
  async metas() {
    const linhas = await this.repo.metasAtacado();
    const hoje = hojeYmd();
    return {
      indicadores: INDICADORES.map((d) => ({ ...d, ...metaVigente(linhas, d.chave, hoje) })),
      historico: linhas,
    };
  }

  /** Só a gerência define metas e a faixa do semáforo; o supervisor observa. */
  async gravarMeta(dto: GravarMetaAtacadoDto) {
    const u = await this.repo.usuarioVendas(dto?.usuario_id);
    if (!u) throw new ForbiddenException('Usuário não identificado: entre de novo na intranet e tente outra vez.');
    if (!ehGerenciaVendas(u)) throw new ForbiddenException('Só a gerência altera as metas e o semáforo do atacado.');

    const def = INDICADOR.get(dto.indicador);
    if (!def) throw new BadRequestException(`Indicador desconhecido: ${dto.indicador}.`);
    const valor = Number(dto.valor);
    if (!Number.isFinite(valor) || valor < 0) throw new BadRequestException('A meta precisa ser um número maior ou igual a zero.');
    if (def.unidade === 'pct' && valor > 100) throw new BadRequestException('Meta em % vai de 0 a 100.');
    const faixa = dto.faixa_amarela == null ? 10 : Number(dto.faixa_amarela);
    if (!Number.isFinite(faixa) || faixa < 0 || faixa > 100) throw new BadRequestException('A faixa amarela vai de 0 a 100.');
    const vigente = dto.vigente_desde ?? mesAtual().inicio;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vigente) || Number.isNaN(Date.parse(vigente))) {
      throw new BadRequestException('Data de vigência inválida (use aaaa-mm-dd).');
    }

    await this.repo.inserirMetaAtacado({
      indicador: def.chave,
      valor,
      faixa_amarela: faixa,
      vigente_desde: new Date(`${vigente}T00:00:00Z`),
      observacao: dto.observacao?.trim() || null,
      criado_por: u.id,
      criado_por_nome: dto.usuario_nome ?? u.nome,
    });
    return this.metas();
  }

  // ---------------------------------------------------------------- contexto
  private async contexto(): Promise<Contexto> {
    const clientes = await this.carteirizacao.snapshotCarteira();
    // Reconciliar antes de medir: tarefas e resgates no estado constatado agora.
    await Promise.all([
      this.fila.reconciliar(clientes).catch((e) => this.logger.warn(`Fila não reconciliou: ${(e as Error).message}`)),
      this.resgate.reconciliar(clientes).catch((e) => this.logger.warn(`Resgate não reconciliou: ${(e as Error).message}`)),
    ]);
    const [msgEnviada, vendedores, metas] = await Promise.all([
      this.repo.ultimaMensagemEnviadaPorCliente(),
      this.carteirizacao.listarVendedores().catch(() => [] as Array<{ rep_codigo: number; rep_nome: string }>),
      this.repo.metasAtacado(),
    ]);
    const nomes = new Map<number, string>(vendedores.map((v) => [v.rep_codigo, v.rep_nome] as [number, string]));
    for (const c of clientes) if (c.rep_codigo != null && c.rep_nome && !nomes.has(c.rep_codigo)) nomes.set(c.rep_codigo, c.rep_nome);
    return { clientes, msgEnviada, nomes, metas };
  }

  private nome(ctx: Contexto, rep: number | null): string {
    if (rep == null) return 'Sem vendedor';
    return ctx.nomes.get(rep) ?? `Rep ${rep}`;
  }

  // ----------------------------------------------------------------- esforço
  /** Esforço mínimo de um vendedor (bloco da tela de orçamento) ou de todos. */
  async esforco(params: { rep_codigo?: number; desde?: string; ate?: string }) {
    const ctx = await this.contexto();
    return this.medirEsforco(ctx, params);
  }

  private janelaSemana(desde?: string, ate?: string): { desde: string; ate: string } {
    const hoje = hojeYmd();
    if (desde && ate && /^\d{4}-\d{2}-\d{2}$/.test(desde) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && desde <= ate) {
      return { desde, ate: ate > hoje ? hoje : ate };
    }
    // Padrão: a semana corrente, de segunda até hoje.
    return { desde: menosDias(hoje, (diaDaSemana(hoje) + 6) % 7), ate: hoje };
  }

  private async medirEsforco(ctx: Contexto, params: { rep_codigo?: number; desde?: string; ate?: string }) {
    const janela = this.janelaSemana(params.desde, params.ate);
    const desde = inicioDia(janela.desde);
    const ate = fimDia(janela.ate);
    const agora = new Date();
    const fimEfetivo = ate < agora ? ate : agora;
    const filtroRep = params.rep_codigo != null ? Number(params.rep_codigo) : null;

    // Orçamentos que entraram em "sem desfecho" (emissão + 7d) com prazo de 3
    // dias úteis vencendo na janela: emissões até ~2 semanas antes dela.
    const emissaoDesde = menosDias(janela.desde, CARENCIA_DIAS + 7);
    const emissaoAte = menosDias(janela.ate, CARENCIA_DIAS);
    const [tarefas, resgatesSla, orcs] = await Promise.all([
      this.repo.tarefasDaJanela(desde, fimEfetivo),
      this.repo.resgatesComSlaNaJanela(desde, fimEfetivo),
      this.erp.orcamentosComFechamento(emissaoDesde, emissaoAte, CARENCIA_DIAS).catch((e) => {
        this.logger.warn(`Orçamentos indisponíveis para o esforço: ${(e as Error).message}`);
        return null;
      }),
    ]);

    const inicioApont = this.inicioApontamento;
    // Entra em "sem desfecho" no 7º dia após a emissão; o motivo vence 3 dias úteis depois.
    const prazoMotivo = (o: { emissao: Date; emissao_ymd?: string }) =>
      fimDia(somarDiasUteis(somarDias(diaEmissao(o), CARENCIA_DIAS), 3));
    const semDesfecho = (orcs ?? []).filter((o) => {
      if (o.fechou) return false;
      if (inicioApont && diaEmissao(o) < inicioApont) return false;
      const p = prazoMotivo(o);
      return p >= desde && p <= fimEfetivo;
    });
    const motivos = await this.repo.desfechosDosOrcamentos(semDesfecho.map((o) => o.orcamento));

    // Vendedores medidos: quem tem carteira (o pool não trabalha cliente).
    const reps = new Set<number>();
    for (const c of ctx.clientes) {
      if (c.em_carteira && c.rep_codigo != null && c.rep_codigo !== REP_DISPONIVEL) reps.add(c.rep_codigo);
    }
    if (filtroRep != null) {
      reps.clear();
      reps.add(filtroRep);
    }

    const metaDe = (chave: string) => metaVigente(ctx.metas, chave, janela.desde);
    const criterio = (chave: string, valor: number | null, num: number, den: number): CriterioEsforco => {
      const def = INDICADOR.get(chave)!;
      const m = metaDe(chave);
      return { valor, num, den, semaforo: semaforo(valor, m.valor, m.faixa_amarela, def.unidade, def.sentido) };
    };

    const agoraMs = Date.now();
    const vendedores: EsforcoVendedor[] = [...reps].map((rep) => {
      // 1) Curva A fora da régua (posição de hoje).
      const fora = ctx.clientes
        .filter(
          (c) =>
            c.em_carteira &&
            c.rep_codigo === rep &&
            c.curva_abc === 'A' &&
            c.status !== 'DISPONIVEL' &&
            !c.revisao,
        )
        .map((c) => {
          const msg = ctx.msgEnviada.get(c.cli_codigo);
          const diasMsg = msg ? Math.floor((agoraMs - msg.getTime()) / DIA_MS) : Infinity;
          const dias = Math.min(c.dias_sem_compra ?? Infinity, c.dias_sem_orcamento ?? Infinity, diasMsg);
          return { cli_codigo: c.cli_codigo, cli_nome: c.cli_nome, dias_sem_contato: Number.isFinite(dias) ? dias : null, d: dias };
        })
        .filter((c) => c.d > this.reguaA)
        .sort((a, b) => b.d - a.d)
        .map(({ d: _d, ...c }) => c);

      // 2) Fila no prazo.
      const t = tarefas.filter((x) => x.rep_codigo === rep);
      const noPrazo = t.filter((x) => x.status === 'CONCLUIDA' && x.concluida_em && x.concluida_em <= x.prazo_em).length;

      // 3) Motivo em 3 dias úteis.
      const sd = semDesfecho.filter((o) => o.rep_codigo === rep);
      const apontados = sd.filter((o) => {
        const quando = motivos.get(o.orcamento);
        return !!quando && quando <= prazoMotivo(o);
      }).length;

      // 4) Resgate curva A em 48h (só os já avaliados).
      const r = resgatesSla.filter((x) => x.rep_codigo === rep && x.sla_cumprido != null);
      const cumpridos = r.filter((x) => x.sla_cumprido).length;

      const criterios: Record<string, CriterioEsforco> = {
        ESF_CURVA_A_FORA_REGUA: criterio('ESF_CURVA_A_FORA_REGUA', fora.length, fora.length, 0),
        ESF_FILA_NO_PRAZO_PCT: criterio('ESF_FILA_NO_PRAZO_PCT', pct(noPrazo, t.length), noPrazo, t.length),
        ESF_MOTIVO_3DU_PCT: criterio('ESF_MOTIVO_3DU_PCT', orcs == null ? null : pct(apontados, sd.length), apontados, sd.length),
        ESF_RESGATE_A_48H_PCT: criterio('ESF_RESGATE_A_48H_PCT', pct(cumpridos, r.length), cumpridos, r.length),
      };
      return {
        rep_codigo: rep,
        rep_nome: this.nome(ctx, rep),
        semaforo: piorCor(Object.values(criterios).map((c) => c.semaforo)),
        criterios,
        curva_a_fora: fora.slice(0, 20),
      };
    });

    const ordem: Record<string, number> = { vermelho: 0, amarelo: 1, verde: 2 };
    vendedores.sort(
      (a, b) => (ordem[a.semaforo ?? ''] ?? 3) - (ordem[b.semaforo ?? ''] ?? 3) || a.rep_nome.localeCompare(b.rep_nome),
    );

    return {
      janela,
      orcamentos_indisponiveis: orcs == null,
      metas: Object.fromEntries(
        INDICADORES.filter((d) => d.grupo === 'ESFORCO').map((d) => [d.chave, { ...metaDe(d.chave), nome: d.nome, unidade: d.unidade, sentido: d.sentido }]),
      ),
      vendedores,
    };
  }

  // ------------------------------------------------------------------ painel
  async painel(params: { ano?: number; mes?: number; semanaDesde?: string; semanaAte?: string }) {
    const atual = mesAtual();
    const ano = params.ano ?? atual.ano;
    const mes = params.mes ?? atual.mes;
    if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
      throw new BadRequestException('Período inválido.');
    }
    const periodo = periodoComissional(ano, mes);
    const anterior = mes === 1 ? periodoComissional(ano - 1, 12) : periodoComissional(ano, mes - 1);
    const hoje = hojeYmd();
    if (periodo.inicio > hoje) throw new BadRequestException('Período ainda não começou.');
    const corrente = periodo.inicio <= hoje && hoje <= periodo.fim;

    const ctx = await this.contexto();
    const [kpis, esforco, resgatesAbertos, escaladas] = await Promise.all([
      this.kpis(ctx, periodo, anterior, corrente),
      this.medirEsforco(ctx, { desde: params.semanaDesde, ate: params.semanaAte }),
      this.repo.resgatesAbertos(),
      this.repo.escaladasPorRep(),
    ]);

    return {
      periodo: { ano: periodo.ano, mes: periodo.mes, inicio: periodo.inicio, fim: periodo.fim, corrente },
      kpis,
      esforco,
      resgates_abertos: resgatesAbertos.length,
      escaladas_abertas: escaladas.reduce((s, e) => s + e._count._all, 0),
      escaladas_por_vendedor: escaladas
        .filter((e) => e._count._all > 0)
        .map((e) => ({ rep_codigo: e.rep_codigo, rep_nome: this.nome(ctx, e.rep_codigo), quantidade: e._count._all })),
      gerado_em: new Date().toISOString(),
    };
  }

  private async kpis(
    ctx: Contexto,
    periodo: { inicio: string; fim: string },
    anterior: { inicio: string; fim: string },
    corrente: boolean,
  ): Promise<Kpi[]> {
    const hoje = hojeYmd();
    const agora = new Date();
    // Fim efetivo da janela do mês corrente é AGORA: tarefa que vence mais tarde hoje ainda não é falha.
    const fimJanela = (p: { fim: string }) => (fimDia(p.fim) < agora ? fimDia(p.fim) : agora);
    const fimEf = (p: { fim: string }) => (p.fim < hoje ? p.fim : hoje);
    const base = ctx.clientes;
    const repDoCliente = new Map(base.map((c) => [c.cli_codigo, c.em_carteira ? c.rep_codigo : null]));

    const [fatAtual, fatAnt, orcAtual, orcAnt, filaAtual, filaAnt, slaAtual, slaAnt, fechados] = await Promise.all([
      this.erp.faturamentoPorClientePeriodo(periodo.inicio, fimEf(periodo)).catch(() => null),
      this.erp.faturamentoPorClientePeriodo(anterior.inicio, anterior.fim).catch(() => null),
      this.erp.orcamentosComFechamento(menosDias(periodo.inicio, CARENCIA_DIAS), fimEf(periodo), CARENCIA_DIAS).catch(() => null),
      this.erp.orcamentosComFechamento(menosDias(anterior.inicio, CARENCIA_DIAS), anterior.fim, CARENCIA_DIAS).catch(() => null),
      this.repo.tarefasDaJanela(inicioDia(periodo.inicio), fimJanela(periodo)),
      this.repo.tarefasDaJanela(inicioDia(anterior.inicio), fimDia(anterior.fim)),
      this.repo.resgatesComSlaNaJanela(inicioDia(periodo.inicio), fimJanela(periodo)),
      this.repo.resgatesComSlaNaJanela(inicioDia(anterior.inicio), fimDia(anterior.fim)),
      this.repo.resgatesFechadosDesde(inicioDia(periodo.inicio)),
    ]);

    const metaDe = (chave: string) => metaVigente(ctx.metas, chave, periodo.inicio);
    const montar = (
      chave: string,
      valor: number | null,
      anteriorValor: number | null,
      porVendedor: ValorVendedor[],
      extra: { nota?: string | null; detalhe?: Kpi['detalhe'] } = {},
    ): Kpi => {
      const def = INDICADOR.get(chave)!;
      const m = metaDe(chave);
      return {
        chave,
        nome: def.nome,
        descricao: def.descricao,
        unidade: def.unidade,
        sentido: def.sentido,
        valor,
        anterior: anteriorValor,
        meta: m.valor,
        faixa_amarela: m.faixa_amarela,
        vigente_desde: m.vigente_desde,
        semaforo: semaforo(valor, m.valor, m.faixa_amarela, def.unidade, def.sentido),
        nota: extra.nota ?? null,
        detalhe: extra.detalhe ?? null,
        // Meta é do departamento: só os percentuais ganham cor por vendedor.
        por_vendedor: porVendedor
          .map((v) => ({
            ...v,
            semaforo: def.unidade === 'pct' ? semaforo(v.valor, m.valor, m.faixa_amarela, def.unidade, def.sentido) : null,
          }))
          .sort((a, b) => (b.valor ?? -Infinity) - (a.valor ?? -Infinity)),
      };
    };

    // Agrupador por vendedor: soma num/den (ou valor) por rep.
    const agrupar = <T>(itens: T[], rep: (i: T) => number | null, conta: (i: T) => { num: number; den: number }) => {
      const m = new Map<number | null, { num: number; den: number }>();
      for (const i of itens) {
        const r = rep(i);
        const a = m.get(r) ?? { num: 0, den: 0 };
        const c = conta(i);
        a.num += c.num;
        a.den += c.den;
        m.set(r, a);
      }
      return m;
    };
    const linhasPct = (m: Map<number | null, { num: number; den: number }>): ValorVendedor[] =>
      [...m].map(([rep, a]) => ({ rep_codigo: rep, rep_nome: this.nome(ctx, rep), valor: pct(a.num, a.den), num: a.num, den: a.den }));
    const linhasSoma = (m: Map<number | null, { num: number; den: number }>): ValorVendedor[] =>
      [...m].map(([rep, a]) => ({ rep_codigo: rep, rep_nome: this.nome(ctx, rep), valor: a.num }));

    const kpis: Kpi[] = [];
    const semErp = 'Leitura do ERP indisponível agora.';

    // 1 e 2 — clientes ativos e receita no mês (base do atacado).
    const ativos = (fat: Map<number, number> | null) =>
      fat == null ? null : base.filter((c) => (fat.get(c.cli_codigo) ?? 0) > 0).length;
    const receita = (fat: Map<number, number> | null) =>
      fat == null ? null : base.reduce((s, c) => s + (fat.get(c.cli_codigo) ?? 0), 0);
    const porRepFat = (fat: Map<number, number> | null, soContagem: boolean) =>
      fat == null
        ? []
        : linhasSoma(
            agrupar(base, (c) => repDoCliente.get(c.cli_codigo) ?? null, (c) => {
              const v = fat.get(c.cli_codigo) ?? 0;
              return { num: soContagem ? (v > 0 ? 1 : 0) : v, den: 0 };
            }),
          ).filter((l) => (l.valor ?? 0) !== 0);
    kpis.push(
      montar('CLIENTES_ATIVOS_MES', ativos(fatAtual), ativos(fatAnt), porRepFat(fatAtual, true), {
        nota: fatAtual == null ? semErp : null,
      }),
    );
    kpis.push(
      montar('RECEITA_MES', receita(fatAtual), receita(fatAnt), porRepFat(fatAtual, false), {
        nota: fatAtual == null ? semErp : null,
      }),
    );

    // 3, 4 e 5 — posição de hoje (trimestre móvel), só no mês corrente.
    const naoHistorico = 'Posição de hoje: só existe no mês corrente.';
    if (corrente) {
      const emQueda = (c: ClienteCarteira) => c.faturamento_3m_ant > 0 && c.faturamento_3m <= c.faturamento_3m_ant * 0.7;
      const perda = (c: ClienteCarteira) => (emQueda(c) ? c.faturamento_3m_ant - c.faturamento_3m : 0);
      const vaz = agrupar(base, (c) => repDoCliente.get(c.cli_codigo) ?? null, (c) => ({ num: perda(c), den: emQueda(c) ? 1 : 0 }));
      kpis.push(
        montar(
          'VAZAMENTO_TRIMESTRE',
          base.reduce((s, c) => s + perda(c), 0),
          null,
          linhasSoma(vaz).filter((l) => (l.valor ?? 0) > 0),
          { detalhe: { clientes_em_queda: base.filter(emQueda).length } },
        ),
      );
      const temQuadrante = base.some((c) => c.quadrante != null);
      const silenciosa = agrupar(base, (c) => repDoCliente.get(c.cli_codigo) ?? null, (c) => ({
        num: c.quadrante === 'PERDA_SILENCIOSA' ? 1 : 0,
        den: 0,
      }));
      kpis.push(
        montar(
          'PERDA_SILENCIOSA',
          temQuadrante ? base.filter((c) => c.quadrante === 'PERDA_SILENCIOSA').length : null,
          null,
          temQuadrante ? linhasSoma(silenciosa).filter((l) => (l.valor ?? 0) > 0) : [],
          { nota: temQuadrante ? null : 'Leitura de orçamentos indisponível agora.' },
        ),
      );
      const compradores = agrupar(base, (c) => repDoCliente.get(c.cli_codigo) ?? null, (c) => ({
        num: c.faturamento_3m > 0 ? 1 : 0,
        den: 1,
      }));
      kpis.push(
        montar(
          'COMPRADORES_TRIMESTRE_PCT',
          pct(base.filter((c) => c.faturamento_3m > 0).length, base.length),
          pct(base.filter((c) => c.faturamento_3m_ant > 0).length, base.length),
          linhasPct(compradores),
          { detalhe: { compradores: base.filter((c) => c.faturamento_3m > 0).length, base: base.length } },
        ),
      );
    } else {
      for (const chave of ['VAZAMENTO_TRIMESTRE', 'PERDA_SILENCIOSA', 'COMPRADORES_TRIMESTRE_PCT']) {
        kpis.push(montar(chave, null, null, [], { nota: naoHistorico }));
      }
    }

    // 6 — conversão em 7 dias: orçamentos do mês já com a carência vencida.
    const limiteConv = menosDias(hoje, CARENCIA_DIAS);
    const conversao = (orcs: typeof orcAtual, p: { inicio: string; fim: string }) => {
      if (orcs == null) return null;
      return orcs.filter((o) => {
        const e = diaEmissao(o);
        return e >= p.inicio && e <= p.fim && e <= limiteConv;
      });
    };
    const convAtual = conversao(orcAtual, periodo);
    const convAnt = conversao(orcAnt, anterior);
    kpis.push(
      montar(
        'CONVERSAO_7D_PCT',
        convAtual == null ? null : pct(convAtual.filter((o) => o.fechou).length, convAtual.length),
        convAnt == null ? null : pct(convAnt.filter((o) => o.fechou).length, convAnt.length),
        convAtual == null ? [] : linhasPct(agrupar(convAtual, (o) => o.rep_codigo, (o) => ({ num: o.fechou ? 1 : 0, den: 1 }))),
        {
          nota: convAtual == null ? semErp : 'Conta só orçamentos com os 7 dias já vencidos.',
          detalhe: convAtual == null ? null : { orcamentos: convAtual.length, fechados: convAtual.filter((o) => o.fechou).length },
        },
      ),
    );

    // 7 — motivos apontados: sem desfecho que entraram na lista no mês.
    const inicioApont = this.inicioApontamento;
    const semDesfechoDoMes = (orcs: typeof orcAtual, p: { inicio: string; fim: string }) => {
      if (orcs == null) return null;
      return orcs.filter((o) => {
        if (o.fechou) return false;
        const e = diaEmissao(o);
        if (inicioApont && e < inicioApont) return false;
        const entrada = somarDias(e, CARENCIA_DIAS);
        return entrada >= p.inicio && entrada <= p.fim && entrada <= hoje;
      });
    };
    const sdAtual = semDesfechoDoMes(orcAtual, periodo);
    const sdAnt = semDesfechoDoMes(orcAnt, anterior);
    const motivos = await this.repo.desfechosDosOrcamentos([...(sdAtual ?? []), ...(sdAnt ?? [])].map((o) => o.orcamento));
    const pctMotivo = (lista: NonNullable<typeof sdAtual> | null) =>
      lista == null ? null : pct(lista.filter((o) => motivos.has(o.orcamento)).length, lista.length);
    kpis.push(
      montar(
        'MOTIVOS_APONTADOS_PCT',
        pctMotivo(sdAtual),
        pctMotivo(sdAnt),
        sdAtual == null ? [] : linhasPct(agrupar(sdAtual, (o) => o.rep_codigo, (o) => ({ num: motivos.has(o.orcamento) ? 1 : 0, den: 1 }))),
        {
          nota: sdAtual == null ? semErp : null,
          detalhe: sdAtual == null ? null : { sem_desfecho: sdAtual.length, com_motivo: sdAtual.filter((o) => motivos.has(o.orcamento)).length },
        },
      ),
    );

    // 8 — resgates: SLA de 48h da curva A + recuperados/perdidos do mês.
    const avaliados = (l: typeof slaAtual) => l.filter((r) => r.sla_cumprido != null);
    const fimPeriodo = fimDia(periodo.fim);
    const fechadosMes = fechados.filter((f) => f.fechado_em && f.fechado_em <= fimPeriodo);
    kpis.push(
      montar(
        'RESGATE_SLA_PCT',
        pct(avaliados(slaAtual).filter((r) => r.sla_cumprido).length, avaliados(slaAtual).length),
        pct(avaliados(slaAnt).filter((r) => r.sla_cumprido).length, avaliados(slaAnt).length),
        linhasPct(agrupar(avaliados(slaAtual), (r) => r.rep_codigo, (r) => ({ num: r.sla_cumprido ? 1 : 0, den: 1 }))),
        {
          detalhe: {
            recuperados: fechadosMes.filter((f) => f.estagio === 'RECUPERADO').length,
            perdidos: fechadosMes.filter((f) => f.estagio === 'PERDIDO').length,
            avaliados: avaliados(slaAtual).length,
          },
        },
      ),
    );

    // 9 — fila no prazo.
    const noPrazo = (t: (typeof filaAtual)[number]) =>
      t.status === 'CONCLUIDA' && !!t.concluida_em && t.concluida_em <= t.prazo_em;
    kpis.push(
      montar(
        'FILA_NO_PRAZO_PCT',
        pct(filaAtual.filter(noPrazo).length, filaAtual.length),
        pct(filaAnt.filter(noPrazo).length, filaAnt.length),
        linhasPct(agrupar(filaAtual, (t) => t.rep_codigo, (t) => ({ num: noPrazo(t) ? 1 : 0, den: 1 }))),
        { detalhe: { tarefas: filaAtual.length, no_prazo: filaAtual.filter(noPrazo).length } },
      ),
    );

    return kpis;
  }
}
