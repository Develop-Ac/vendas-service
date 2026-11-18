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

/** Nível adicional do preço progressivo: a partir dessa quantidade, o preço de cada tabela. */
export type NivelOferta = { a_partir_de: number; preco_t2: number | null; preco_t5: number | null };

export interface ConferenciaOferta {
  tipo: TipoOferta;
  pro_codigo: number;
  /** agarradinho: produto par (null = sem par) e unidades liberadas por unidade do par */
  par_pro_codigo: number | null;
  par_proporcao: number | null;
  /** quantidade do primeiro nível (preço = o da tabela) */
  qtd_minima: number;
  /** até 2 níveis adicionais, quantidade crescente e preço decrescente */
  niveis: NivelOferta[];
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
  const qtdMinima = Number(c.qtd_minima);
  if (!(qtdMinima >= 1)) erros.push('Quantidade do primeiro nível deve ser ao menos 1.');
  if (c.niveis.length > 2) erros.push('No máximo 2 níveis além do primeiro.');
  c.niveis.forEach((nv, k) => {
    const anterior = k ? Number(c.niveis[k - 1].a_partir_de) : qtdMinima;
    if (!(Number(nv.a_partir_de) > anterior)) erros.push(`Nível ${k + 2}: a quantidade (${nv.a_partir_de}) deve ser maior que a do nível anterior (${anterior}).`);
  });
  for (const [n, t] of tabelas) {
    const campo = n === '2' ? 'preco_t2' : 'preco_t5';
    let anterior = t.preco != null ? Number(t.preco) : null;
    const minimo = custo > 0 && anterior != null ? minimoOferta(c.tipo, custo, t.minimoRegua, c.piso) : null;
    c.niveis.forEach((nv, k) => {
      const preco = nv[campo] == null ? null : Number(nv[campo]);
      if (anterior == null) {
        if (t.preco == null && preco != null) erros.push(`Nível ${k + 2} com preço na tabela ${n}, que não tem preço na oferta.`);
        return;
      }
      if (preco == null) erros.push(`Nível ${k + 2} sem preço na tabela ${n}.`);
      else if (preco >= anterior) erros.push(`Nível ${k + 2}: preço da tabela ${n} (${preco.toFixed(2)}) deve ser menor que o do nível anterior (${anterior.toFixed(2)}).`);
      else if (minimo != null && preco < minimo) erros.push(`Nível ${k + 2}: preço da tabela ${n} (${preco.toFixed(2)}) abaixo do mínimo (${minimo.toFixed(2)}).`);
      if (preco != null) anterior = preco;
    });
  }
  if (c.par_pro_codigo != null) {
    if (c.par_pro_codigo === c.pro_codigo) erros.push('O par não pode ser o próprio produto.');
    if (!(Number(c.par_proporcao) > 0)) erros.push('Proporção do par deve ser maior que zero.');
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
export const msgLimite = (l: LinhaComOferta, r: number) =>
  `Item ${l.item} (${l.descricao}): restam ${r} unidades na oferta — reduza a quantidade ou venda fora da oferta.`;

/** Recusa do máximo por cliente; recebe o teto de cada item. */
export const msgTeto = (teto: Map<number, number | null>) => (l: LinhaComOferta, r: number) =>
  `Item ${l.item} (${l.descricao}): máximo de ${teto.get(l.oferta_item_id!)} por cliente na oferta — restam ${r} para este cliente; reduza a quantidade ou venda fora da oferta.`;

/** Recusa do agarradinho; recebe o par de cada item. */
export const msgPar = (par: Map<number, { pro_codigo: number; descricao: string | null }>) => (l: LinhaComOferta, r: number) =>
  `Item ${l.item} (${l.descricao}): o par ${par.get(l.oferta_item_id!)?.pro_codigo} (${par.get(l.oferta_item_id!)?.descricao}) libera ${r} unidades na oferta — inclua mais do par ou reduza a quantidade.`;

/** Unidades que o par libera: soma de todas as linhas do produto par × proporção; null = sem par. */
export function liberadoPeloPar(linhas: { pro_codigo: number; quantidade: number }[], par: { pro_codigo: number; proporcao: number } | null): number | null {
  if (!par) return null;
  return linhas.reduce((s, l) => s + (Number(l.pro_codigo) === par.pro_codigo ? Number(l.quantidade) : 0), 0) * par.proporcao;
}

export function excedeLimite(
  linhas: LinhaComOferta[],
  restamPorItem: Map<number, number | null>,
  mensagem: (l: LinhaComOferta, restam: number) => string = msgLimite,
): string[] {
  const soma = new Map<number, number>();
  const erros: string[] = [];
  for (const l of linhas) {
    if (l.oferta_item_id == null || l.fora_promocao) continue;
    const r = restamPorItem.get(l.oferta_item_id);
    if (r == null) continue;
    const antes = soma.get(l.oferta_item_id) ?? 0;
    const depois = antes + Number(l.quantidade);
    soma.set(l.oferta_item_id, depois);
    if (depois > r && antes <= r) erros.push(mensagem(l, r));
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
  /** tipo do item; no grupo de campanha é sempre CAMPANHA */
  tipo: TipoOferta;
  /** bônus da liquidação, fração do custo; nulo nos outros tipos */
  premio_valor: number | null;
  /** máximo por cliente (soma dos orçamentos fechados do cliente); null = sem teto */
  limite_cliente: number | null;
  /** quantidade do primeiro nível do preço progressivo */
  qtd_minima: number;
  /** níveis adicionais do preço progressivo (até 2) */
  niveis: NivelOferta[];
  /** agarradinho: produto par (null = sem venda casada), descrição copiada do ERP e proporção */
  par_pro_codigo: number | null;
  par_descricao: string | null;
  par_proporcao: number | null;
}

const num = (v: number | null) => (v == null ? null : Number(v));

/** Níveis iguais campo a campo (o jsonb do Postgres reordena as chaves, então não dá para comparar o texto). */
const mesmosNiveis = (a: NivelOferta[] | null, b: NivelOferta[] | null) => {
  const x = a ?? [];
  const y = b ?? [];
  return (
    x.length === y.length &&
    x.every(
      (n, i) =>
        num(n.a_partir_de) === num(y[i].a_partir_de) &&
        num(n.preco_t2) === num(y[i].preco_t2) &&
        num(n.preco_t5) === num(y[i].preco_t5),
    )
  );
};

/** Mudou preço, níveis, par, datas, limite, tipo ou bônus: item aprovado volta para aprovação. */
export const reaprova = (antes: ItemEditavel, depois: ItemEditavel) =>
  antes.tipo !== depois.tipo ||
  num(antes.premio_valor) !== num(depois.premio_valor) ||
  num(antes.preco_t2) !== num(depois.preco_t2) ||
  num(antes.preco_t5) !== num(depois.preco_t5) ||
  num(antes.limite_qtd) !== num(depois.limite_qtd) ||
  num(antes.limite_cliente) !== num(depois.limite_cliente) ||
  num(antes.qtd_minima) !== num(depois.qtd_minima) ||
  !mesmosNiveis(antes.niveis, depois.niveis) ||
  (antes.par_pro_codigo ?? null) !== (depois.par_pro_codigo ?? null) ||
  num(antes.par_proporcao) !== num(depois.par_proporcao) ||
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

/**
 * Preço progressivo: abaixo de qtdMinima → null (fora da oferta); senão o preço do maior
 * nível alcançado pela quantidade (níveis em ordem crescente de a_partir_de, já conferidos).
 */
export function precoNoNivel(precoBase: number, qtdMinima: number, niveis: { a_partir_de: number; preco: number }[], qtd: number): number | null {
  if (qtd < qtdMinima) return null;
  let preco = precoBase;
  for (const nv of niveis) if (qtd >= nv.a_partir_de) preco = nv.preco;
  return preco;
}

/** Níveis adicionais do item na tabela do cliente (mesma escolha de precoDaOferta), só os com preço. */
export function niveisDaTabela(item: { niveis: NivelOferta[] }, coluna: string, precoNormal: number): { a_partir_de: number; preco: number }[] {
  return item.niveis.flatMap((nv) => {
    const preco = precoDaOferta(nv, coluna, precoNormal);
    return preco == null ? [] : [{ a_partir_de: Number(nv.a_partir_de), preco }];
  });
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
  limite_cliente: number | null;
  qtd_minima: number;
  niveis: NivelOferta[];
  par_pro_codigo: number | null;
  par_descricao: string | null;
  par_proporcao: number | null;
  /** já fechado pelo cliente do orçamento neste item (0 sem cliente) */
  vendidas_cliente: number;
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
 * Agarradinho: oferta com par sem saldo (saldoPar, empresa 3) deixa de valer
 * enquanto faltar o par, sem encerrar; com saldo, leva o par.
 */
export function comOfertas(
  promos: Map<number, PromocaoItem>,
  ofertas: OfertaParaOrcamento[],
  produtos: Array<{ PRO_CODIGO: number; ESTOQUE_DISPONIVEL: number; PRECO_CUSTO?: number | null }>,
  tabelaPreco: string | null,
  hoje: string,
  saldoPar: Map<number, number> = new Map(),
) {
  for (const p of produtos) {
    if (promos.has(p.PRO_CODIGO)) continue;
    const o = ofertas.find((x) => x.pro_codigo === p.PRO_CODIGO && vigente(x, hoje, x.vendidas, Number(p.ESTOQUE_DISPONIVEL)));
    if (o?.par_pro_codigo != null && !((saldoPar.get(o.par_pro_codigo) ?? 0) > 0)) continue;
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
      oferta: { item_id: o.id, tipo: o.tipo, restam: restam(o.limite_qtd, o.vendidas),
        limite_cliente: o.limite_cliente,
        restam_cliente: restam(o.limite_cliente, o.vendidas_cliente),
        qtd_minima: Number(o.qtd_minima ?? 1),
        niveis: niveisDaTabela({ niveis: o.niveis ?? [] }, normal.coluna, normal.preco),
        par: o.par_pro_codigo != null ? { pro_codigo: o.par_pro_codigo, descricao: o.par_descricao, proporcao: Number(o.par_proporcao ?? 1) } : null,
        ...(ganho ?? {}) },
    });
  }
  return promos;
}

/** Condição do item de oferta no orçamento: preço do primeiro nível, níveis na tabela do cliente e o par. */
export interface CondicaoOferta {
  item_id: number;
  preco: number;
  qtd_minima: number;
  niveis: { a_partir_de: number; preco: number }[];
  par: { pro_codigo: number; proporcao: number } | null;
}

/**
 * Preço de cada item de oferta no orçamento: a quantidade do item é a soma das
 * linhas com aquele oferta_item_id (quem vende fora manda a linha sem ele) e o
 * preço é o do nível alcançado; null = abaixo do primeiro nível, linha fora da oferta.
 * `liberado` = unidades que o par libera (qualquer linha do produto par conta, e as
 * mesmas unidades liberam cada oferta que aponte para ele); liberado 0 = fora da oferta.
 */
export function resolverCondicoes(
  linhas: { pro_codigo: number; quantidade: number; oferta_item_id: number | null }[],
  condicoes: CondicaoOferta[],
): Map<number, { preco: number | null; liberado: number | null }> {
  const qtd = new Map<number, number>();
  for (const l of linhas) if (l.oferta_item_id != null) qtd.set(l.oferta_item_id, (qtd.get(l.oferta_item_id) ?? 0) + Number(l.quantidade));
  return new Map(
    condicoes.map((c) => {
      const liberado = liberadoPeloPar(linhas, c.par);
      const preco = liberado === 0 ? null : precoNoNivel(c.preco, c.qtd_minima, c.niveis, qtd.get(c.item_id) ?? 0);
      return [c.item_id, { preco, liberado }];
    }),
  );
}
