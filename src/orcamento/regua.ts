/* =============================================================================
   RÉGUA DO ATACADO (plano de precificação v3) — motor puro, sem I/O.
   -----------------------------------------------------------------------------
   Tudo que a tela de orçamento precisa decidir SEM ir ao banco mora aqui, para
   ser testável linha a linha:

     custo de reposição  -> faixa (1A..3D)            faixaPorCusto()
     subgrupo/descrição  -> classe (GERAL | PB)       classeBase()
     classe × faixa      -> markup + desconto máximo  regraDe()
     item                -> preço mínimo, alçada      avaliarItem()
     mês do vendedor     -> bolsa de desconto         calcularBolsa()
     participação MIX1   -> degrau da comissão        degrauMix1()

   As faixas são as MESMAS do ETL do BI (FAIXA_MIX em Stage_Produtos/Stage_Vendas),
   recalculadas aqui sobre o custo AO VIVO do ERP: o BI só reflete a troca de
   custo no dia seguinte, e a Onda 0 (set/2026) trocou o custo de 121 itens.
   ============================================================================= */

export type ClasseRegua = 'GERAL' | 'PB';
export type ClasseItem = ClasseRegua | 'EXCLUSIVO' | 'OPORTUNIDADE';
export type Mix = 1 | 2 | 3;
export type FaixaChave =
  | '1A' | '1B' | '1C' | '1D'
  | '2A' | '2B' | '2C'
  | '3A' | '3B' | '3C' | '3D';

/**
 * Limite superior (inclusivo) do custo unitário de cada faixa — os MESMOS
 * cortes do ETL do BI (sp_Load_Stage_Produtos_FromDelta, colunas FAIXA_CUSTO /
 * MIX_CUSTO / FAIXA_MIX), copiados literalmente para a tela classificar igual
 * ao painel.
 */
export const FAIXAS: ReadonlyArray<{ chave: FaixaChave; mix: Mix; letra: string; ate: number }> = [
  { chave: '1A', mix: 1, letra: 'A', ate: 10.01 },
  { chave: '1B', mix: 1, letra: 'B', ate: 38.5 },
  { chave: '1C', mix: 1, letra: 'C', ate: 69.61 },
  { chave: '1D', mix: 1, letra: 'D', ate: 124.37 },
  { chave: '2A', mix: 2, letra: 'A', ate: 249.86 },
  { chave: '2B', mix: 2, letra: 'B', ate: 299.87 },
  { chave: '2C', mix: 2, letra: 'C', ate: 395.27 },
  { chave: '3A', mix: 3, letra: 'A', ate: 496.36 },
  { chave: '3B', mix: 3, letra: 'B', ate: 696.37 },
  { chave: '3C', mix: 3, letra: 'C', ate: 996.38 },
  { chave: '3D', mix: 3, letra: 'D', ate: Number.POSITIVE_INFINITY },
];

export function faixaPorCusto(custo: number | null | undefined) {
  if (custo == null || !(custo > 0)) return null;
  return FAIXAS.find((f) => custo <= f.ate) ?? FAIXAS[FAIXAS.length - 1];
}

export interface RegraFaixa {
  classe: ClasseRegua;
  faixa: FaixaChave;
  markup: number;
  desc_max: number;
}

/** Régua v3 aprovada em ago/2026 — a mesma do seed de ven_regua_atacado. */
export const REGUA_PADRAO: RegraFaixa[] = [
  { classe: 'GERAL', faixa: '1A', markup: 2.85, desc_max: 0.03 },
  { classe: 'GERAL', faixa: '1B', markup: 2.3, desc_max: 0.03 },
  { classe: 'GERAL', faixa: '1C', markup: 1.95, desc_max: 0.03 },
  { classe: 'GERAL', faixa: '1D', markup: 1.85, desc_max: 0.03 },
  { classe: 'GERAL', faixa: '2A', markup: 1.7, desc_max: 0.05 },
  { classe: 'GERAL', faixa: '2B', markup: 1.62, desc_max: 0.06 },
  { classe: 'GERAL', faixa: '2C', markup: 1.56, desc_max: 0.07 },
  { classe: 'GERAL', faixa: '3A', markup: 1.51, desc_max: 0.08 },
  { classe: 'GERAL', faixa: '3B', markup: 1.47, desc_max: 0.08 },
  { classe: 'GERAL', faixa: '3C', markup: 1.44, desc_max: 0.09 },
  { classe: 'GERAL', faixa: '3D', markup: 1.42, desc_max: 0.1 },
  { classe: 'PB', faixa: '1A', markup: 2.3, desc_max: 0.03 },
  { classe: 'PB', faixa: '1B', markup: 2.1, desc_max: 0.03 },
  { classe: 'PB', faixa: '1C', markup: 1.9, desc_max: 0.03 },
  { classe: 'PB', faixa: '1D', markup: 1.75, desc_max: 0.03 },
  { classe: 'PB', faixa: '2A', markup: 1.6, desc_max: 0.05 },
  { classe: 'PB', faixa: '2B', markup: 1.5, desc_max: 0.06 },
  { classe: 'PB', faixa: '2C', markup: 1.44, desc_max: 0.07 },
  { classe: 'PB', faixa: '3A', markup: 1.42, desc_max: 0.08 },
  { classe: 'PB', faixa: '3B', markup: 1.41, desc_max: 0.08 },
  { classe: 'PB', faixa: '3C', markup: 1.39, desc_max: 0.09 },
  { classe: 'PB', faixa: '3D', markup: 1.38, desc_max: 0.1 },
];

/** Subgrupo P/BRISA no ERP — a classe "comparável" da régua. */
export const SUBGRUPO_PARABRISA = 154;

export function classeBase(subgrpCodigo: number | null | undefined, descricao: string | null | undefined): ClasseRegua {
  if (Number(subgrpCodigo) === SUBGRUPO_PARABRISA) return 'PB';
  const d = (descricao ?? '').toUpperCase();
  // "P/BRISA", "PARABRISA", "PARA-BRISA" — o subgrupo é a regra; a descrição só socorre item mal classificado.
  if (/P\/BRISA|PARA-?BRISA/.test(d)) return 'PB';
  return 'GERAL';
}

/**
 * Regra da classe × faixa. Quando a combinação não existe (régua editada com
 * buraco), recua a letra da faixa dentro do mesmo mix — o mesmo fallback da
 * simulação (simula_regua.py, `_fx_valida`).
 */
export function regraDe(regua: RegraFaixa[], classe: ClasseRegua, faixa: FaixaChave): RegraFaixa | null {
  let fx: string = faixa;
  for (;;) {
    const r = regua.find((x) => x.classe === classe && x.faixa === fx);
    if (r) return r;
    const letra = fx[1];
    if (letra <= 'A') return null;
    fx = fx[0] + String.fromCharCode(letra.charCodeAt(0) - 1);
  }
}

/* ------------------------------------------------------------------ preço */

/** Coluna de preço do produto para a tabela do cliente ('2' -> PRECO2). */
export function colunaTabela(tabelaPreco: string | null | undefined): string {
  const n = parseInt(String(tabelaPreco ?? '').trim(), 10);
  return n >= 1 && n <= 10 ? `PRECO${n}` : 'PRECO_VENDA';
}

/**
 * Preço do item na tabela do cliente. Tabela zerada no cadastro (0,00) não é
 * preço zero: cai para PRECO2 (base oficial do atacado), depois PRECO5, depois
 * o preço de venda — e avisa (`fallback`) para a tela mostrar de onde veio.
 */
export function precoDaTabela(
  produto: Record<string, unknown>,
  tabelaPreco: string | null | undefined,
): { coluna: string; preco: number; fallback: boolean } {
  const col = colunaTabela(tabelaPreco);
  const cadeia = [col, 'PRECO2', 'PRECO5', 'PRECO_VENDA'];
  for (let i = 0; i < cadeia.length; i++) {
    const v = Number(produto[cadeia[i]]);
    if (v > 0) return { coluna: cadeia[i], preco: round2(v), fallback: i > 0 };
  }
  return { coluna: col, preco: 0, fallback: true };
}

/* --------------------------------------------------------------- avaliação */

export interface ExcecaoItem {
  classe: 'EXCLUSIVO' | 'OPORTUNIDADE';
  desc_max: number | null;
  motivo?: string | null;
}

export interface EntradaAvaliacao {
  custo: number | null;
  preco_tabela: number;
  subgrp_codigo: number | null;
  descricao: string | null;
  excecao?: ExcecaoItem | null;
  regua?: RegraFaixa[];
}

export interface Avaliacao {
  classe: ClasseItem;
  mix: Mix | null;
  faixa: FaixaChave | null;
  markup_regua: number | null;
  /** Preço de lista que a régua pediria (custo × markup). Nulo sem custo. */
  preco_alvo_regua: number | null;
  /** Desconto máximo da faixa (ou da exceção). */
  desc_max_pct: number;
  /** Desconto máximo que cabe SOBRE O PREÇO DE TABELA sem furar o piso da régua. */
  desc_max_efetivo_pct: number;
  preco_minimo: number;
  markup_tabela: number | null;
  /** Tabela do ERP já está abaixo do preço de lista da régua (item ainda não carregado). */
  tabela_abaixo_regua: boolean;
  motivo: string;
}

// 13,85 × 2,30 dá 31,854999… em ponto flutuante; sem a folga o meio-centavo cai para baixo.
export const round2 = (v: number) => Math.round(v * 100 + 1e-7) / 100;
const round4 = (v: number) => Math.round(v * 10000 + 1e-7) / 10000;

/**
 * Avalia um item: classe, faixa, desconto máximo e PREÇO MÍNIMO.
 *
 * Regra do mínimo (a que o vendedor decide sozinho):
 *   piso da régua  = custo × markup × (1 − desc_max)
 *   mínimo         = max(tabela × (1 − desc_max), piso da régua), nunca acima da
 *                    própria tabela e nunca abaixo do custo.
 * Se a tabela do ERP está abaixo da lista da régua (item que ainda não subiu),
 * o desconto permitido encolhe até zero — não se dá desconto sobre preço que já
 * está aquém. Exceção (exclusivo/oportunidade) congela o markup atual: o mínimo
 * é a tabela menos o desconto próprio, sem piso da régua.
 */
export function avaliarItem(e: EntradaAvaliacao): Avaliacao {
  const regua = e.regua ?? REGUA_PADRAO;
  const custo = e.custo != null && e.custo > 0 ? e.custo : null;
  const fx = faixaPorCusto(custo);
  const base = classeBase(e.subgrp_codigo, e.descricao);
  const regra = fx ? regraDe(regua, base, fx.chave) : null;
  const tabela = e.preco_tabela > 0 ? e.preco_tabela : 0;
  const markupTabela = custo && tabela > 0 ? round4(tabela / custo) : null;

  const semPrecoOuCusto = tabela <= 0 || !custo;

  if (e.excecao) {
    const descMax = e.excecao.desc_max ?? regra?.desc_max ?? 0.03;
    let minimo = round2(tabela * (1 - descMax));
    if (custo) minimo = Math.max(minimo, round2(custo));
    return {
      classe: e.excecao.classe,
      mix: fx?.mix ?? null,
      faixa: fx?.chave ?? null,
      markup_regua: null,
      preco_alvo_regua: null,
      desc_max_pct: descMax,
      desc_max_efetivo_pct: tabela > 0 ? round4(1 - minimo / tabela) : 0,
      preco_minimo: minimo,
      markup_tabela: markupTabela,
      tabela_abaixo_regua: false,
      motivo:
        e.excecao.classe === 'EXCLUSIVO'
          ? 'Lançamento/exclusivo: markup atual congelado, desconto próprio.'
          : 'Compra de oportunidade: preço de mercado, desconto próprio.',
    };
  }

  if (semPrecoOuCusto || !regra || !fx) {
    // Sem custo não há faixa; sem tabela não há preço. Nada de desconto automático.
    const minimo = tabela > 0 ? tabela : 0;
    return {
      classe: base,
      mix: fx?.mix ?? null,
      faixa: fx?.chave ?? null,
      markup_regua: regra?.markup ?? null,
      preco_alvo_regua: custo && regra ? round2(custo * regra.markup) : null,
      desc_max_pct: 0,
      desc_max_efetivo_pct: 0,
      preco_minimo: minimo,
      markup_tabela: markupTabela,
      tabela_abaixo_regua: false,
      motivo: !custo
        ? 'Sem custo de reposição no cadastro — item sem faixa; desconto exige aprovação.'
        : tabela <= 0
          ? 'Sem preço na tabela do cliente — informe o preço manualmente.'
          : 'Faixa sem regra na régua.',
    };
  }

  const alvo = round2(custo * regra.markup);
  const pisoRegua = round2(custo * regra.markup * (1 - regra.desc_max));
  let minimo = Math.max(round2(tabela * (1 - regra.desc_max)), pisoRegua);
  minimo = Math.min(minimo, tabela);
  minimo = Math.max(minimo, round2(custo));
  const abaixo = tabela < alvo - 0.005;
  const descEfetivo = round4(Math.max(0, 1 - minimo / tabela));

  return {
    classe: base,
    mix: fx.mix,
    faixa: fx.chave,
    markup_regua: regra.markup,
    preco_alvo_regua: alvo,
    desc_max_pct: regra.desc_max,
    desc_max_efetivo_pct: descEfetivo,
    preco_minimo: minimo,
    markup_tabela: markupTabela,
    tabela_abaixo_regua: abaixo,
    motivo: abaixo
      ? descEfetivo <= 0
        ? 'Tabela já abaixo da lista da régua — sem margem para desconto.'
        : 'Tabela abaixo da lista da régua — desconto reduzido ao piso.'
      : `Faixa ${fx.chave} ${base}: até ${(regra.desc_max * 100).toFixed(0)}% de desconto.`,
  };
}

/* -------------------------------------------------------------------- bolsa */

export type Semaforo = 'VERDE' | 'AMARELO' | 'VERMELHO';

export interface BolsaEntrada {
  /** Venda BRUTA do mês comissional (antes do desconto). */
  bruto_mtd: number;
  /** Desconto já concedido no mês (positivo). */
  desconto_mtd: number;
  /** O orçamento em edição, para projetar. */
  bruto_orc?: number;
  desconto_orc?: number;
  /** Limiares da disciplina de desconto (comissão): bônus ≤ 3%, pena > 6%. */
  bonus_pct?: number;
  pena_pct?: number;
}

export interface Bolsa {
  bonus_pct: number;
  pena_pct: number;
  bruto_mtd: number;
  desconto_mtd: number;
  pct_atual: number;
  /** Quanto ainda pode dar de desconto no mês e continuar dentro do bônus (pode ser negativo). */
  saldo_bonus: number;
  /** Idem, antes de cair na pena. */
  saldo_teto: number;
  pct_apos: number;
  semaforo_atual: Semaforo;
  semaforo_apos: Semaforo;
}

export function semaforoDe(pct: number, bonus: number, pena: number): Semaforo {
  if (pct <= bonus + 1e-9) return 'VERDE';
  if (pct <= pena + 1e-9) return 'AMARELO';
  return 'VERMELHO';
}

export function calcularBolsa(e: BolsaEntrada): Bolsa {
  const bonus = e.bonus_pct ?? 0.03;
  const pena = e.pena_pct ?? 0.06;
  const bruto = Math.max(0, e.bruto_mtd);
  const desc = Math.max(0, e.desconto_mtd);
  const brutoOrc = Math.max(0, e.bruto_orc ?? 0);
  const descOrc = Math.max(0, e.desconto_orc ?? 0);
  const pct = bruto > 0 ? desc / bruto : 0;
  const totalBruto = bruto + brutoOrc;
  const pctApos = totalBruto > 0 ? (desc + descOrc) / totalBruto : 0;
  return {
    bonus_pct: bonus,
    pena_pct: pena,
    bruto_mtd: round2(bruto),
    desconto_mtd: round2(desc),
    pct_atual: round4(pct),
    saldo_bonus: round2(bonus * bruto - desc),
    saldo_teto: round2(pena * bruto - desc),
    pct_apos: round4(pctApos),
    semaforo_atual: semaforoDe(pct, bonus, pena),
    semaforo_apos: semaforoDe(pctApos, bonus, pena),
  };
}

/* --------------------------------------------------------------- MIX1/escada */

export const DEGRAUS_MIX1 = [
  { degrau: 1, minimo: 0.22, multiplicador: 1.25 },
  { degrau: 2, minimo: 0.26, multiplicador: 1.5 },
  { degrau: 3, minimo: 0.3, multiplicador: 2.0 },
] as const;

export function degrauMix1(participacao: number) {
  const atual = [...DEGRAUS_MIX1].reverse().find((d) => participacao >= d.minimo - 1e-9) ?? null;
  const proximo = DEGRAUS_MIX1.find((d) => participacao < d.minimo - 1e-9) ?? null;
  return {
    participacao: round4(participacao),
    degrau: atual?.degrau ?? 0,
    multiplicador: atual?.multiplicador ?? 1,
    proximo_minimo: proximo?.minimo ?? null,
    falta_pp: proximo ? round4(proximo.minimo - participacao) : 0,
  };
}
