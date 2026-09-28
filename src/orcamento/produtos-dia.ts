/* =============================================================================
   PRODUTOS DO DIA — o que o supervisor do atacado empurra hoje.
   -----------------------------------------------------------------------------
   Só lotes de compra de oportunidade abertos entram: a lista existe para realizar
   a bolsa reservada pela empresa. Cada lote vira uma linha por chave de item (o
   grupo de equivalentes da análise de estoque; sem grupo, o próprio produto) e a
   ordem é "quanto de bolsa esse item pode gerar hoje":

     score = bolsa do vendedor por unidade × demanda esperada do dia
     demanda esperada = giro médio diário no atacado + Σ qtd por compra dos
                        clientes no ponto de recomprar (analytics)

   Estoque é filtro, não peso: o que resta do lote (já limitado ao disponível ao
   vivo) precisa cobrir N dias da demanda média de todos os canais e ficar acima
   do ponto de pedido — senão o item some da lista e fica registrado como "de fora
   por estoque", para compras saber que há lote encalhado sem produto.
   ============================================================================= */

export interface LoteProdutoDia {
  id: number;
  pro_codigo: number;
  descricao: string | null;
  /** parte do vendedor na sobra, por unidade a preço de tabela */
  vendedor: number;
  /** o que resta do lote, já limitado ao estoque disponível */
  restante: number;
  estoque_disponivel: number | null;
}

export interface GiroProdutoDia {
  grupo_chave: string | null;
  /** demanda média diária de todos os canais (análise de estoque, foto semanal) */
  demanda_media_dia: number | null;
  /** ponto de pedido sugerido pela análise de estoque */
  estoque_min_sugerido: number | null;
}

export interface ClienteDevido {
  cli_codigo: number;
  cli_nome: string | null;
  cidade: string | null;
  uf: string | null;
  rep_codigo: number | null;
  rep_nome?: string | null;
  dias_sem_compra: number | null;
  qtd_por_compra: number | null;
  proxima_esperada: string | null;
  status: string | null;
}

export type MotivoFora = 'COBERTURA' | 'PONTO_PEDIDO';

export interface ItemProdutoDia {
  posicao: number | null;
  lote_id: number;
  pro_codigo: number;
  descricao: string | null;
  grupo_chave: string | null;
  chave_item: string;
  bolsa_unidade: number;
  giro_dia: number;
  demanda_clientes: number;
  demanda_esperada: number;
  score: number;
  estoque_considerado: number;
  estoque_disponivel: number | null;
  restante_lote: number;
  cobertura_dias: number | null;
  estoque_min: number | null;
  clientes: ClienteDevido[];
  clientes_total: number;
  motivo_fora: MotivoFora | null;
}

export interface ConfigProdutosDia {
  coberturaDias: number;
  limite: number;
  maxClientes: number;
}

export const CONFIG_PADRAO: ConfigProdutosDia = { coberturaDias: 15, limite: 15, maxClientes: 5 };

export const chaveItem = (pro: number, grupoChave: string | null | undefined) => (grupoChave ? `G:${grupoChave}` : `P:${pro}`);

const r2 = (v: number) => Math.round(v * 100) / 100;

export function montarProdutosDia(
  lotes: LoteProdutoDia[],
  giro: Map<number, GiroProdutoDia>,
  /** giro médio diário no ATACADO por produto (analytics); ausente = usa a demanda de todos os canais */
  giroAtacado: Map<number, number>,
  devidos: Map<string, ClienteDevido[]>,
  cfg: ConfigProdutosDia = CONFIG_PADRAO,
): { itens: ItemProdutoDia[]; fora: ItemProdutoDia[] } {
  const candidatos: ItemProdutoDia[] = [];
  const fora: ItemProdutoDia[] = [];

  for (const l of lotes) {
    if (l.restante <= 0) continue;
    const g = giro.get(l.pro_codigo);
    const chave = chaveItem(l.pro_codigo, g?.grupo_chave);
    const demandaTodos = g?.demanda_media_dia ?? 0;
    const estoque = l.restante;
    const cobertura = demandaTodos > 0 ? estoque / demandaTodos : null;
    const estoqueMin = g?.estoque_min_sugerido ?? null;
    const clientes = devidos.get(chave) ?? [];
    const demandaClientes = clientes.reduce((s, c) => s + (c.qtd_por_compra ?? 1), 0);
    const giroDia = giroAtacado.get(l.pro_codigo) ?? demandaTodos;
    const demandaEsperada = giroDia + demandaClientes;
    const item: ItemProdutoDia = {
      posicao: null,
      lote_id: l.id,
      pro_codigo: l.pro_codigo,
      descricao: l.descricao,
      grupo_chave: g?.grupo_chave ?? null,
      chave_item: chave,
      bolsa_unidade: l.vendedor,
      giro_dia: r2(giroDia),
      demanda_clientes: r2(demandaClientes),
      demanda_esperada: r2(demandaEsperada),
      score: r2(l.vendedor * demandaEsperada),
      estoque_considerado: estoque,
      estoque_disponivel: l.estoque_disponivel,
      restante_lote: l.restante,
      cobertura_dias: cobertura == null ? null : Math.round(cobertura),
      estoque_min: estoqueMin,
      clientes: clientes.slice(0, cfg.maxClientes),
      clientes_total: clientes.length,
      motivo_fora: null,
    };
    if (cobertura != null && cobertura < cfg.coberturaDias) item.motivo_fora = 'COBERTURA';
    else if (estoqueMin != null && estoque <= estoqueMin) item.motivo_fora = 'PONTO_PEDIDO';
    (item.motivo_fora ? fora : candidatos).push(item);
  }

  // uma linha por chave de item: fica o lote de maior bolsa por unidade
  const porChave = new Map<string, ItemProdutoDia>();
  for (const c of candidatos) {
    const atual = porChave.get(c.chave_item);
    if (!atual || c.bolsa_unidade > atual.bolsa_unidade) porChave.set(c.chave_item, c);
  }
  const itens = [...porChave.values()]
    .sort((a, b) => b.score - a.score || b.bolsa_unidade - a.bolsa_unidade || a.pro_codigo - b.pro_codigo)
    .slice(0, cfg.limite)
    .map((it, i) => ({ ...it, posicao: i + 1 }));
  return { itens, fora };
}
