import type { PromocaoItem } from './orcamento.erp.repository';

/**
 * Código de promoção dos itens em promoção do PORTAL B2B. Ela não existe no
 * Celta (códigos de lá são positivos), mas o item é promoção como qualquer
 * outra: `promocao_codigo != null` liga preço fechado, metade do negativo da
 * bolsa para a empresa, validade até o fim e "vender fora da promoção". A
 * importação no Celta não manda o código, mas manda o item com `promocao: true`.
 */
export const PROMOCAO_PORTAL = 0;

/**
 * Código de promoção dos itens em oferta da intranet (ven_oferta_item). Mesmo
 * caminho da promoção (preço fechado, validade pelo fim, "vender fora"); o item
 * do orçamento guarda ainda oferta_item_id e oferta_tipo.
 */
export const PROMOCAO_OFERTA = -1;

/** Promoção do portal por produto: preço que o comprador viu (sem a margem dele) e o fim. */
export type PromosPortal = Map<number, { preco: number; fim: Date; descricao: string }>;

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Soma as promoções do portal às do Celta, como se fossem do ERP. Promoção
 * do Celta no mesmo item vence (é a que o ERP e o BI conhecem). Vencida
 * (fim antes de hoje, horário de Cuiabá) não vale mais — como no Celta.
 */
export function comPromosDoPortal(promos: Map<number, PromocaoItem>, portal: PromosPortal | undefined, hoje = ymd(new Date(Date.now() - 4 * 3_600_000))) {
  if (!portal?.size) return promos;
  for (const [pro_codigo, p] of portal) {
    const fim = ymd(p.fim);
    if (promos.has(pro_codigo) || fim < hoje || !(p.preco > 0)) continue;
    promos.set(pro_codigo, {
      pro_codigo,
      prom_codigo: PROMOCAO_PORTAL,
      descricao: p.descricao,
      data_final: fim,
      somente_avista: false,
      durar_estoque: false,
      valor: p.preco,
      valor_balcao: null,
    });
  }
  return promos;
}

/**
 * Fração de uma linha de NF (venda) casada com itens de orçamento que levam a
 * `marca`: `promo_portal` (promoção do portal) ou `fora_bolsa` (liquidação/
 * campanha da intranet), em ambos os casos não vendidos fora da promoção.
 */
export function fracaoCasada(
  quantidadeLinha: number,
  casadas: Array<{ quantidade: number; promo_portal?: boolean; fora_bolsa?: boolean }>,
  marca: 'promo_portal' | 'fora_bolsa',
): number {
  if (!(quantidadeLinha > 0)) return 0;
  const q = casadas.filter((c) => c[marca]).reduce((s, c) => s + c.quantidade, 0);
  return Math.min(1, q / quantidadeLinha);
}

/**
 * Quanto de uma linha de NF (venda) saiu em promoção do portal. O item vai ao
 * Celta com `promocao: true`; quando o BI já traz a linha com a marca de
 * promoção, `valoresLinha` aplica a metade pela marca e esta fração não soma
 * de novo. Sem a marca, é por aqui que a metade do negativo volta ao mês.
 */
export function fracaoPromoPortal(quantidadeLinha: number, casadas: Array<{ quantidade: number; promo_portal?: boolean }>): number {
  return fracaoCasada(quantidadeLinha, casadas, 'promo_portal');
}
