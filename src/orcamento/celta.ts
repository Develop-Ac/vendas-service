/**
 * Tradução de um orçamento da intranet para o corpo do `POST /orcamentos/:empresa`
 * da api-vendas-service (a API que grava ORCAMENTOS/ORCAMENTOS_ITENS no Celta).
 *
 * Regras do contrato da API: `unitario` é o preço BRUTO (tabela) e o desconto vai
 * em `perc_descto` (0–99,99, percentual); aqui `desc_pct` é fração (0–1). Uma forma
 * de pagamento só vale para entrada e demais parcelas. A quantidade vai inteira
 * (o que ficou sob encomenda continua no orçamento do Celta).
 */
export interface ItemParaCelta {
  pro_codigo: number;
  quantidade: number;
  preco_tabela: number;
  desc_pct: number;
}

export interface OrcamentoParaCelta {
  id: string;
  numero: number;
  cli_codigo: number;
  rep_codigo: number | null;
  cp_codigo: number | null;
  fp_codigo: string | null;
  observacao: string | null;
  itens?: ItemParaCelta[];
}

export interface CorpoCelta {
  cli_codigo: number;
  rep_codigo: number | null;
  cp_codigo?: number;
  fp_entrada?: string;
  fp_demais_parcelas?: string;
  observacao?: string;
  itens: Array<{ pro_codigo: number; quantidade: number; unitario: number; perc_descto: number }>;
}

const OBSERVACAO_MAX = 2000;

export function corpoParaCelta(o: OrcamentoParaCelta): CorpoCelta {
  const itens = (o.itens ?? []).map((i) => ({
    pro_codigo: i.pro_codigo,
    quantidade: Number(i.quantidade),
    unitario: Math.round(Number(i.preco_tabela) * 100) / 100,
    perc_descto: Math.min(99.99, Math.max(0, Math.round(Number(i.desc_pct) * 10000) / 100)),
  }));
  if (!itens.length) throw new Error('Orçamento sem itens não vai ao Celta.');
  const obs = `Intranet ORC-${String(o.numero).padStart(6, '0')}${o.observacao ? '\n' + o.observacao : ''}`;
  const fp = o.fp_codigo?.trim() || undefined;
  return {
    cli_codigo: o.cli_codigo,
    rep_codigo: o.rep_codigo,
    ...(o.cp_codigo ? { cp_codigo: o.cp_codigo } : {}),
    ...(fp ? { fp_entrada: fp, fp_demais_parcelas: fp } : {}),
    observacao: obs.slice(0, OBSERVACAO_MAX),
    itens,
  };
}

/** Uma chave por orçamento da intranet: repetir a importação devolve o mesmo nº do Celta. */
export const chaveIdempotencia = (o: { id: string }) => `intranet-orc-${o.id}`;
