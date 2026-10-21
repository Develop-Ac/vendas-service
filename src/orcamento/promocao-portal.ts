import type { PromocaoItem } from './orcamento.erp.repository';

/**
 * Código de promoção dos itens em promoção do PORTAL B2B. Ela não existe no
 * Celta (códigos de lá são positivos), mas o item é promoção como qualquer
 * outra: `promocao_codigo != null` liga preço fechado, metade do negativo da
 * bolsa para a empresa, validade até o fim e "vender fora da promoção". A
 * importação no Celta não manda o código — o item vai com o preço normal.
 */
export const PROMOCAO_PORTAL = 0;

/** Promoção do portal por produto: preço que o comprador viu (com a margem) e o fim. */
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
 * Quanto de uma linha de NF (venda) saiu em promoção do portal: a fração da
 * quantidade casada com itens de orçamento em promoção do portal (e não
 * vendidos fora dela). O BI não marca essa venda como promoção — no Celta ela
 * é venda normal —, então é por aqui que a metade do negativo volta ao mês.
 */
export function fracaoPromoPortal(quantidadeLinha: number, casadas: Array<{ quantidade: number; promo_portal?: boolean }>): number {
  if (!(quantidadeLinha > 0)) return 0;
  const q = casadas.filter((c) => c.promo_portal).reduce((s, c) => s + c.quantidade, 0);
  return Math.min(1, q / quantidadeLinha);
}
