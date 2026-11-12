/**
 * Regras da tela de gestão do atacado (/vendas/atacado): ritmo do mês,
 * previsão, veredito, piso de venda, nível e valor do prêmio do supervisor.
 * Funções puras — o GestaoService só mede; a conta e o corte ficam aqui.
 *
 * Dias úteis vêm de `d_calendario.is_dia_util` do BI (datas aaaa-mm-dd).
 */
import { Cor, pct, piorCor, semaforo } from './supervisao.indicadores';

export type Veredito = 'VAI_BATER' | 'EM_RISCO' | 'NAO_BATE' | 'ABAIXO_DO_PISO';
export type Nivel = 0 | 1 | 2 | 3;

/** Pesos do prêmio (somam 100). */
export const PESOS = {
  CLIENTES_ATIVOS_MES: 30,
  RECUPERACAO_AB_PCT: 30,
  CURVA_A_COMPRANDO_PCT: 15,
  DISCIPLINA: 25,
} as const;

export interface Dias {
  total: number;
  /** Dias úteis antes de hoje (o dia corrente não conta). */
  fechados: number;
  /** Dias úteis depois de hoje. */
  restantes: number;
  /** N de "dia útil N de T"; nulo fora do mês corrente. */
  dia_util_corrente: number | null;
  corrente: boolean;
}

export function contarDias(diasUteis: string[], inicio: string, fim: string, hoje: string): Dias {
  const uteis = diasUteis.filter((d) => d >= inicio && d <= fim);
  const total = uteis.length;
  if (hoje > fim) return { total, fechados: total, restantes: 0, dia_util_corrente: null, corrente: false };
  if (hoje < inicio) return { total, fechados: 0, restantes: total, dia_util_corrente: null, corrente: false };
  const fechados = uteis.filter((d) => d < hoje).length;
  const hojeUtil = uteis.includes(hoje);
  return {
    total,
    fechados,
    restantes: total - fechados - (hojeUtil ? 1 : 0),
    dia_util_corrente: Math.min(fechados + 1, total),
    corrente: true,
  };
}

/**
 * Ritmo = faturado até ontem ÷ dias úteis fechados; previsão = ritmo × total.
 * Sem dia fechado (primeiro dia útil) não há base. Mês encerrado: previsão = faturado.
 */
export function ritmoPrevisao(p: { faturado: number; faturado_hoje: number; dias: Dias; encerrado: boolean }): {
  ritmo: number | null;
  previsao: number | null;
} {
  const { faturado, faturado_hoje, dias, encerrado } = p;
  if (encerrado) return { ritmo: dias.total > 0 ? faturado / dias.total : null, previsao: faturado };
  if (dias.fechados <= 0) return { ritmo: null, previsao: null };
  const ritmo = (faturado - faturado_hoje) / dias.fechados;
  return { ritmo, previsao: ritmo * dias.total };
}

/** Quanto falta vender por dia útil restante para chegar no alvo. Sem dia restante, nulo. */
export function ritmoNecessario(alvo: number | null, faturado: number, restantes: number): number | null {
  if (alvo == null || restantes <= 0) return null;
  return Math.max(0, alvo - faturado) / restantes;
}

/** Previsão ÷ meta: ≥ 100% vai bater; 90% a 99,9% em risco; < 90% não bate. Abaixo do piso manda. */
export function veredito(previsao: number | null, meta: number, piso?: number | null): Veredito | null {
  if (previsao == null) return null;
  if (piso != null && previsao < piso) return 'ABAIXO_DO_PISO';
  const ating = pct(previsao, meta);
  if (ating == null) return null;
  if (ating >= 100) return 'VAI_BATER';
  return ating >= 90 ? 'EM_RISCO' : 'NAO_BATE';
}

/** Parte da venda que sobra depois do custo da mercadoria e da despesa variável. */
const fracaoMargem = (markup: number | null, fator: number, despesa: number): number | null =>
  markup != null && markup > 0 && Number.isFinite(markup) ? fator * (1 - 1 / markup - despesa) : null;

/** Margem do mês = venda × fator × (1 − 1/markup − despesa variável). Sem markup, nulo. */
export function margemMes(venda: number, markup: number | null, fator: number, despesa: number): number | null {
  const f = fracaoMargem(markup, fator, despesa);
  return f == null ? null : venda * f;
}

/** Venda em que a margem cobre o custo do departamento (nível 1). Sem markup calculável, nulo. */
export function pisoVenda(custoDepto: number, markup: number | null, fator: number, despesa: number): number | null {
  const f = fracaoMargem(markup, fator, despesa);
  return f == null || f <= 0 ? null : custoDepto / f;
}

/**
 * N1: margem ≥ custo do departamento; N2: N1 e venda ≥ meta; N3: N1 e venda ≥ 115% da meta.
 * Sem meta cadastrada no mês (meta ≤ 0) não há base: nível 0.
 */
export function nivel(p: { venda: number; margem: number | null; custoDepto: number; meta: number }): Nivel {
  if (p.meta <= 0 || p.margem == null || p.margem < p.custoDepto) return 0;
  if (p.venda >= p.meta * 1.15) return 3;
  return p.venda >= p.meta ? 2 : 1;
}

/** Verde = peso cheio; amarelo = metade; vermelho ou sem cor = zero. */
export function pontosIndicador(cor: Cor | null, peso: number): number {
  if (cor === 'verde') return peso;
  return cor === 'amarelo' ? peso / 2 : 0;
}

/** Pontos percentuais somados ao resgate na disciplina quando a fila de contatos bate a meta. */
export const BONUS_CONTATOS_PP = 10;

/**
 * Disciplina da equipe = média do atingimento do SLA de resgate e dos motivos
 * apontados. Verde: os dois batem; amarelo: os dois até 10 p.p. abaixo; resto vermelho.
 *
 * Bônus dos contatos (decisão de 12/11/2026): quando a fila de contatos fecha no
 * prazo na meta (`fila` ≥ `metaFila`), o resgate ganha BONUS_CONTATOS_PP pontos
 * percentuais SÓ aqui na disciplina (teto 100) — reconhece a equipe que está
 * tentando. O indicador "Resgates no prazo" em si continua com a regra das 48h.
 */
export function disciplina(p: {
  sla: number | null;
  metaSla: number;
  motivos: number | null;
  metaMotivos: number;
  fila?: number | null;
  metaFila?: number;
}): {
  valor: number | null;
  cor: Cor | null;
  bonus: number;
} {
  const bonus = p.fila != null && !!p.metaFila && p.fila >= p.metaFila ? BONUS_CONTATOS_PP : 0;
  if (p.sla == null || p.motivos == null) return { valor: null, cor: null, bonus };
  const sla = Math.min(100, p.sla + bonus);
  const a = pct(sla, p.metaSla);
  const b = pct(p.motivos, p.metaMotivos);
  const valor = a == null || b == null ? null : Math.round(((a + b) / 2) * 10) / 10;
  const cor = piorCor([
    semaforo(sla, p.metaSla, 10, 'pct', 'MAIOR'),
    semaforo(p.motivos, p.metaMotivos, 10, 'pct', 'MAIOR'),
  ]);
  return { valor, cor, bonus };
}

/** Valor do nível × pontos ÷ 100; bolsa do canal negativa zera. Sem proporcional entre níveis. */
export function premio(p: {
  nivel: Nivel;
  pontos: number;
  valores: { n1: number; n2: number; n3: number };
  travaBolsa: boolean;
}): number {
  if (p.travaBolsa || p.nivel === 0) return 0;
  const valor = p.valores[`n${p.nivel}` as 'n1' | 'n2' | 'n3'];
  return Math.round(valor * p.pontos) / 100;
}

/**
 * Acumulado por dia útil até hoje. Venda de dia não útil soma no dia útil
 * seguinte; o último ponto leva tudo o que foi vendido até hoje.
 */
export function serieAcumulada(
  porDia: Array<{ dia: string; valor: number }>,
  diasUteis: string[],
  hoje: string,
): Array<{ dia: string; acumulado: number }> {
  const ate = (d: string) => porDia.reduce((s, x) => (x.dia <= d ? s + Number(x.valor) : s), 0);
  const uteis = diasUteis.filter((d) => d <= hoje).sort();
  return uteis.map((dia, i) => ({ dia, acumulado: ate(i === uteis.length - 1 ? hoje : dia) }));
}

export interface OrcamentoFechado {
  id: string;
  rep_codigo: number;
  total: number;
}
export interface NotaAtacado {
  chave: string;
  empresa: number;
  serie: string;
  nfs: number;
  emissao_ymd: string;
  /** Valor da parte da nota casada com o orçamento (devolução negativa). */
  valor: number;
  /** Código em que a nota saiu (vendedor_venda). */
  rep_codigo: number;
}
export interface Casado {
  orcamento: OrcamentoFechado;
  /** Vazio = orçamento ainda sem nota. */
  notas: NotaAtacado[];
}

/** Linha de NF do casamento do extrato da bolsa (`casarOrcamentos` em orcamento/extrato-bolsa.ts). */
export interface LinhaCasamento {
  empresa: number;
  serie: string;
  nfs: number;
  emissao: Date;
  rep_codigo: number;
  quantidade: number;
  liquido: number;
  devolucao: boolean;
}

/**
 * Notas de um orçamento pelo mesmo casamento do extrato da bolsa (NF gravada no
 * orçamento do Celta, NF do condicional, senão a janela do cliente): as unidades
 * casadas viram valor pela proporção do líquido da linha, somadas por nota.
 */
export function notasDoOrcamento(casadas: Array<{ linha: number; quantidade: number }>, linhas: LinhaCasamento[]): NotaAtacado[] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const porNf = new Map<string, NotaAtacado>();
  for (const c of casadas) {
    const l = linhas[c.linha];
    if (!l || !(l.quantidade > 0)) continue;
    const chave = `${l.empresa}-${l.serie}-${l.nfs}`;
    // emissão é meia-noite local da data do BI: os componentes locais devolvem a data.
    const emissao_ymd = `${l.emissao.getFullYear()}-${pad(l.emissao.getMonth() + 1)}-${pad(l.emissao.getDate())}`;
    const n = porNf.get(chave) ?? { chave, empresa: l.empresa, serie: l.serie, nfs: l.nfs, emissao_ymd, valor: 0, rep_codigo: l.rep_codigo };
    n.valor += ((l.devolucao ? -1 : 1) * Number(l.liquido) * c.quantidade) / l.quantidade;
    porNf.set(chave, n);
  }
  return [...porNf.values()].map((n) => ({ ...n, valor: Math.round(n.valor * 100) / 100 })).sort((a, b) => b.valor - a.valor);
}

export interface ResumoAuxiliar {
  rep_codigo: number;
  orcamentos_fechados: number;
  vendeu: number;
  por_vendedor: Array<{ rep_codigo: number; valor: number }>;
  sem_nota: { valor: number; quantidade: number };
}

/** Por auxiliar (rep do orçamento): fechados, valor das notas casadas por código de saída e o que ainda não virou nota. */
export function resumirAuxiliares(casados: Casado[]): {
  auxiliares: ResumoAuxiliar[];
  /** Parte do faturado de cada vendedor que nasceu de orçamento de auxiliar. */
  veio_dos_auxiliares: Array<{ rep_codigo: number; valor: number }>;
} {
  const aux = new Map<number, ResumoAuxiliar & { _pv: Map<number, number> }>();
  const veio = new Map<number, number>();
  for (const { orcamento: o, notas } of casados) {
    let a = aux.get(o.rep_codigo);
    if (!a) {
      a = { rep_codigo: o.rep_codigo, orcamentos_fechados: 0, vendeu: 0, por_vendedor: [], sem_nota: { valor: 0, quantidade: 0 }, _pv: new Map() };
      aux.set(o.rep_codigo, a);
    }
    a.orcamentos_fechados++;
    if (!notas.length) {
      a.sem_nota.valor += Number(o.total);
      a.sem_nota.quantidade++;
      continue;
    }
    for (const nota of notas) {
      a.vendeu += Number(nota.valor);
      a._pv.set(nota.rep_codigo, (a._pv.get(nota.rep_codigo) ?? 0) + Number(nota.valor));
      veio.set(nota.rep_codigo, (veio.get(nota.rep_codigo) ?? 0) + Number(nota.valor));
    }
  }
  const lista = (m: Map<number, number>) => [...m].map(([rep_codigo, valor]) => ({ rep_codigo, valor })).sort((x, y) => y.valor - x.valor);
  return {
    auxiliares: [...aux.values()].map(({ _pv, ...a }) => ({ ...a, por_vendedor: lista(_pv) })),
    veio_dos_auxiliares: lista(veio),
  };
}

/** Orçamento com motivo de perda apontado, do editor (intranet) ou da fila "Sem desfecho". */
export interface OrcamentoPerdido {
  /** Nº do orçamento na origem (intranet ou Celta). */
  numero: number;
  origem: 'INTRANET' | 'CELTA';
  cli_codigo: number;
  cli_nome: string | null;
  rep_codigo: number | null;
  rep_nome: string | null;
  total: number;
  motivo: string;
}

/** Placar dos motivos de perda de um mês: quantidade, valor e a parte de cada motivo no valor perdido. */
export function resumirMotivosPerda(orcamentos: Array<Pick<OrcamentoPerdido, 'motivo' | 'total'>>) {
  const por = new Map<string, { quantidade: number; valor: number }>();
  for (const o of orcamentos) {
    const m = por.get(o.motivo) ?? { quantidade: 0, valor: 0 };
    m.quantidade++;
    m.valor += o.total;
    por.set(o.motivo, m);
  }
  const valor = orcamentos.reduce((s, o) => s + o.total, 0);
  return {
    quantidade: orcamentos.length,
    valor,
    motivos: [...por]
      .map(([motivo, m]) => ({ motivo, ...m, pct: pct(m.valor, valor) }))
      .sort((a, b) => b.valor - a.valor),
  };
}
