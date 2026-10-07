import { BadRequestException } from '@nestjs/common';
import {
  ven_encomenda_pecas_itens_cotados,
  ven_encomenda_pecas_itens_encomendados,
} from '@prisma/client';
import { ItemPedidoEncomenda } from '../common/compras-api/compras-api.service';

/** Sentinela antigo de "peça sem código no ERP": não existe no Celta, não pode ir ao pedido. */
export const PRO_CODIGO_SEM_ERP = 99999;

/** Rótulo do pedido gerado no compras-service (faixa da intranet, origem encomenda). */
export function formatarPedidoCompras(n: number | null | undefined): string | null {
  return n == null ? null : `E-${n}`;
}

/**
 * Itens que vão para o pedido de compra: os cotados SELECIONADOS (autorizado = true),
 * cada um com o fornecedor (for_codigo) e o produto do Celta (pro_codigo) resolvidos.
 *
 * O produto vem do item cotado; se a cotação não disse de qual produto é e a
 * encomenda tem UMA peça só, é ela. Quantidade, descrição e referência vêm da peça
 * encomendada com esse código (quantidade 1 e o nome da cotação quando não houver).
 *
 * Qualquer item selecionado sem fornecedor ou sem produto do Celta impede a geração:
 * o erro lista todos de uma vez para a tela corrigir num passo só.
 */
export function montarItensPedidoCompras(
  pecas: ven_encomenda_pecas_itens_encomendados[],
  cotados: ven_encomenda_pecas_itens_cotados[],
): ItemPedidoEncomenda[] {
  const selecionados = cotados.filter((c) => c.autorizado === true);
  if (!selecionados.length) {
    throw new BadRequestException(
      'Nenhum item cotado está selecionado (autorizado): não há o que comprar.',
    );
  }

  const pecaUnica = pecas.length === 1 ? pecas[0] : null;
  const problemas: string[] = [];
  const itens: ItemPedidoEncomenda[] = [];

  for (const c of selecionados) {
    const proCodigo = c.pro_codigo ?? pecaUnica?.pro_codigo ?? null;
    const faltas: string[] = [];
    if (c.for_codigo == null) faltas.push('sem código do fornecedor');
    if (proCodigo == null) faltas.push('sem produto do Celta');
    else if (proCodigo === PRO_CODIGO_SEM_ERP) {
      faltas.push('produto sem cadastro no Celta (99999)');
    }
    if (faltas.length) {
      problemas.push(`"${c.nome}" (${faltas.join(', ')})`);
      continue;
    }

    const peca = pecas.find((p) => p.pro_codigo === proCodigo) ?? null;
    itens.push({
      pro_codigo: proCodigo!,
      pro_descricao: peca?.pro_descricao ?? c.nome,
      referencia: peca?.referencia ?? null,
      mar_descricao: c.marca ?? null,
      quantidade: peca?.quantidade ?? 1,
      for_codigo: c.for_codigo!,
      valor_unitario: c.custo ?? null,
      frete: c.frete ?? null,
      prazo: c.prazo ?? null,
      nomeFrete: c.transpostadora ?? null,
      item_cotado_id: String(c.id),
    });
  }

  if (problemas.length) {
    throw new BadRequestException(
      'Não dá para gerar o pedido de compra. Itens selecionados com pendência: ' +
        `${problemas.join('; ')}.`,
    );
  }
  return itens;
}
