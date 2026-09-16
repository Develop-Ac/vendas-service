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
  desc_max_pct?: number | null;
  acima_alcada?: boolean;
  faixa?: string | null;
  classe?: string | null;
}

export interface OrcamentoParaCelta {
  id: string;
  numero: number;
  cli_codigo: number;
  rep_codigo: number | null;
  rep_nome?: string | null;
  cp_codigo: number | null;
  fp_codigo: string | null;
  observacao: string | null;
  desc_pct?: number;
  acima_alcada?: boolean;
  bolsa_pct_antes?: number | null;
  bolsa_pct_depois?: number | null;
  aprovado_por?: string | null;
  aprovado_em?: Date | string | null;
  itens?: ItemParaCelta[];
}

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')}%`);
const dataBr = (d: Date | string | null | undefined) => {
  if (!d) return '';
  const x = typeof d === 'string' ? new Date(d) : d;
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('pt-BR', { timeZone: 'America/Cuiaba' });
};

/**
 * Texto que vai na observação do Celta para o gerente liberar o orçamento sem
 * consultar a intranet: se está dentro da alçada do vendedor, quem aprovou quando
 * não estava, o desconto do mês antes/depois e, item a item, desconto dado × máximo
 * da faixa. Sem custo nem valores em R$: a observação do ERP pode sair impressa.
 */
export function justificativaAlcada(o: OrcamentoParaCelta): string {
  const linhas: string[] = [];
  const vend = [o.rep_codigo, o.rep_nome].filter(Boolean).join(' ');
  linhas.push(`Intranet ORC-${String(o.numero).padStart(6, '0')}${vend ? ` · vendedor ${vend}` : ''}`);
  const aprov = o.aprovado_por ? `aprovado por ${o.aprovado_por}${dataBr(o.aprovado_em) ? ` em ${dataBr(o.aprovado_em)}` : ''}` : '';
  const alcada = o.acima_alcada
    ? `Alçada: abaixo do mínimo da régua${aprov ? `, ${aprov}` : ' — SEM aprovação registrada'}.`
    : `Alçada: dentro do limite do vendedor${aprov ? ` (${aprov})` : ''}.`;
  const mes = o.bolsa_pct_antes != null && o.bolsa_pct_depois != null ? ` Desconto do mês: ${pct(o.bolsa_pct_antes)} -> ${pct(o.bolsa_pct_depois)}.` : '';
  linhas.push(`${alcada} Desconto total ${pct(o.desc_pct ?? 0)}.${mes}`);
  const comDesc = (o.itens ?? []).filter((i) => Number(i.desc_pct) > 0);
  if (comDesc.length) {
    const partes = comDesc.map((i) => {
      const max = i.desc_max_pct;
      const faixa = [i.faixa, i.classe].filter(Boolean).join(' ');
      const situacao = i.acima_alcada ? 'abaixo do mínimo' : max != null && Number(i.desc_pct) > Number(max) + 1e-9 ? 'usa a bolsa' : 'ok';
      return `${i.pro_codigo} ${pct(Number(i.desc_pct))} (máx ${pct(max)}${faixa ? `, ${faixa}` : ''}, ${situacao})`;
    });
    linhas.push(`Itens com desconto: ${partes.join('; ')}`);
  }
  return linhas.join('\n');
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
  // Justificativa da alçada primeiro (cabe sempre); a observação do vendedor vem depois
  // e é o que se corta quando o total passa do limite do ERP.
  const just = justificativaAlcada(o);
  const obs = o.observacao ? `${just}\n${o.observacao}` : just;
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
