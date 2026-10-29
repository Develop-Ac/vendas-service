import { round2, round4 } from './regua';

/* =============================================================================
   ANÁLISE DA APROVAÇÃO — o que o gerente vê ao aprovar um orçamento do atacado.
   -----------------------------------------------------------------------------
   Só é analisado o item abaixo do mínimo da régua ou acima da alçada; o resto sai
   como "dentro da régua" (null). Três semáforos por item, sem veredito automático:

   - Curva: curva A vendida abaixo do preço médio do canal (atacado, 90 d).
     vermelho < médio × 0,95 · amarelo < médio · verde demais (B/C/D sempre verde)
     · cinza sem curva ou sem venda no canal em 90 d.
   - Varejo: peso do varejo nas unidades de 12 m (varejo ÷ varejo + atacado).
     vermelho ≥ 50 % · amarelo ≥ 30 % · verde < 30 % · cinza sem venda em 12 m.
   - Estoque: saldo após o orçamento (soma das linhas do produto) contra o mínimo
     sugerido. verde ≥ mín · amarelo abaixo do mín mas a 1ª chegada prevista cobre
     · vermelho não cobre · cinza sem mínimo sugerido. Cobertura em dias só informa.

   Quando Curva ou Estoque não estão verdes, sugere um equivalente: o de maior saldo,
   fora da curva A, que continua no mínimo depois de atender a quantidade.
   O pacote soma receita e custo na base da bolsa: sem serviço, item sem custo neutro.
   ============================================================================= */

export type CorAnalise = 'VERDE' | 'AMARELO' | 'VERMELHO' | 'CINZA';

export interface PrecoCanal90d { medio: number; clientes: number; qtd: number }

/** Candidato a troca: similar do produto com saldo do ERP e giro da análise de estoque. */
export interface CandidatoEquivalente { pro_codigo: number; descricao: string | null; saldo: number; curva: string | null; min: number | null }

export interface AnaliseItem {
  curva:   { cor: CorAnalise; curva_abc: string | null; medio: number | null; clientes: number | null; qtd: number | null };
  varejo:  { cor: CorAnalise; pct_varejo: number | null };          // 0..1
  estoque: { cor: CorAnalise; saldo_apos: number; min: number | null; cobertura_dias: number | null; chegada: { qtd: number; data: string } | null };
  venda_perdida_12m: number | null;
  markup_linha: number | null;   // preco_unit / custo_ref
  markup_regua: number | null;
  equivalente: { pro_codigo: number; descricao: string | null; saldo: number; curva: string | null } | null;
}

export interface AnalisePacote {
  receita: number; custo: number; markup: number | null;
  piso_bolsa: number; linha_4pct: number;
  itens_abaixo_piso_custo: number;  // preco_unit < custo_ref × piso do item (1,25 padrão)
  itens_no_custo: number;           // preco_unit <= custo_ref
  alertas: { vermelho: number; amarelo: number };
}

export interface EntradaAnaliseItem {
  preco_unit: number; preco_minimo: number | null; acima_alcada: boolean;
  quantidade: number;            // Σ das linhas do MESMO produto no orçamento
  custo_ref: number | null; markup_regua: number | null;
  estoque_disponivel: number;
  giro: { curva_abc: string | null; demanda_media_dia: number | null; estoque_min_sugerido: number | null;
          qtd_varejo_12m: number | null; qtd_atacado_12m: number | null; venda_perdida_12m: number | null } | null;
  canal: PrecoCanal90d | null;
  chegada: { qtd: number; data: string } | null;   // primeira chegada prevista
  equivalentes: CandidatoEquivalente[];
}

/** Gate da análise: linha abaixo do mínimo da régua ou acima da alçada. */
export function foraDaRegua(l: { preco_unit: number; preco_minimo: number | null; acima_alcada: boolean }): boolean {
  return l.acima_alcada || (l.preco_minimo != null && l.preco_unit < l.preco_minimo);
}

/** null = dentro da régua (não analisado). */
export function analisarItem(e: EntradaAnaliseItem): AnaliseItem | null {
  if (!foraDaRegua(e)) return null;
  const g = e.giro;

  const curvaAbc = g?.curva_abc ?? null;
  const canal = e.canal && e.canal.qtd > 0 ? e.canal : null;
  const corCurva: CorAnalise = !curvaAbc || !canal ? 'CINZA'
    : curvaAbc !== 'A' ? 'VERDE'
    : e.preco_unit < canal.medio * 0.95 ? 'VERMELHO'
    : e.preco_unit < canal.medio ? 'AMARELO' : 'VERDE';

  const vj = g?.qtd_varejo_12m ?? 0;
  const tot = vj + (g?.qtd_atacado_12m ?? 0);
  const pct = tot > 0 ? round4(vj / tot) : null;
  const corVarejo: CorAnalise = pct == null ? 'CINZA' : pct >= 0.5 ? 'VERMELHO' : pct >= 0.3 ? 'AMARELO' : 'VERDE';

  const saldoApos = e.estoque_disponivel - e.quantidade;
  const min = g?.estoque_min_sugerido ?? null;
  const demanda = g?.demanda_media_dia ?? 0;
  const corEstoque: CorAnalise = min == null ? 'CINZA'
    : saldoApos >= min ? 'VERDE'
    : saldoApos + (e.chegada?.qtd ?? 0) >= min ? 'AMARELO' : 'VERMELHO';

  let equivalente: AnaliseItem['equivalente'] = null;
  if (corCurva !== 'VERDE' || corEstoque !== 'VERDE') {
    const melhor = e.equivalentes
      .filter((c) => c.curva !== 'A' && c.min != null && c.saldo - e.quantidade >= c.min)
      .sort((a, b) => b.saldo - a.saldo)[0];
    if (melhor) equivalente = { pro_codigo: melhor.pro_codigo, descricao: melhor.descricao, saldo: melhor.saldo, curva: melhor.curva };
  }

  return {
    curva: { cor: corCurva, curva_abc: curvaAbc, medio: canal?.medio ?? null, clientes: canal?.clientes ?? null, qtd: canal?.qtd ?? null },
    varejo: { cor: corVarejo, pct_varejo: pct },
    estoque: { cor: corEstoque, saldo_apos: saldoApos, min, cobertura_dias: demanda > 0 ? Math.round(saldoApos / demanda) : null, chegada: e.chegada },
    venda_perdida_12m: g?.venda_perdida_12m ?? null,
    markup_linha: e.custo_ref != null && e.custo_ref > 0 ? round4(e.preco_unit / e.custo_ref) : null,
    markup_regua: e.markup_regua,
    equivalente,
  };
}

/**
 * Pacote do orçamento na mesma base da bolsa (`bolsaDoOrcamento`): serviço fora, receita pelo total
 * da linha, item sem custo neutro. `analises` vem uma por produto, para cada semáforo contar uma vez
 * mesmo com o produto em várias linhas. O piso do item é o da alçada (`parametros().piso_item`).
 */
export function analisarPacote(
  itens: { pro_codigo: number; preco_unit: number; quantidade: number; total: number; custo_ref: number | null }[],
  analises: (AnaliseItem | null | undefined)[],
  piso: { piso: number; linha: number; piso_item: number },
  servicos: Set<number>,
): AnalisePacote {
  let receita = 0, receitaComCusto = 0, custo = 0, abaixoPiso = 0, noCusto = 0, vermelho = 0, amarelo = 0;
  for (const i of itens) {
    if (servicos.has(i.pro_codigo)) continue;
    receita += i.total;
    // item sem custo é neutro: fica na receita, mas fora do markup e dos contadores de custo
    if (i.custo_ref != null && i.custo_ref > 0) {
      receitaComCusto += i.total;
      custo += i.custo_ref * i.quantidade;
      if (i.preco_unit < i.custo_ref * piso.piso_item) abaixoPiso++;
      if (i.preco_unit <= i.custo_ref) noCusto++;
    }
  }
  for (const a of analises) {
    if (!a) continue;
    for (const cor of [a.curva.cor, a.varejo.cor, a.estoque.cor]) {
      if (cor === 'VERMELHO') vermelho++;
      else if (cor === 'AMARELO') amarelo++;
    }
  }
  return {
    receita: round2(receita), custo: round2(custo),
    markup: custo > 0 ? round4(receitaComCusto / custo) : null,
    piso_bolsa: piso.piso, linha_4pct: piso.linha,
    itens_abaixo_piso_custo: abaixoPiso, itens_no_custo: noCusto,
    alertas: { vermelho, amarelo },
  };
}
