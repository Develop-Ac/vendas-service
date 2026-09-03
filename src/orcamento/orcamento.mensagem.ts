import type { PdfOrcamento } from './orcamento.pdf';

/**
 * MENSAGEM DO WHATSAPP — curta e organizada; o detalhe fica no PDF.
 *
 * Decisão (03/09/2026): uma linha por item com quantidade, descrição, marca e
 * o total da linha; nada de unitário nem % por item. O desconto aparece UMA
 * vez, em R$, no fechamento. Negrito só no cabeçalho e no total (o WhatsApp
 * lê *asteriscos* como negrito). Sem tabulação: o WhatsApp não respeita.
 */
const brl = (v: number) => `R$ ${(v ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function mensagemWhatsapp(o: PdfOrcamento): string {
  const linhas: string[] = [];
  linhas.push(`*AC Acessórios · Orçamento ${o.numero}*`);
  linhas.push(`${o.cliente.nome} · ${o.emissao}`);
  linhas.push('');
  for (const it of o.itens) {
    const qtd = Number.isInteger(it.quantidade) ? String(it.quantidade) : it.quantidade.toLocaleString('pt-BR');
    const marca = it.marca ? ` (${it.marca})` : '';
    const promo = it.promocao_fim ? ' — promoção' : '';
    linhas.push(`${qtd} × ${it.descricao}${marca}${promo} — ${brl(it.total)}`);
  }
  linhas.push('');
  linhas.push(`Subtotal: ${brl(o.subtotal)}`);
  if (o.desconto > 0) linhas.push(`Desconto: − ${brl(o.desconto)}`);
  linhas.push(`*Total: ${brl(o.total)}*`);
  linhas.push('');
  linhas.push(`Válido até ${o.validade ?? '—'} · detalhes no PDF`);
  return linhas.join('\n');
}
