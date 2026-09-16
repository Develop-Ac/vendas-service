/**
 * SALDO AO CONCLUIR — o que fazer com item zerado ou com saldo menor que o pedido.
 *
 * Ao enviar/fechar, o saldo é relido do ERP. Item com saldo insuficiente para a
 * parte "a entregar agora" (quantidade − já sob encomenda) é uma PENDÊNCIA, e o
 * orçamento não conclui enquanto o vendedor não decidir, item a item:
 *   VENDA_PERDIDA → a parte sem saldo sai do orçamento e vira registro de venda perdida;
 *   ENCOMENDA     → a parte sem saldo fica no orçamento marcada como encomenda (entrega depois);
 *   RETIRAR       → a parte sem saldo simplesmente sai.
 * `manter_disponivel` (padrão sim) mantém no orçamento a quantidade que existe hoje;
 * a decisão vale só para a diferença.
 *
 * Funções puras: quem lê o ERP e grava é o service.
 */
export type AcaoSaldo = 'VENDA_PERDIDA' | 'ENCOMENDA' | 'RETIRAR';

export interface ItemSaldo {
  pro_codigo: number;
  descricao?: string | null;
  quantidade: number;
  qtd_encomenda?: number | null;
}

export interface PendenciaSaldo {
  pro_codigo: number;
  descricao: string | null;
  quantidade: number;
  qtd_encomenda: number;
  /** o que precisa sair do estoque agora: quantidade − encomenda */
  a_entregar: number;
  disponivel: number;
  falta: number;
}

export interface DecisaoSaldo {
  pro_codigo: number;
  acao: AcaoSaldo;
  manter_disponivel?: boolean;
}

export interface VendaPerdida {
  pro_codigo: number;
  descricao: string | null;
  quantidade: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Saldo indisponível (produto sumiu do ERP) conta como zero. */
export function pendenciasSaldo(itens: ItemSaldo[], saldoPor: Map<number, number | undefined>): PendenciaSaldo[] {
  const out: PendenciaSaldo[] = [];
  for (const i of itens) {
    const encomenda = Math.max(0, Number(i.qtd_encomenda ?? 0));
    const aEntregar = r3(Math.max(0, Number(i.quantidade) - encomenda));
    const disponivel = Math.max(0, Number(saldoPor.get(i.pro_codigo) ?? 0));
    const falta = r3(Math.max(0, aEntregar - disponivel));
    if (falta > 0) {
      out.push({ pro_codigo: i.pro_codigo, descricao: i.descricao ?? null, quantidade: Number(i.quantidade), qtd_encomenda: encomenda, a_entregar: aEntregar, disponivel, falta });
    }
  }
  return out;
}

export function aplicarDecisoes<T extends ItemSaldo>(
  itens: T[],
  saldoPor: Map<number, number | undefined>,
  decisoes: DecisaoSaldo[],
): { itens: T[]; venda_perdida: VendaPerdida[]; sem_decisao: number[] } {
  const pend = new Map(pendenciasSaldo(itens, saldoPor).map((p) => [p.pro_codigo, p]));
  const porCodigo = new Map(decisoes.map((d) => [d.pro_codigo, d]));
  const venda_perdida: VendaPerdida[] = [];
  const sem_decisao: number[] = [];
  const saida: T[] = [];
  for (const i of itens) {
    const p = pend.get(i.pro_codigo);
    if (!p) { saida.push(i); continue; }
    const d = porCodigo.get(i.pro_codigo);
    if (!d) { sem_decisao.push(i.pro_codigo); saida.push(i); continue; }
    const manter = d.manter_disponivel === false ? 0 : Math.min(p.a_entregar, p.disponivel);
    const falta = r3(p.a_entregar - manter);
    if (d.acao === 'ENCOMENDA') {
      saida.push({ ...i, qtd_encomenda: r3(p.qtd_encomenda + falta) });
      continue;
    }
    if (d.acao === 'VENDA_PERDIDA') venda_perdida.push({ pro_codigo: i.pro_codigo, descricao: i.descricao ?? null, quantidade: falta });
    const nova = r3(manter + p.qtd_encomenda);
    if (nova > 0) saida.push({ ...i, quantidade: nova, qtd_encomenda: p.qtd_encomenda });
  }
  return { itens: saida, venda_perdida, sem_decisao };
}
