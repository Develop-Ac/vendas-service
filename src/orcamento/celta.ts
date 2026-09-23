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
  /** unitário cobrado; acima da tabela = acréscimo */
  preco_unit?: number;
  desc_pct: number;
  desc_max_pct?: number | null;
  acima_alcada?: boolean;
  faixa?: string | null;
  classe?: string | null;
  /** limite que valeu na linha (preço mínimo em vigor) e custo de referência — para dizer o que foi compensado */
  preco_minimo?: number | null;
  custo_ref?: number | null;
  promocao_codigo?: number | null;
  fora_promocao?: boolean;
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
  /** piso da bolsa (custo × piso) vigente — para a conta da compensação na observação */
  piso_bolsa?: number | null;
}

/**
 * Compensação do orçamento: linhas que ficaram abaixo do limite em vigor SEM pedir aprovação
 * (o orçamento inteiro fechou ≥ 0 contra custo × piso, a metade da promoção que a empresa
 * absorve incluída) e o resultado dessa conta — o valor fica fora da observação (pode sair
 * impressa para o cliente); só o fato vai. Sem piso, não há como contar.
 */
export function compensacaoOrcamento(o: OrcamentoParaCelta): { itens: number[]; resultado: number } | null {
  const piso = o.piso_bolsa ?? 0;
  if (!(piso > 0)) return null;
  const itens = (o.itens ?? []).filter((i) => !i.acima_alcada && (i.preco_minimo ?? 0) > 0 && unitarioDe(i) < (i.preco_minimo as number) - 0.005).map((i) => i.pro_codigo);
  if (!itens.length) return null;
  let resultado = 0;
  for (const i of o.itens ?? []) {
    const custo = Number(i.custo_ref ?? 0);
    if (!(custo > 0)) continue; // sem custo é neutro
    const preco = unitarioDe(i);
    const qtd = Number(i.quantidade);
    let linha = (preco - custo * piso) * qtd;
    if (i.promocao_codigo != null && !i.fora_promocao && linha < 0) linha /= 2; // metade da promoção é da empresa
    resultado += linha;
  }
  return { itens, resultado: Math.round(resultado * 100) / 100 };
}

/** preço cobrado na linha: unitário fechado, senão tabela menos o desconto */
const unitarioDe = (i: ItemParaCelta) => (Number(i.preco_unit ?? 0) > 0 ? Number(i.preco_unit) : Number(i.preco_tabela) * (1 - Number(i.desc_pct)));

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
  const comp = compensacaoOrcamento(o);
  const alcada = o.acima_alcada
    ? `Alçada: abaixo do mínimo da régua${aprov ? `, ${aprov}` : ' — SEM aprovação registrada'}.`
    : comp
      ? `Alçada: ${comp.itens.length === 1 ? '1 item abaixo do limite' : `${comp.itens.length} itens abaixo do limite`}, compensado no próprio orçamento (o conjunto fecha no piso ou acima), sem aprovação.`
      : `Alçada: dentro do limite do vendedor${aprov ? ` (${aprov})` : ''}.`;
  const mes = o.bolsa_pct_antes != null && o.bolsa_pct_depois != null ? ` Desconto do mês: ${pct(o.bolsa_pct_antes)} -> ${pct(o.bolsa_pct_depois)}.` : '';
  linhas.push(`${alcada} Desconto total ${pct(o.desc_pct ?? 0)}.${mes}`);
  const comDesc = (o.itens ?? []).filter((i) => Number(i.desc_pct) > 0);
  if (comDesc.length) {
    const partes = comDesc.map((i) => {
      const max = i.desc_max_pct;
      const faixa = [i.faixa, i.classe].filter(Boolean).join(' ');
      const situacao = i.acima_alcada ? 'abaixo do mínimo' : comp?.itens.includes(i.pro_codigo) ? 'compensado' : max != null && Number(i.desc_pct) > Number(max) + 1e-9 ? 'usa a bolsa' : 'ok';
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

/**
 * O Celta guarda a observação em ISO-8859-1 e a API do ERP repassa os bytes como chegam:
 * acento vira "Ã§" e o separador "Â·" na tela do ERP. Por isso a observação sai só em
 * ASCII — acentos removidos, travessão e ponto-médio viram hífen, o resto some.
 */
export const soAscii = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u00b7\u2014\u2013]/g, '-').replace(/[^\x20-\x7e\n]/g, '');

export function corpoParaCelta(o: OrcamentoParaCelta): CorpoCelta {
  const itens = (o.itens ?? []).map((i) => ({
    pro_codigo: i.pro_codigo,
    quantidade: Number(i.quantidade),
    // item com acréscimo vai pelo unitário cobrado (desconto zero); os demais, tabela + % de desconto
    unitario: Math.round(Math.max(Number(i.preco_tabela), Number(i.preco_unit ?? 0)) * 100) / 100,
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
    observacao: soAscii(obs).slice(0, OBSERVACAO_MAX),
    itens,
  };
}

/** Uma chave por orçamento da intranet: repetir a importação devolve o mesmo nº do Celta. */
export const chaveIdempotencia = (o: { id: string }) => `intranet-orc-${o.id}`;

/** Item do comparativo da api-vendas-service (as três fontes lado a lado). */
export interface ItemComparativo {
  pro_codigo: number;
  pro_descricao?: string;
  quantidade_orcamento: number | null;
  quantidade_condicional: number | null;
  quantidade_intranet: number | null;
  total_orcamento: number | null;
  total_condicional: number | null;
  total_intranet: number | null;
  quantidade_ok: boolean;
  valor_ok: boolean;
  ausente_em: string[];
  situacao: string;
}

export interface LinhaComparativo {
  total_orcamento?: number | null;
  total_condicional?: number | null;
  total_intranet?: number | null;
  itens?: ItemComparativo[];
  mensagens?: string[];
}

const FONTE_ROTULO: Record<string, string> = { orcamento: 'orçamento Celta', condicional: 'condicional', intranet: 'intranet' };
const FONTES = ['orcamento', 'condicional', 'intranet'] as const;
const reais = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtd = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 4 });

/**
 * O que NÃO bateu no comparativo orçamento Celta × condicional × intranet, em texto
 * para o aviso da gerência (uma linha por item divergente, só o que difere).
 * Mostra no máximo `limite` itens e resume o resto. Sem item divergente, devolve as
 * mensagens da API (ex.: documento que não existe numa das fontes).
 */
export function diferencasComparativo(c: LinhaComparativo, limite = 8): string {
  const linhas: string[] = [];
  const totais = FONTES.map((f) => ({ f, v: c[`total_${f}` as const] })).filter((t) => t.v != null) as Array<{ f: string; v: number }>;
  if (totais.length > 1 && totais.some((t) => Math.abs(t.v - totais[0].v) >= 0.005)) {
    linhas.push(`Total: ${totais.map((t) => `${FONTE_ROTULO[t.f]} ${reais(t.v)}`).join(' · ')}`);
  }
  const divergentes = (c.itens ?? []).filter((i) => i.situacao !== 'OK');
  for (const i of divergentes.slice(0, limite)) {
    const nome = `${i.pro_codigo}${i.pro_descricao ? ` ${i.pro_descricao.trim()}` : ''}`;
    const onde = (campo: 'quantidade' | 'total', fmt: (v: number) => string) =>
      FONTES.filter((f) => i[`${campo}_${f}`] != null).map((f) => `${FONTE_ROTULO[f]} ${fmt(i[`${campo}_${f}`] as number)}`).join(' · ');
    const partes: string[] = [];
    if (i.ausente_em?.length) partes.push(`falta no ${i.ausente_em.map((f) => FONTE_ROTULO[f] ?? f).join(' e no ')} (tem: ${onde('quantidade', (v) => `${qtd(v)} un`)})`);
    else {
      if (!i.quantidade_ok) partes.push(`quantidade: ${onde('quantidade', qtd)}`);
      if (!i.valor_ok) partes.push(`valor: ${onde('total', reais)}`);
    }
    linhas.push(`• ${nome} — ${partes.join('; ')}`);
  }
  if (divergentes.length > limite) linhas.push(`… e mais ${divergentes.length - limite} item(ns) diferente(s)`);
  if (!divergentes.length) linhas.push(...(c.mensagens ?? []));
  return linhas.join('\n') || 'Divergência sem detalhe no comparativo.';
}
