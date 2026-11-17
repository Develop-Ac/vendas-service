import { round2 } from '../orcamento/regua';
import { cruza, Periodo, TipoOferta } from './oferta';

/* =============================================================================
   PRÊMIO DO VENDEDOR NAS OFERTAS — regras puras.
   -----------------------------------------------------------------------------
   Percentual sempre em fração (0,05 = 5%).
   - Liquidação: PCT_CUSTO — bônus = quantidade × custo de referência × pct.
   - Campanha (da empresa ou do fornecedor): PCT_VENDA (pct × líquido vendido)
     ou VALOR_UNIDADE (R$ por unidade), com faixas opcionais por quantidade
     total vendida pelo vendedor na campanha (a faixa vale para todas as unidades).
   - Promoção: sem prêmio.
   Campanha paga no mês comissional em que cai o fim, depois que ela termina.
   ============================================================================= */

export type PremioTipo = 'PCT_CUSTO' | 'PCT_VENDA' | 'VALOR_UNIDADE';
export type OrigemOferta = 'EMPRESA' | 'FORNECEDOR';

export interface FaixaPremio {
  a_partir_de: number;
  valor: number;
}

export interface Premio {
  tipo: PremioTipo;
  valor: number;
  faixas: FaixaPremio[];
}

/** Prêmio do cabeçalho do grupo; sem tipo ou valor = sem prêmio. */
export function premioDe(g: { premio_tipo: string | null; premio_valor: unknown; premio_faixas?: unknown }): Premio | null {
  if (!g.premio_tipo || g.premio_valor == null) return null;
  const faixas = Array.isArray(g.premio_faixas) ? (g.premio_faixas as FaixaPremio[]) : [];
  return {
    tipo: g.premio_tipo as PremioTipo,
    valor: Number(g.premio_valor),
    faixas: faixas.map((f) => ({ a_partir_de: Number(f.a_partir_de), valor: Number(f.valor) })),
  };
}

export interface ConferenciaPremio {
  tipo: TipoOferta;
  origem?: string | null;
  fornecedor_codigo?: number | null;
  premio_tipo?: string | null;
  premio_valor?: number | null;
  faixas?: FaixaPremio[] | null;
}

/** Erros do prêmio do grupo, um por frase; vazio = pode gravar. */
export function conferirPremio(c: ConferenciaPremio): string[] {
  const erros: string[] = [];
  const faixas = c.faixas ?? [];
  const valor = Number(c.premio_valor ?? 0);
  if (c.tipo === 'PROMOCAO') {
    if (c.premio_tipo || c.premio_valor != null || faixas.length) erros.push('Promoção não tem prêmio.');
    return erros;
  }
  if (c.tipo === 'LIQUIDACAO') {
    if (c.premio_tipo !== 'PCT_CUSTO') erros.push('Prêmio da liquidação é percentual sobre o custo.');
    if (!(valor > 0 && valor < 1)) erros.push('Percentual do prêmio deve ficar entre 0 e 100%.');
    if (faixas.length) erros.push('Liquidação não tem faixas.');
    return erros;
  }
  if (c.origem !== 'EMPRESA' && c.origem !== 'FORNECEDOR') erros.push('Informe a origem da campanha (empresa ou fornecedor).');
  if (c.origem === 'FORNECEDOR' && !c.fornecedor_codigo) erros.push('Informe o fornecedor da campanha.');
  const pct = c.premio_tipo === 'PCT_VENDA';
  if (!pct && c.premio_tipo !== 'VALOR_UNIDADE') erros.push('Prêmio da campanha é percentual sobre a venda ou valor por unidade.');
  const valido = (v: number) => v > 0 && (!pct || v < 1);
  if (!valido(valor)) erros.push(pct ? 'Percentual do prêmio deve ficar entre 0 e 100%.' : 'Valor do prêmio deve ser maior que zero.');
  let anterior = { a_partir_de: 0, valor };
  faixas.forEach((f, i) => {
    const q = Number(f.a_partir_de);
    const v = Number(f.valor);
    if (!(q > anterior.a_partir_de)) erros.push(`Faixa ${i + 1}: quantidade deve ser maior que a da faixa anterior.`);
    if (!valido(v) || !(v > anterior.valor)) erros.push(`Faixa ${i + 1}: prêmio deve ser maior que o anterior.`);
    anterior = { a_partir_de: q, valor: v };
  });
  return erros;
}

/** Valor (pct ou R$/un) que vale para a quantidade total: a maior faixa alcançada, senão o base. */
export function valorNaFaixa(premio: Premio, quantidade: number): number {
  let v = premio.valor;
  for (const f of premio.faixas) if (quantidade >= f.a_partir_de) v = f.valor;
  return v;
}

/** Ganho por unidade mostrado no orçamento (R$/un) e a primeira faixa acima do base. */
export function ganhoParaExibir(
  premio: Premio | null,
  p: { custo: number | null; preco: number },
): { ganho_unit: number; proxima_faixa: { valor: number; a_partir_de: number } | null } | null {
  if (!premio) return null;
  const emReais = (v: number) =>
    premio.tipo === 'PCT_CUSTO' ? round2(Number(p.custo ?? 0) * v) : premio.tipo === 'PCT_VENDA' ? round2(p.preco * v) : round2(v);
  const f = premio.faixas[0];
  return { ganho_unit: emReais(premio.valor), proxima_faixa: f ? { valor: emReais(f.valor), a_partir_de: f.a_partir_de } : null };
}

/** Venda casada do vendedor na oferta; quantidade e líquido negativos na devolução. */
export interface VendaPremio {
  quantidade: number;
  liquido: number;
  custo_ref: number | null;
}

/** Prêmio do vendedor na oferta. Campanha nunca fica negativa. */
export function premioDoVendedor(premio: Premio, vendas: VendaPremio[]): number {
  if (premio.tipo === 'PCT_CUSTO') return round2(vendas.reduce((s, v) => s + v.quantidade * Number(v.custo_ref ?? 0) * premio.valor, 0));
  const qtd = vendas.reduce((s, v) => s + v.quantidade, 0);
  const faixa = valorNaFaixa(premio, qtd);
  const total = premio.tipo === 'VALOR_UNIDADE' ? faixa * qtd : faixa * vendas.reduce((s, v) => s + v.liquido, 0);
  return Math.max(0, round2(total));
}

/**
 * Situação da campanha no mês comissional: PAGAR quando o fim cai no mês e a
 * campanha já terminou; ANDAMENTO quando cruza o mês e ainda não está paga.
 */
export function situacaoDaCampanha(campanha: Periodo, mes: Periodo, hoje: string): 'PAGAR' | 'ANDAMENTO' | null {
  if (campanha.fim >= mes.inicio && campanha.fim <= mes.fim && hoje > campanha.fim) return 'PAGAR';
  return cruza(campanha, mes) ? 'ANDAMENTO' : null;
}
