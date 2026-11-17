import type { PromocaoItem } from '../orcamento/orcamento.erp.repository';
import { PROMOCAO_OFERTA } from '../orcamento/promocao-portal';
import { precoDaTabela, round2 } from '../orcamento/regua';
import { ganhoParaExibir, type Premio } from './premio';

/* =============================================================================
   OFERTAS DO ATACADO — regras puras do cadastro (promoção, liquidação, campanha).
   -----------------------------------------------------------------------------
   Grupo com nome e tipo; cada item tem preço fechado por tabela do atacado
   (preco_t2, preco_t5 — nulo = não vale para aquela tabela), datas próprias
   (AAAA-MM-DD do calendário de Cuiabá, fim inclusivo) e limite de quantidade
   opcional. Só item APROVADO vale no orçamento.

   Mínimo: liquidação e campanha, custo × piso (OFERTA_PISO, padrão 1,30);
   promoção, o preço mínimo que a régua já dá ao item naquela tabela.
   Liquidação e campanha ficam fora da bolsa do vendedor.

   Funções puras: quem lê o ERP, o banco e grava é o service.
   ============================================================================= */

export type TipoOferta = 'PROMOCAO' | 'LIQUIDACAO' | 'CAMPANHA';
export type StatusOfertaItem = 'RASCUNHO' | 'PENDENTE' | 'APROVADO' | 'ENCERRADO';
export type MotivoEncerramento = 'DATA' | 'LIMITE' | 'SALDO' | 'MANUAL';

export const foraDaBolsa = (tipo: TipoOferta | string | null | undefined) => tipo === 'LIQUIDACAO' || tipo === 'CAMPANHA';

/** 'AAAA-MM-DD' → 'dd/mm/aaaa'. */
const dataBr = (ymd: string) => ymd.split('-').reverse().join('/');

export function minimoOferta(tipo: TipoOferta, custo: number, minimoRegua: number | null, piso: number): number | null {
  return foraDaBolsa(tipo) ? round2(custo * piso) : minimoRegua;
}

export interface PrecoTabelaOferta {
  /** preço da oferta nesta tabela; nulo = a oferta não vale para ela */
  preco: number | null;
  /** preço normal do produto na tabela */
  tabela: number | null;
  /** mínimo que a régua dá ao item nesta tabela */
  minimoRegua: number | null;
}

export interface ConferenciaOferta {
  tipo: TipoOferta;
  custo: number | null;
  piso: number;
  t2: PrecoTabelaOferta;
  t5: PrecoTabelaOferta;
  inicio: string;
  fim: string;
}

/** Erros do item, um por frase; vazio = pode entrar. */
export function conferirItem(c: ConferenciaOferta): string[] {
  const erros: string[] = [];
  const custo = Number(c.custo ?? 0);
  if (!(custo > 0)) erros.push('Produto sem custo no ERP.');
  const tabelas: [string, PrecoTabelaOferta][] = [['2', c.t2], ['5', c.t5]];
  const comPreco = tabelas.filter(([, t]) => t.preco != null);
  if (!comPreco.length) erros.push('Informe o preço de ao menos uma tabela.');
  for (const [n, t] of comPreco) {
    const preco = Number(t.preco);
    const tabela = Number(t.tabela ?? 0);
    if (!(preco > 0)) { erros.push(`Preço da tabela ${n} deve ser maior que zero.`); continue; }
    if (!(tabela > 0)) { erros.push(`Produto sem preço na tabela ${n}.`); continue; }
    if (preco >= tabela) erros.push(`Preço da tabela ${n} (${preco.toFixed(2)}) deve ser menor que a tabela (${tabela.toFixed(2)}).`);
    const minimo = custo > 0 ? minimoOferta(c.tipo, custo, t.minimoRegua, c.piso) : null;
    if (minimo != null && preco < minimo) erros.push(`Preço da tabela ${n} (${preco.toFixed(2)}) abaixo do mínimo (${minimo.toFixed(2)}).`);
  }
  if (c.inicio > c.fim) erros.push('Início depois do fim.');
  return erros;
}

export interface Periodo {
  inicio: string;
  fim: string;
}

export const cruza = (a: Periodo, b: Periodo) => a.inicio <= b.fim && b.inicio <= a.fim;

export interface ItemExistente extends Periodo {
  id: number;
  pro_codigo: number;
  status: StatusOfertaItem;
  /** nome do grupo da oferta */
  grupo: string;
}

/**
 * Sobreposição: o mesmo produto não entra em duas ofertas com datas que se cruzam.
 * Conta todo item não encerrado, inclusive rascunho. Devolve a mensagem ou null.
 */
export function conflito(item: Periodo & { id?: number | null; pro_codigo: number }, outros: ItemExistente[]): string | null {
  const o = outros.find((x) => x.id !== item.id && x.pro_codigo === item.pro_codigo && x.status !== 'ENCERRADO' && cruza(item, x));
  return o ? `Produto ${o.pro_codigo} já está na oferta "${o.grupo}" de ${dataBr(o.inicio)} a ${dataBr(o.fim)}.` : null;
}

/** Preço da tabela 5 sugerido: o mesmo percentual de desconto da tabela 2, limitado ao mínimo. */
export function precoT5Sugerido(precoT2: number, tabela2: number, tabela5: number | null, minimoT5: number | null): number | null {
  if (!(Number(tabela5) > 0) || !(tabela2 > 0)) return null;
  const sugerido = round2((Number(tabela5) * precoT2) / tabela2);
  return minimoT5 != null ? Math.max(sugerido, round2(minimoT5)) : sugerido;
}

export interface ProdutoDaMarca {
  pro_codigo: number;
  descricao: string;
  custo: number | null;
  saldo: number;
  tabela_2: number | null;
  tabela_5: number | null;
  minimo_t2: number | null;
  minimo_t5: number | null;
}

/**
 * Montagem da campanha por marca: cada tabela com o desconto `pct` (fração),
 * nunca abaixo do próprio mínimo. Sem tabela 2, sem custo ou com mínimo ≥ tabela 2
 * fica de fora com o motivo; a tabela 5 sai null quando não há preço próprio ou
 * o mínimo dela ≥ tabela. `no_minimo` = algum preço encostou no mínimo.
 */
export function montarPorMarca(produtos: ProdutoDaMarca[], pct: number) {
  const incluidos: Array<ProdutoDaMarca & { preco_t2: number; preco_t5: number | null; no_minimo: boolean }> = [];
  const excluidos: Array<{ pro_codigo: number; descricao: string; motivo: string }> = [];
  const comDesconto = (tabela: number, minimo: number) => Math.max(round2(tabela * (1 - pct)), minimo);
  for (const p of produtos) {
    const sai = (motivo: string) => excluidos.push({ pro_codigo: p.pro_codigo, descricao: p.descricao, motivo });
    if (!(Number(p.tabela_2) > 0)) { sai('Produto sem preço na tabela 2.'); continue; }
    if (!(Number(p.custo) > 0) || p.minimo_t2 == null) { sai('Produto sem custo no ERP.'); continue; }
    const t2 = Number(p.tabela_2);
    if (p.minimo_t2 >= t2) { sai(`Mínimo ${p.minimo_t2.toFixed(2)} maior ou igual à tabela ${t2.toFixed(2)}.`); continue; }
    const preco_t2 = comDesconto(t2, p.minimo_t2);
    const t5 = Number(p.tabela_5);
    const preco_t5 = t5 > 0 && p.minimo_t5 != null && p.minimo_t5 < t5 ? comDesconto(t5, p.minimo_t5) : null;
    incluidos.push({ ...p, preco_t2, preco_t5, no_minimo: preco_t2 === p.minimo_t2 || (preco_t5 != null && preco_t5 === p.minimo_t5) });
  }
  return { incluidos, excluidos };
}

/** Quanto resta do limite; null = sem limite. */
export const restam = (limite: number | null, vendidas: number) => (limite == null ? null : Math.max(0, limite - vendidas));

export interface LinhaComOferta {
  item: number;
  descricao: string | null;
  quantidade: number;
  oferta_item_id: number | null;
  fora_promocao?: boolean;
}

/**
 * Limite da oferta no orçamento: soma as linhas do mesmo item de oferta (vendidas
 * fora não contam) e recusa a linha em que a soma passa do que resta. Item sem
 * limite (restam null ou ausente no mapa) passa sempre.
 */
export function excedeLimite(linhas: LinhaComOferta[], restamPorItem: Map<number, number | null>): string[] {
  const soma = new Map<number, number>();
  const erros: string[] = [];
  for (const l of linhas) {
    if (l.oferta_item_id == null || l.fora_promocao) continue;
    const r = restamPorItem.get(l.oferta_item_id);
    if (r == null) continue;
    const antes = soma.get(l.oferta_item_id) ?? 0;
    const depois = antes + Number(l.quantidade);
    soma.set(l.oferta_item_id, depois);
    if (depois > r && antes <= r) erros.push(`Item ${l.item} (${l.descricao}): restam ${r} unidades na oferta — reduza a quantidade ou venda fora da oferta.`);
  }
  return erros;
}

export interface ItemVigencia extends Periodo {
  status: StatusOfertaItem;
  limite_qtd: number | null;
}

/** Motivo para encerrar sozinho: passou do fim, atingiu o limite ou zerou o saldo. */
export function motivoEncerramento(item: ItemVigencia, hoje: string, vendidas: number, saldo: number): MotivoEncerramento | null {
  if (hoje > item.fim) return 'DATA';
  if (item.limite_qtd != null && vendidas >= item.limite_qtd) return 'LIMITE';
  if (!(saldo > 0)) return 'SALDO';
  return null;
}

/** Vigente = APROVADO, hoje entre início e fim, vendidas < limite e saldo > 0. */
export const vigente = (item: ItemVigencia, hoje: string, vendidas: number, saldo: number) =>
  item.status === 'APROVADO' && item.inicio <= hoje && motivoEncerramento(item, hoje, vendidas, saldo) == null;

export interface ItemEditavel extends Periodo {
  preco_t2: number | null;
  preco_t5: number | null;
  limite_qtd: number | null;
}

const num = (v: number | null) => (v == null ? null : Number(v));

/** Mudou preço, datas ou limite: item aprovado volta para aprovação. */
export const reaprova = (antes: ItemEditavel, depois: ItemEditavel) =>
  num(antes.preco_t2) !== num(depois.preco_t2) ||
  num(antes.preco_t5) !== num(depois.preco_t5) ||
  num(antes.limite_qtd) !== num(depois.limite_qtd) ||
  antes.inicio !== depois.inicio ||
  antes.fim !== depois.fim;

/**
 * Preço da oferta para o cliente: o da tabela de onde veio o preço normal dele
 * (PRECO2 → preco_t2, PRECO5 → preco_t5; tabela por substituição segue a coluna).
 * Outra coluna, preço nulo ou oferta que não fica abaixo do preço normal → null.
 */
export function precoDaOferta(item: { preco_t2: number | null; preco_t5: number | null }, coluna: string, precoNormal: number): number | null {
  const preco = coluna === 'PRECO2' ? item.preco_t2 : coluna === 'PRECO5' ? item.preco_t5 : null;
  return preco != null && Number(preco) > 0 && Number(preco) < precoNormal ? Number(preco) : null;
}

/** Item aprovado lido para o orçamento: com tipo, nome do grupo e o que já foi vendido nele. */
export interface OfertaParaOrcamento extends ItemVigencia {
  id: number;
  pro_codigo: number;
  preco_t2: number | null;
  preco_t5: number | null;
  tipo: TipoOferta;
  grupo: string;
  vendidas: number;
  /** prêmio do vendedor no grupo (liquidação e campanha); null = sem prêmio */
  premio: Premio | null;
}

/**
 * Soma ao mapa de promoções as ofertas vigentes da intranet. Produto que já
 * está no mapa (promoção do portal congelada no orçamento) fica como está.
 * O preço sai da coluna de onde vem o preço normal do cliente (precoDaTabela,
 * com a substituição do atacado); oferta que não fica abaixo dele não entra.
 * Liquidação e campanha levam o ganho do vendedor por unidade (e a próxima
 * faixa), calculado sobre o custo do ERP e o preço da oferta.
 */
export function comOfertas(
  promos: Map<number, PromocaoItem>,
  ofertas: OfertaParaOrcamento[],
  produtos: Array<{ PRO_CODIGO: number; ESTOQUE_DISPONIVEL: number; PRECO_CUSTO?: number | null }>,
  tabelaPreco: string | null,
  hoje: string,
) {
  for (const p of produtos) {
    if (promos.has(p.PRO_CODIGO)) continue;
    const o = ofertas.find((x) => x.pro_codigo === p.PRO_CODIGO && vigente(x, hoje, x.vendidas, Number(p.ESTOQUE_DISPONIVEL)));
    if (!o) continue;
    const normal = precoDaTabela(p as unknown as Record<string, unknown>, tabelaPreco);
    const valor = precoDaOferta(o, normal.coluna, normal.preco);
    if (valor == null) continue;
    const ganho = foraDaBolsa(o.tipo) ? ganhoParaExibir(o.premio, { custo: p.PRECO_CUSTO ?? null, preco: valor }) : null;
    promos.set(p.PRO_CODIGO, {
      pro_codigo: p.PRO_CODIGO,
      prom_codigo: PROMOCAO_OFERTA,
      descricao: o.grupo,
      data_final: o.fim,
      somente_avista: false,
      durar_estoque: false,
      valor,
      valor_balcao: null,
      oferta: { item_id: o.id, tipo: o.tipo, restam: restam(o.limite_qtd, o.vendidas), ...(ganho ?? {}) },
    });
  }
  return promos;
}
