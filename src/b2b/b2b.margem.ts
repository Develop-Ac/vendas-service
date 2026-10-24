/**
 * A margem do comprador é da LOJA cliente: o master do portal a define para os
 * compradores dele verem o preço já com o lucro da loja. Para a AC o preço é o
 * da tabela, então o valor com margem não entra na intranet — o preço que o
 * portal congelou (tabela × (1 + margem/100), arredondado a centavos) volta à
 * tabela aqui.
 *
 * A tabela do portal tem 2 casas, então o arredondamento a centavos devolve o
 * valor exato (33,00 com 32% → 25,00).
 */
export function semMargem(
  preco: number | null | undefined,
  margem: number | null | undefined,
): number | null {
  if (preco === null || preco === undefined || !Number.isFinite(preco)) {
    return null;
  }
  const m = Number(margem);
  if (!Number.isFinite(m) || m <= 0) return preco;
  return Math.round((preco / (1 + m / 100)) * 100) / 100;
}
