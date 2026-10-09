/**
 * Catálogo dos indicadores da tela do supervisor do atacado e a régua do
 * semáforo. Funções puras — o SupervisaoService só mede; quem decide a cor é
 * daqui, e a mesma regra vale na tela do supervisor e no bloco do vendedor.
 *
 * KPI = os 9 indicadores do departamento (o supervisor é cobrado por eles).
 * ESFORCO = os 4 critérios de esforço mínimo do vendedor (sinal observado).
 * A meta de cada um é da gerência, com vigência (tabela ven_atacado_meta);
 * `padrao` só vale enquanto não houver linha gravada.
 */

export type Unidade = 'qtd' | 'brl' | 'pct';
export type Sentido = 'MAIOR' | 'MENOR';
export type Cor = 'verde' | 'amarelo' | 'vermelho';

export interface DefIndicador {
  chave: string;
  grupo: 'KPI' | 'ESFORCO';
  nome: string;
  descricao: string;
  unidade: Unidade;
  sentido: Sentido;
  padrao: number;
  /** Medido como posição de hoje (não existe para mês fechado). */
  posicao?: boolean;
}

export const INDICADORES: DefIndicador[] = [
  {
    chave: 'CLIENTES_ATIVOS_MES',
    grupo: 'KPI',
    nome: 'Clientes ativos no mês',
    descricao: 'Clientes do atacado (tabelas 2 e 5) com compra no mês comissional.',
    unidade: 'qtd',
    sentido: 'MAIOR',
    padrao: 290,
  },
  {
    chave: 'RECEITA_MES',
    grupo: 'KPI',
    nome: 'Receita do atacado no mês',
    descricao: 'Vendas menos devoluções dos clientes do atacado no mês comissional.',
    unidade: 'brl',
    sentido: 'MAIOR',
    padrao: 550_000,
  },
  {
    chave: 'VAZAMENTO_TRIMESTRE',
    grupo: 'KPI',
    nome: 'Vazamento do trimestre',
    descricao: 'Quanto os clientes em queda de 30% ou mais deixaram de comprar: últimos 3 meses contra os 3 anteriores.',
    unidade: 'brl',
    sentido: 'MENOR',
    padrao: 155_000,
    posicao: true,
  },
  {
    chave: 'PERDA_SILENCIOSA',
    grupo: 'KPI',
    nome: 'Perda silenciosa',
    descricao: 'Clientes sem compra e sem orçamento nos últimos 90 dias: ninguém está tentando.',
    unidade: 'qtd',
    sentido: 'MENOR',
    padrao: 400,
    posicao: true,
  },
  {
    chave: 'COMPRADORES_TRIMESTRE_PCT',
    grupo: 'KPI',
    nome: 'Compradores no trimestre',
    descricao: '% da base do atacado que comprou nos últimos 3 meses.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 40,
    posicao: true,
  },
  {
    chave: 'CONVERSAO_7D_PCT',
    grupo: 'KPI',
    nome: 'Conversão de orçamento em 7 dias',
    descricao: '% dos orçamentos do mês com venda do cliente em até 7 dias da emissão.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 65,
  },
  {
    chave: 'MOTIVOS_APONTADOS_PCT',
    grupo: 'KPI',
    nome: 'Motivos apontados',
    descricao: '% dos orçamentos sem desfecho do mês com o motivo de não fechamento apontado.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 80,
  },
  {
    chave: 'RESGATE_SLA_PCT',
    grupo: 'KPI',
    nome: 'Resgates no prazo',
    descricao: '% dos resgates de curva A abertos no mês com primeiro contato em até 48h.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 90,
  },
  {
    chave: 'FILA_NO_PRAZO_PCT',
    grupo: 'KPI',
    nome: 'Fila no prazo',
    descricao: '% das tarefas da fila que fecharam por sinal (orçamento, mensagem ou venda) antes do prazo.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 80,
  },
  {
    chave: 'ESF_CURVA_A_FORA_REGUA',
    grupo: 'ESFORCO',
    nome: 'Curva A fora da régua',
    descricao: 'Clientes curva A da carteira há mais de 15 dias sem compra, orçamento nem mensagem.',
    unidade: 'qtd',
    sentido: 'MENOR',
    padrao: 0,
    posicao: true,
  },
  {
    chave: 'ESF_FILA_NO_PRAZO_PCT',
    grupo: 'ESFORCO',
    nome: 'Fila no prazo',
    descricao: '% das tarefas da semana fechadas por sinal antes do prazo.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 80,
  },
  {
    chave: 'ESF_MOTIVO_3DU_PCT',
    grupo: 'ESFORCO',
    nome: 'Motivo em 3 dias úteis',
    descricao: '% dos orçamentos sem desfecho com motivo apontado em até 3 dias úteis depois de entrarem na lista.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 80,
  },
  {
    chave: 'ESF_RESGATE_A_48H_PCT',
    grupo: 'ESFORCO',
    nome: 'Resgate curva A em 48h',
    descricao: '% dos resgates de curva A da semana com primeiro contato em até 48h.',
    unidade: 'pct',
    sentido: 'MAIOR',
    padrao: 100,
  },
];

export const INDICADOR = new Map(INDICADORES.map((i) => [i.chave, i]));

export interface MetaLinha {
  indicador: string;
  valor: number;
  faixa_amarela: number;
  vigente_desde: string; // yyyy-mm-dd
  created_at?: Date | string;
}

/** A meta que vale numa data: maior `vigente_desde` <= data; empate, a gravada por último. */
export function metaVigente(
  linhas: MetaLinha[],
  indicador: string,
  dataYmd: string,
): { valor: number; faixa_amarela: number; vigente_desde: string | null } {
  const def = INDICADOR.get(indicador);
  const candidatas = linhas
    .filter((l) => l.indicador === indicador && l.vigente_desde <= dataYmd)
    .sort(
      (a, b) =>
        b.vigente_desde.localeCompare(a.vigente_desde) ||
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    );
  const m = candidatas[0];
  if (m) return { valor: Number(m.valor), faixa_amarela: Number(m.faixa_amarela), vigente_desde: m.vigente_desde };
  return { valor: def?.padrao ?? 0, faixa_amarela: 10, vigente_desde: null };
}

/**
 * 🟢 atingiu a meta · 🟡 até `faixa` abaixo (pontos em %, % da meta nos demais)
 * · 🔴 além disso. Valor nulo (sem base para medir) não tem cor.
 */
export function semaforo(valor: number | null, meta: number, faixa: number, unidade: Unidade, sentido: Sentido): Cor | null {
  if (valor == null || !Number.isFinite(valor)) return null;
  const folga = unidade === 'pct' ? faixa : Math.abs(meta) * (faixa / 100);
  if (sentido === 'MAIOR') {
    if (valor >= meta) return 'verde';
    return valor >= meta - folga ? 'amarelo' : 'vermelho';
  }
  if (valor <= meta) return 'verde';
  return valor <= meta + folga ? 'amarelo' : 'vermelho';
}

/** A pior cor manda (o geral do vendedor no esforço). Sem nenhuma cor, nulo. */
export function piorCor(cores: Array<Cor | null>): Cor | null {
  if (cores.includes('vermelho')) return 'vermelho';
  if (cores.includes('amarelo')) return 'amarelo';
  return cores.includes('verde') ? 'verde' : null;
}

/** Percentual com 1 casa; sem denominador, nulo (não "0%"). */
export function pct(num: number, den: number): number | null {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : null;
}

/**
 * Datas do negócio em America/Cuiaba (UTC−4, sem horário de verão), como
 * strings aaaa-mm-dd — independentes do TZ do servidor (o container roda em UTC).
 */
const FUSO = '-04:00';
export const hojeYmd = (agora = new Date()): string => new Date(agora.getTime() - 4 * 3_600_000).toISOString().slice(0, 10);
export const inicioDia = (ymd: string): Date => new Date(`${ymd}T00:00:00${FUSO}`);
export const fimDia = (ymd: string): Date => new Date(`${ymd}T23:59:59.999${FUSO}`);
/** Soma (ou subtrai, com n negativo) dias corridos a uma data aaaa-mm-dd. */
export const somarDias = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** 0 = domingo … 6 = sábado. */
export const diaDaSemana = (ymd: string): number => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Soma `n` dias úteis (seg–sex) a uma data aaaa-mm-dd. */
export function somarDiasUteis(ymd: string, n: number): string {
  let r = ymd;
  let falta = n;
  while (falta > 0) {
    r = somarDias(r, 1);
    const dia = diaDaSemana(r);
    if (dia !== 0 && dia !== 6) falta--;
  }
  return r;
}

/** Mês comissional (26 → 25) de uma data aaaa-mm-dd: o mês em que cai o dia 25. */
export function mesComissionalDe(ymd: string): { ano: number; mes: number } {
  let [ano, mes] = ymd.split('-').map(Number);
  const dia = Number(ymd.slice(8, 10));
  if (dia >= 26) {
    mes += 1;
    if (mes === 13) {
      mes = 1;
      ano += 1;
    }
  }
  return { ano, mes };
}

/** Início e fim (aaaa-mm-dd) de um mês comissional. */
export function periodoComissional(ano: number, mes: number): { ano: number; mes: number; inicio: string; fim: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  const anoIni = mes === 1 ? ano - 1 : ano;
  const mesIni = mes === 1 ? 12 : mes - 1;
  return { ano, mes, inicio: `${anoIni}-${p(mesIni)}-26`, fim: `${ano}-${p(mes)}-25` };
}
