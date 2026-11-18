import { LinhaNf } from '../orcamento/ajuste-bolsa';
import { diaLocal, UnidadesCasadas } from '../orcamento/extrato-bolsa';
import { round2 } from '../orcamento/regua';
import { Periodo, TipoOferta } from './oferta';
import { OrigemOferta, Premio, premioDoVendedor, situacaoDaCampanha, valorNaFaixa } from './premio';

/* =============================================================================
   APURAÇÃO DOS GANHOS DAS OFERTAS — regras puras.
   -----------------------------------------------------------------------------
   Conta a venda faturada casada (orçamento ↔ NF) com item de oferta. Devolução
   entra negativa. Unidade sem item de oferta não gera ganho; promoção não tem prêmio.
   - Liquidação: o tipo e o % sobre o custo são do ITEM (um grupo de padrão promoção
     pode ter item de liquidação); bônus das notas emitidas dentro do mês comissional.
   - Campanha: prêmio sobre todas as vendas do vendedor na campanha, pago no mês
     comissional em que cai o fim (PAGAR); antes disso aparece "em andamento",
     fora do total.
   - Fornecedores: campanhas de origem FORNECEDOR pagas no mês = valor a cobrar.
   ============================================================================= */

export interface VendaOferta {
  rep_codigo: number;
  oferta_id: number;
  oferta_item_id: number;
  pro_codigo: number;
  empresa: number;
  serie: string;
  nfs: number;
  /** AAAA-MM-DD */
  emissao: string;
  devolucao: boolean;
  /** Negativa na devolução. */
  quantidade: number;
  /** Fração casada do líquido da linha; negativo na devolução. */
  liquido: number;
  custo_ref: number | null;
}

export interface GrupoGanho extends Periodo {
  id: number;
  nome: string;
  tipo: TipoOferta;
  origem: OrigemOferta | null;
  fornecedor_codigo: number | null;
  fornecedor_nome: string | null;
  /** Prêmio do grupo: só a campanha usa. */
  premio: Premio | null;
  itens: Array<{ id: number; tipo: TipoOferta; premio_valor: number | null }>;
}

/** Itens de liquidação do grupo (fora da campanha) com o prêmio do próprio item. */
const liquidacoes = (grupo: GrupoGanho) =>
  new Map(
    grupo.tipo === 'CAMPANHA'
      ? []
      : grupo.itens.filter((i) => i.tipo === 'LIQUIDACAO').map((i) => [i.id, { tipo: 'PCT_CUSTO' as const, valor: i.premio_valor ?? 0, faixas: [] }]),
  );

export type SituacaoGanho = 'PAGAR' | 'ANDAMENTO';

/**
 * Item que entra no período (início/fim) do grupo: tudo fora do rascunho. O aprovado
 * editado volta a PENDENTE e segue contando — as vendas dele continuam casadas com o
 * item, e o fim da campanha (mês do pagamento) não pode recuar enquanto ele é reaprovado.
 */
export const contaNoPeriodo = (i: { status: string }) => i.status !== 'RASCUNHO';

/** Vendas do vendedor que saíram de item de oferta (`ofertaDoItem`: item → grupo). */
export function vendasDaOferta(
  rep: number,
  linhas: LinhaNf[],
  porLinha: Map<number, UnidadesCasadas[]>,
  ofertaDoItem: Map<number, number>,
): VendaOferta[] {
  const vendas: VendaOferta[] = [];
  linhas.forEach((l, i) => {
    const s = l.devolucao ? -1 : 1;
    for (const u of porLinha.get(i) ?? []) {
      const oferta_id = u.oferta_item_id != null ? ofertaDoItem.get(u.oferta_item_id) : undefined;
      if (oferta_id == null || !l.quantidade) continue;
      vendas.push({
        rep_codigo: rep,
        oferta_id,
        oferta_item_id: u.oferta_item_id!,
        pro_codigo: l.pro_codigo,
        empresa: l.empresa,
        serie: l.serie,
        nfs: l.nfs,
        emissao: diaLocal(l.emissao),
        devolucao: l.devolucao,
        quantidade: s * u.quantidade,
        liquido: s * round2((u.quantidade / l.quantidade) * l.liquido),
        custo_ref: u.custo_ref,
      });
    }
  });
  return vendas;
}

const somaQtd = (vs: VendaOferta[]) => vs.reduce((s, v) => s + v.quantidade, 0);

/**
 * Prêmio do vendedor (`premioDoVendedor`) repartido pelas linhas na proporção da conta
 * crua de cada uma (na campanha, a faixa vem da quantidade total); o centavo que sobra
 * do arredondamento vai na última linha, para as NFs fecharem com o total. Campanha
 * que ficou no piso zero mostra as linhas zeradas.
 */
function ganhosDasLinhas(premio: Premio, vs: VendaOferta[]): { total: number; linhas: number[] } {
  const total = premioDoVendedor(premio, vs);
  const faixa = valorNaFaixa(premio, somaQtd(vs));
  const cru = vs.map((v) =>
    premio.tipo === 'PCT_CUSTO' ? v.quantidade * Number(v.custo_ref ?? 0) * premio.valor : faixa * (premio.tipo === 'VALOR_UNIDADE' ? v.quantidade : v.liquido),
  );
  const soma = cru.reduce((s, x) => s + x, 0);
  const linhas = cru.map((x) => round2(soma ? (x * total) / soma : 0));
  if (linhas.length) linhas[linhas.length - 1] = round2(total - linhas.slice(0, -1).reduce((s, x) => s + x, 0));
  return { total, linhas };
}
const porChave = <T>(vs: T[], k: (v: T) => number) => {
  const m = new Map<number, T[]>();
  for (const v of vs) m.set(k(v), [...(m.get(k(v)) ?? []), v]);
  return m;
};

export interface LinhaGanho {
  nfs: number;
  empresa: number;
  serie: string;
  emissao: string;
  devolucao: boolean;
  pro_codigo: number;
  oferta_item_id: number;
  quantidade: number;
  oferta_id: number;
  grupo: string;
  tipo: TipoOferta;
  ganho: number;
  situacao: SituacaoGanho;
}

export interface GanhoVendedor {
  rep_codigo: number;
  bonus_liquidacao: number;
  premios_campanha: number;
  total: number;
  em_andamento: number;
  linhas: LinhaGanho[];
}

export interface GanhoFornecedor {
  fornecedor_codigo: number;
  fornecedor_nome: string | null;
  unidades: number;
  valor: number;
  campanhas: Array<{ oferta_id: number; grupo: string; unidades: number; valor: number }>;
}

/** Ganhos do mês comissional por vendedor e o que cobrar de cada fornecedor. */
export function apurarGanhos(
  grupos: GrupoGanho[],
  vendas: VendaOferta[],
  mes: Periodo,
  hoje: string,
): { vendedores: GanhoVendedor[]; fornecedores: GanhoFornecedor[] } {
  const reps = new Map<number, GanhoVendedor>();
  const doRep = (rep: number) => {
    let g = reps.get(rep);
    if (!g) reps.set(rep, (g = { rep_codigo: rep, bonus_liquidacao: 0, premios_campanha: 0, total: 0, em_andamento: 0, linhas: [] }));
    return g;
  };
  const fornecedores = new Map<number, GanhoFornecedor>();
  const vendasDoGrupo = porChave(vendas, (v) => v.oferta_id);

  for (const grupo of grupos) {
    const doGrupo = vendasDoGrupo.get(grupo.id) ?? [];
    const linha = (v: VendaOferta, ganho: number, situacao: SituacaoGanho, tipo: TipoOferta = grupo.tipo): LinhaGanho => ({
      nfs: v.nfs, empresa: v.empresa, serie: v.serie, emissao: v.emissao, devolucao: v.devolucao,
      pro_codigo: v.pro_codigo, oferta_item_id: v.oferta_item_id, quantidade: v.quantidade,
      oferta_id: grupo.id, grupo: grupo.nome, tipo, ganho, situacao,
    });

    if (grupo.tipo !== 'CAMPANHA') {
      const liq = liquidacoes(grupo);
      const doMes = doGrupo.filter((v) => liq.has(v.oferta_item_id) && v.emissao >= mes.inicio && v.emissao <= mes.fim);
      for (const [rep, vsRep] of porChave(doMes, (v) => v.rep_codigo)) {
        const g = doRep(rep);
        for (const [item, vs] of porChave(vsRep, (v) => v.oferta_item_id)) {
          const r = ganhosDasLinhas(liq.get(item)!, vs);
          g.bonus_liquidacao = round2(g.bonus_liquidacao + r.total);
          g.linhas.push(...vs.map((v, k) => linha(v, r.linhas[k], 'PAGAR', 'LIQUIDACAO')));
        }
      }
      continue;
    }

    const premio = grupo.premio;
    if (!premio) continue;

    const situacao = situacaoDaCampanha(grupo, mes, hoje);
    if (!situacao) continue;
    let unidades = 0;
    let valor = 0;
    for (const [rep, vs] of porChave(doGrupo, (v) => v.rep_codigo)) {
      const qtd = somaQtd(vs);
      const { total: premioRep, linhas } = ganhosDasLinhas(premio, vs);
      const g = doRep(rep);
      if (situacao === 'PAGAR') g.premios_campanha = round2(g.premios_campanha + premioRep);
      else g.em_andamento = round2(g.em_andamento + premioRep);
      g.linhas.push(...vs.map((v, k) => linha(v, linhas[k], situacao)));
      unidades += qtd;
      valor = round2(valor + premioRep);
    }
    if (situacao === 'PAGAR' && grupo.origem === 'FORNECEDOR' && grupo.fornecedor_codigo != null) {
      let f = fornecedores.get(grupo.fornecedor_codigo);
      if (!f) {
        f = { fornecedor_codigo: grupo.fornecedor_codigo, fornecedor_nome: grupo.fornecedor_nome, unidades: 0, valor: 0, campanhas: [] };
        fornecedores.set(grupo.fornecedor_codigo, f);
      }
      f.unidades += unidades;
      f.valor = round2(f.valor + valor);
      f.campanhas.push({ oferta_id: grupo.id, grupo: grupo.nome, unidades, valor });
    }
  }

  const vendedores = [...reps.values()].map((g) => ({ ...g, total: round2(g.bonus_liquidacao + g.premios_campanha) }));
  return { vendedores, fornecedores: [...fornecedores.values()] };
}

/**
 * Faturado por item e ganho de cada vendedor no grupo inteiro. Fora da campanha, o ganho
 * vem só dos itens de liquidação, cada um com o seu %; grupo sem eles = sem vendedores.
 */
export function resultadoDoGrupo(
  grupo: GrupoGanho,
  vendas: VendaOferta[],
  hoje: string,
): {
  faturado: Array<{ oferta_item_id: number; pro_codigo: number; quantidade: number; valor: number }>;
  vendedores: Array<{ rep_codigo: number; quantidade: number; valor: number; ganho: number; situacao: SituacaoGanho }>;
} {
  const doGrupo = vendas.filter((v) => v.oferta_id === grupo.id);
  const valor = (vs: VendaOferta[]) => round2(vs.reduce((s, v) => s + v.liquido, 0));
  const faturado = [...porChave(doGrupo, (v) => v.oferta_item_id)].map(([oferta_item_id, vs]) => ({
    oferta_item_id,
    pro_codigo: vs[0].pro_codigo,
    quantidade: somaQtd(vs),
    valor: valor(vs),
  }));
  if (grupo.tipo !== 'CAMPANHA') {
    const liq = liquidacoes(grupo);
    const vendedores = [...porChave(doGrupo.filter((v) => liq.has(v.oferta_item_id)), (v) => v.rep_codigo)].map(([rep_codigo, vs]) => ({
      rep_codigo,
      quantidade: somaQtd(vs),
      valor: valor(vs),
      ganho: round2([...porChave(vs, (v) => v.oferta_item_id)].reduce((s, [item, vi]) => s + premioDoVendedor(liq.get(item)!, vi), 0)),
      situacao: 'PAGAR' as SituacaoGanho,
    }));
    return { faturado, vendedores };
  }
  const premio = grupo.premio;
  if (!premio) return { faturado, vendedores: [] };
  const situacao: SituacaoGanho = hoje > grupo.fim ? 'PAGAR' : 'ANDAMENTO';
  const vendedores = [...porChave(doGrupo, (v) => v.rep_codigo)].map(([rep_codigo, vs]) => ({
    rep_codigo,
    quantidade: somaQtd(vs),
    valor: valor(vs),
    ganho: premioDoVendedor(premio, vs),
    situacao,
  }));
  return { faturado, vendedores };
}
