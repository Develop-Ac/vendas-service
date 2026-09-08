/* =============================================================================
   COMISSÃO DO ATACADO — estimativa na tela de orçamento (puro, sem I/O).
   -----------------------------------------------------------------------------
   Reproduz a regra do fechamento (pessoal-service, engine do atacado) para o
   vendedor enxergar, ao lado da bolsa, quanto o orçamento em edição acrescenta
   de comissão — e decidir se vale gastar a bolsa em desconto:

     células = Σ venda líquida por (mix, faixa) no mês comissional (26 → 25);
     MIX 1   -> % fixo por faixa A/B/C/D; dobra quando a participação do MIX 1
                no total do mês atinge a meta (ComissaoAtacadoConfig.meta_mix1);
     MIX 2/3 -> % progressivo escolhido pelo TOTAL vendido no mês
                (ComissaoAtacadoFaixaMix23, 1ª faixa em que total <= valor_max).

   Fica de fora o que só o fechamento sabe: abatimentos manuais e média de
   férias. Por isso é uma estimativa — a diferença "com este orçamento" é o que
   interessa, e essa é exata dentro da regra.
   ============================================================================= */

export interface FaixaMix1 {
  faixa: string;
  atingiu_meta: boolean;
  percentual: number;
}

export interface FaixaMix23 {
  valor_min: number;
  valor_max: number;
  percentual: number;
}

export interface ConfigComissao {
  faixasMix1: FaixaMix1[];
  faixasMix23: FaixaMix23[];
  /** Participação do MIX 1 que dobra o % (ex.: 0,30). */
  metaMix1: number;
}

export interface CelulaComissao {
  mix: number;
  faixa: string;
  valor: number;
}

export interface ResumoComissao {
  total: number;
  mix1: number;
  pct_mix1: number;
  atingiu_meta: boolean;
  pct_mix23: number;
  comissao: number;
}

const r2 = (v: number) => Math.round(v * 100 + 1e-7) / 100;
const r4 = (v: number) => Math.round(v * 10000 + 1e-7) / 10000;

/** Alíquota do MIX 2/3: 1ª faixa (valor_max crescente) em que total <= valor_max; <= 0 => 0. */
export function percentualMix23(total: number, faixas: FaixaMix23[]): number {
  if (total <= 0) return 0;
  const ordenadas = [...faixas].sort((a, b) => a.valor_max - b.valor_max);
  for (const f of ordenadas) if (total <= f.valor_max) return f.percentual;
  return ordenadas.length ? ordenadas[ordenadas.length - 1].percentual : 0;
}

/** % fixo do MIX 1 por (faixa, atingiu_meta). Sem match => 0. */
export function percentualMix1(faixa: string, atingiuMeta: boolean, faixas: FaixaMix1[]): number {
  const alvo = (faixa ?? '').trim().toUpperCase();
  const f = faixas.find((x) => (x.faixa ?? '').trim().toUpperCase() === alvo && !!x.atingiu_meta === atingiuMeta);
  return f ? f.percentual : 0;
}

export function calcularComissao(celulas: CelulaComissao[], cfg: ConfigComissao): ResumoComissao {
  const total = celulas.reduce((s, c) => s + (c.valor || 0), 0);
  const mix1 = celulas.filter((c) => c.mix === 1).reduce((s, c) => s + (c.valor || 0), 0);
  const pct_mix1 = total > 0 ? mix1 / total : 0;
  const atingiu_meta = total > 0 && pct_mix1 >= cfg.metaMix1;
  const pct_mix23 = percentualMix23(total, cfg.faixasMix23);
  let comissao = 0;
  for (const c of celulas) {
    const pct = c.mix === 1 ? percentualMix1(c.faixa, atingiu_meta, cfg.faixasMix1) : c.mix === 2 || c.mix === 3 ? pct_mix23 : 0;
    comissao += (c.valor || 0) * pct;
  }
  return { total: r2(total), mix1: r2(mix1), pct_mix1: r4(pct_mix1), atingiu_meta, pct_mix23, comissao: r2(comissao) };
}

/**
 * Comissão do mês como está e como fica se o orçamento fechar. A diferença não
 * é só o orçamento × %: o total maior pode subir a alíquota do MIX 2/3 e a
 * participação do MIX 1 pode cruzar (ou perder) a meta — por isso recalcula tudo.
 */
export function comissaoComOrcamento(mes: CelulaComissao[], orcamento: CelulaComissao[], cfg: ConfigComissao) {
  const atual = calcularComissao(mes, cfg);
  const depois = calcularComissao([...mes, ...orcamento], cfg);
  return { atual, com_orcamento: depois, delta: r2(depois.comissao - atual.comissao), meta_mix1: cfg.metaMix1 };
}

/** Totais do orçamento por célula (MIX 1 por faixa A–D; o resto vale como MIX 2/3). */
export function celulasDoOrcamento(o: { m1a?: number; m1b?: number; m1c?: number; m1d?: number; m23?: number }): CelulaComissao[] {
  const out: CelulaComissao[] = [];
  const m1: Array<[string, number | undefined]> = [['A', o.m1a], ['B', o.m1b], ['C', o.m1c], ['D', o.m1d]];
  for (const [faixa, v] of m1) if (v && v > 0) out.push({ mix: 1, faixa, valor: v });
  if (o.m23 && o.m23 > 0) out.push({ mix: 2, faixa: 'A', valor: o.m23 });
  return out;
}
