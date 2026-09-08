/* =============================================================================
   RÉGUA DO ATACADO (plano de precificação v3) — motor puro, sem I/O.
   -----------------------------------------------------------------------------
   Tudo que a tela de orçamento precisa decidir SEM ir ao banco mora aqui, para
   ser testável linha a linha:

     custo de reposição  -> faixa (1A..3D)            faixaPorCusto()
     subgrupo/descrição  -> classe (GERAL | PB)       classeBase()
     classe × faixa      -> markup + desconto máximo  regraDe()
     item                -> preço mínimo, alçada      avaliarItem()
     mês do vendedor     -> bolsa de desconto         calcularBolsa()  (receita − custo × piso)
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

/**
 * Escala por VOLUME (quantidade na linha): o desconto máximo da FAIXA é o teto e
 * nunca cresce; o volume é o que LIBERA esse teto. Com pouca quantidade o
 * vendedor tem só uma fração do máximo da faixa; a partir de `qtd_min` unidades
 * a fração sobe, até 100% do máximo. Ex.: faixa 1D (3%) → 1,5% até 2 un,
 * 2,25% de 3 a 5 un, 3% a partir de 6 un.
 */
export interface FaixaVolume {
  qtd_min: number;
  /** fração do desconto máximo da faixa liberada a partir de qtd_min (1 = o máximo inteiro). */
  fracao: number;
}

/** Escala padrão — a mesma do seed de ven_regua_volume. */
export const VOLUME_PADRAO: FaixaVolume[] = [
  { qtd_min: 1, fracao: 0.5 },
  { qtd_min: 3, fracao: 0.75 },
  { qtd_min: 6, fracao: 1 },
];

/** Fração do máximo liberada para a quantidade (nunca acima de 1). */
export function fracaoPorVolume(volume: FaixaVolume[], quantidade: number): number {
  const validas = volume.filter((v) => quantidade >= v.qtd_min);
  if (!validas.length) return Math.min(1, volume[0]?.fracao ?? 1);
  return Math.min(1, validas.reduce((m, v) => Math.max(m, v.fracao), 0));
}

export interface DegrauVolume {
  qtd_min: number;
  desc_max_pct: number;
  desc_max_efetivo_pct: number;
  preco_minimo: number;
}

export interface EntradaAvaliacao {
  custo: number | null;
  preco_tabela: number;
  subgrp_codigo: number | null;
  descricao: string | null;
  excecao?: ExcecaoItem | null;
  regua?: RegraFaixa[];
  /** Escala por volume; ausente = VOLUME_PADRAO. */
  volume?: FaixaVolume[];
  /** Quantidade da linha — define o degrau de volume aplicado. Padrão 1. */
  quantidade?: number;
  /** Markup do piso absoluto de um item pago pela bolsa (custo × piso). Padrão PISO_ITEM_PADRAO. */
  piso_item?: number;
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
  /** Abaixo do mínimo da faixa a bolsa paga; abaixo DESTE piso (custo × 1,25) só com aprovação. */
  preco_piso_bolsa: number;
  markup_tabela: number | null;
  /** Tabela do ERP já está abaixo do preço de lista da régua (item ainda não carregado). */
  tabela_abaixo_regua: boolean;
  motivo: string;
  /** Fração do máximo da faixa liberada pela quantidade (1 = máximo inteiro). */
  fracao_volume: number;
  /** A escala inteira (qtd 1 + cada degrau), já com desc. máx e preço mínimo — a tela escolhe pela quantidade. */
  escala_volume: DegrauVolume[];
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
  const volume = e.volume ?? VOLUME_PADRAO;
  const qtd = e.quantidade != null && e.quantidade > 0 ? e.quantidade : 1;
  const fracao = fracaoPorVolume(volume, qtd);
  const base = avaliarBase(e, fracao);
  const degraus = [1, ...volume.map((v) => v.qtd_min)]
    .filter((q, i, a) => a.indexOf(q) === i)
    .sort((a, b) => a - b);
  const escala: DegrauVolume[] = degraus.map((q) => {
    const a = avaliarBase(e, fracaoPorVolume(volume, q));
    return { qtd_min: q, desc_max_pct: a.desc_max_pct, desc_max_efetivo_pct: a.desc_max_efetivo_pct, preco_minimo: a.preco_minimo };
  });
  return { ...base, fracao_volume: fracao, escala_volume: escala };
}

type AvaliacaoBase = Omit<Avaliacao, 'fracao_volume' | 'escala_volume'>;

function avaliarBase(e: EntradaAvaliacao, fracao: number): AvaliacaoBase {
  const regua = e.regua ?? REGUA_PADRAO;
  const custo = e.custo != null && e.custo > 0 ? e.custo : null;
  const fx = faixaPorCusto(custo);
  const base = classeBase(e.subgrp_codigo, e.descricao);
  const regra = fx ? regraDe(regua, base, fx.chave) : null;
  const tabela = e.preco_tabela > 0 ? e.preco_tabela : 0;
  const markupTabela = custo && tabela > 0 ? round4(tabela / custo) : null;
  const pisoBolsa = custo ? Math.min(round2(custo * (e.piso_item ?? PISO_ITEM_PADRAO)), tabela > 0 ? tabela : Number.POSITIVE_INFINITY) : 0;

  const semPrecoOuCusto = tabela <= 0 || !custo;

  if (e.excecao) {
    const descMax = round4((e.excecao.desc_max ?? regra?.desc_max ?? 0.03) * fracao);
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
      preco_piso_bolsa: pisoBolsa,
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
      preco_piso_bolsa: pisoBolsa,
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
  // O piso da régua é sempre o da FAIXA (desc. máx cheio); a quantidade só
  // decide quanto desse máximo o vendedor pode dar sozinho.
  const descMax = round4(regra.desc_max * fracao);
  const pisoRegua = round2(custo * regra.markup * (1 - regra.desc_max));
  let minimo = Math.max(round2(tabela * (1 - descMax)), pisoRegua);
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
    desc_max_pct: descMax,
    desc_max_efetivo_pct: descEfetivo,
    preco_minimo: minimo,
    preco_piso_bolsa: pisoBolsa,
    markup_tabela: markupTabela,
    tabela_abaixo_regua: abaixo,
    motivo: abaixo
      ? descEfetivo <= 0
        ? 'Tabela já abaixo da lista da régua — sem margem para desconto.'
        : 'Tabela abaixo da lista da régua — desconto reduzido ao piso.'
      : `Faixa ${fx.chave} ${base}: até ${(descMax * 100).toFixed(1)}% de desconto${fracao < 1 ? ` (${(regra.desc_max * 100).toFixed(0)}% com volume)` : ''}.`,
  };
}

/* -------------------------------------------------------------------- bolsa */

export type Semaforo = 'VERDE' | 'AMARELO' | 'VERMELHO';

/**
 * A bolsa de desconto é a margem que o vendedor gera ACIMA de um markup-piso:
 *   bolsa = Σ (preço vendido − custo × piso)        no mês comissional
 * Toda venda a preço cheio soma; todo desconto subtrai (dentro ou fora do teto
 * da faixa — o teto só define a alçada). O piso é o markup do degrau da escada
 * da meta em vigor (T1: R$ 645 mil/mês → 1,48). A "linha dos 4%" é o markup
 * que deixa o canal em 4% no volume REAL do trimestre; só acima dela há lucro
 * extra, e é sobre esse lucro que sai o prêmio do vendedor.
 */
export const BOLSA_PISO_PADRAO = 1.48;
export const LINHA_4PCT_PADRAO = 1.586;
export const PREMIO_PADRAO = 0.25;

/**
 * Piso por DEGRAU de volume do canal (escada da meta): as despesas fixas são as
 * mesmas em qualquer volume, então o markup que garante 4% cai conforme o canal
 * vende mais. `volume_min` = receita líquida média por mês do canal (últimos 3
 * meses comissionais fechados); o piso é o do maior degrau alcançado. Neste
 * modo a linha dos 4% É o piso: saldo retido = lucro a mais, um para um.
 */
export interface DegrauBolsa {
  volume_min: number;
  piso: number;
}
export const DEGRAUS_BOLSA_PADRAO: DegrauBolsa[] = [
  { volume_min: 0, piso: 1.586 },
  { volume_min: 560_000, piso: 1.538 },
  { volume_min: 645_000, piso: 1.48 },
  { volume_min: 700_000, piso: 1.45 },
  { volume_min: 763_000, piso: 1.421 },
];

/** "0:1.586,560000:1.538,…" → degraus ordenados; texto inválido cai no padrão. */
export function parseDegrausBolsa(texto?: string | null): DegrauBolsa[] {
  if (!texto) return DEGRAUS_BOLSA_PADRAO;
  const out: DegrauBolsa[] = [];
  for (const par of texto.split(',')) {
    const [v, p] = par.split(':').map((x) => Number(String(x).trim()));
    if (Number.isFinite(v) && v >= 0 && Number.isFinite(p) && p > 1) out.push({ volume_min: v, piso: p });
  }
  return out.length ? out.sort((a, b) => a.volume_min - b.volume_min) : DEGRAUS_BOLSA_PADRAO;
}

/**
 * Piso pela DRE do canal: o markup sobre o custo que deixa o atacado na meta de
 * resultado (4% da receita líquida, antes das retiradas) com as despesas REAIS
 * da janela — não só o volume. Da DRE:
 *   RL × (1 − variáveis − meta) = CMV + fixas  →  piso = (CMV + fixas) / (CMV × (1 − variáveis − meta))
 * `variáveis` = despesas comerciais (frete, cartão, comissões, prêmios, ST/DIFAL…) ÷ RL.
 * Se as fixas sobem, o piso sobe; se o volume cresce, cai — todo mês fechado.
 */
export interface MesDre {
  ano: number;
  mes: number;
  /** Receita bruta contábil do canal. */
  receita_bruta: number;
  /** Abatimentos (devoluções, PIS/COFINS…), POSITIVO. */
  abatimento: number;
  /** Custo das mercadorias vendidas, POSITIVO. */
  cmv: number;
  /** Despesas comerciais (variáveis), POSITIVO. */
  comerciais: number;
  /** Pessoal + ocupação + G&A + veículos + tributárias + financeiro − outras receitas, POSITIVO. */
  fixas: number;
  /** Mês com todos os grupos contabilizados (pessoal é o último a fechar). */
  fechado: boolean;
}

export interface PisoDre {
  piso: number;
  meta: number;
  meses: number;
  de: { ano: number; mes: number } | null;
  ate: { ano: number; mes: number } | null;
  receita_liquida: number;
  cmv: number;
  fixas: number;
  comerciais: number;
  variaveis_pct: number;
  /** Markup contábil realizado na janela (RL ÷ CMV) — para comparar com o piso. */
  markup_realizado: number | null;
}

export function pisoPorDre(meses: MesDre[], janela = 12, meta = 0.04): PisoDre | null {
  // A DRE não é tempo real: a folha entra por lançamento manual, então o mês
  // corrente (e às vezes o anterior) chega sem pessoal. Só entram meses fechados;
  // e um mês "fechado" com fixas abaixo de metade da mediana dos demais está
  // meio lançado — fica de fora até completar.
  const candidatos = meses.filter((m) => m.fechado && m.cmv > 0);
  const ordenadas = candidatos.map((m) => m.fixas).sort((a, b) => a - b);
  const mediana = ordenadas.length ? ordenadas[Math.floor(ordenadas.length / 2)] : 0;
  const fechados = candidatos
    .filter((m) => candidatos.length < 3 || m.fixas >= mediana * 0.5)
    .sort((a, b) => a.ano * 100 + a.mes - (b.ano * 100 + b.mes))
    .slice(-janela);
  if (!fechados.length) return null;
  const soma = (k: keyof MesDre) => fechados.reduce((t, m) => t + Number(m[k] ?? 0), 0);
  const rl = soma('receita_bruta') - soma('abatimento');
  const cmv = soma('cmv'), fixas = soma('fixas'), comerciais = soma('comerciais');
  if (!(rl > 0) || !(cmv > 0)) return null;
  const variaveis = comerciais / rl;
  const denominador = 1 - variaveis - meta;
  if (denominador <= 0) return null;
  return {
    piso: round4((cmv + fixas) / (cmv * denominador)),
    meta,
    meses: fechados.length,
    de: { ano: fechados[0].ano, mes: fechados[0].mes },
    ate: { ano: fechados[fechados.length - 1].ano, mes: fechados[fechados.length - 1].mes },
    receita_liquida: round2(rl),
    cmv: round2(cmv),
    fixas: round2(fixas),
    comerciais: round2(comerciais),
    variaveis_pct: round4(variaveis),
    markup_realizado: round4(rl / cmv),
  };
}

export function pisoPorVolume(degraus: DegrauBolsa[], volumeMes: number) {
  const ordem = [...degraus].sort((a, b) => a.volume_min - b.volume_min);
  const v = Math.max(0, volumeMes);
  const atual = [...ordem].reverse().find((d) => v >= d.volume_min) ?? ordem[0];
  const proximo = ordem.find((d) => d.volume_min > v && d.piso < atual.piso) ?? null;
  return {
    piso: atual.piso,
    degrau_min: atual.volume_min,
    proximo_min: proximo?.volume_min ?? null,
    proximo_piso: proximo?.piso ?? null,
    falta: proximo ? round2(proximo.volume_min - v) : 0,
  };
}
/** Piso absoluto de um item pago pela bolsa: custo × 1,25. Abaixo disso, aprovação. */
export const PISO_ITEM_PADRAO = 1.25;

export interface BolsaEntrada {
  /** Venda líquida do mês comissional (já com o desconto tirado). */
  receita_mtd: number;
  /** Custo (reposição na venda) das mercadorias vendidas no mês. */
  custo_mtd: number;
  /** Desconto concedido no mês (positivo). */
  desconto_mtd: number;
  /** O orçamento em edição: total líquido e custo dos itens. Itens sem custo entram em `sem_custo_orc` (neutros). */
  receita_orc?: number;
  desconto_orc?: number;
  custo_orc?: number;
  sem_custo_orc?: number;
  piso?: number;
  linha?: number;
  premio_pct?: number;
}

export interface Bolsa {
  piso: number;
  linha: number;
  premio_pct: number;
  bruto_mtd: number;
  receita_mtd: number;
  custo_mtd: number;
  desconto_mtd: number;
  /** desconto ÷ bruto — só informação. */
  pct_desconto: number;
  markup_mtd: number | null;
  /** O que a venda do mês gerou a preço cheio: bruto − custo × piso. */
  gerada: number;
  /** O que sobra depois do desconto dado: receita − custo × piso. É o que ainda cabe. */
  saldo: number;
  saldo_apos: number;
  /** Lucro acima da linha dos 4%: receita − custo × linha (negativo = abaixo da linha). */
  acima_linha: number;
  acima_linha_apos: number;
  premio_estimado: number;
  premio_estimado_apos: number;
  semaforo_atual: Semaforo;
  semaforo_apos: Semaforo;
}

/** VERDE = acima da linha dos 4% (gera prêmio); AMARELO = dentro da bolsa; VERMELHO = bolsa estourada. */
export function semaforoBolsa(saldo: number, acimaLinha: number): Semaforo {
  if (saldo < -0.005) return 'VERMELHO';
  return acimaLinha > 0.005 ? 'VERDE' : 'AMARELO';
}

export function calcularBolsa(e: BolsaEntrada): Bolsa {
  const piso = e.piso ?? BOLSA_PISO_PADRAO;
  const linha = e.linha ?? LINHA_4PCT_PADRAO;
  const premio = e.premio_pct ?? PREMIO_PADRAO;
  const receita = Math.max(0, e.receita_mtd);
  const custo = Math.max(0, e.custo_mtd);
  const desc = Math.max(0, e.desconto_mtd);
  const recOrc = Math.max(0, e.receita_orc ?? 0);
  // Item sem custo no cadastro é neutro: conta como vendido exatamente no piso.
  const custoOrc = Math.max(0, e.custo_orc ?? 0) + Math.max(0, e.sem_custo_orc ?? 0) / piso;
  const saldo = receita - custo * piso;
  const saldoApos = saldo + (recOrc - custoOrc * piso);
  const acima = receita - custo * linha;
  const acimaApos = acima + (recOrc - custoOrc * linha);
  return {
    piso,
    linha,
    premio_pct: premio,
    bruto_mtd: round2(receita + desc),
    receita_mtd: round2(receita),
    custo_mtd: round2(custo),
    desconto_mtd: round2(desc),
    pct_desconto: receita + desc > 0 ? round4(desc / (receita + desc)) : 0,
    markup_mtd: custo > 0 ? round4(receita / custo) : null,
    gerada: round2(receita + desc - custo * piso),
    saldo: round2(saldo),
    saldo_apos: round2(saldoApos),
    acima_linha: round2(acima),
    acima_linha_apos: round2(acimaApos),
    premio_estimado: round2(premio * Math.max(0, acima)),
    premio_estimado_apos: round2(premio * Math.max(0, acimaApos)),
    semaforo_atual: semaforoBolsa(saldo, acima),
    semaforo_apos: semaforoBolsa(saldoApos, acimaApos),
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
