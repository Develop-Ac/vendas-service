import { absorcaoPromocao, calcularBolsa, round2 } from './regua';
import { JANELA_DIAS_PADRAO, janela, mesmaNf, type LinhaNf, type NfChave } from './ajuste-bolsa';

/* =============================================================================
   EXTRATO DA BOLSA — de onde veio cada real da bolsa do vendedor, NF a NF.
   -----------------------------------------------------------------------------
   A bolsa do mês é uma soma sobre as linhas de NF do BI. O extrato abre essa
   soma linha a linha e liga cada linha ao orçamento da intranet que a gerou,
   para comparar a bolsa prometida no orçamento com a que a NF de fato gerou.
   A ligação não existe no ERP de forma confiável (a view de vendas não traz
   orçamento) — é inferida aqui, recalculada a cada leitura, nada gravado.
   ============================================================================= */

export interface OrcParaCasar {
  id: string;
  numero: number;
  cli_codigo: number;
  rep_codigo: number;
  /** importação no Celta; sem importação, o desfecho FECHADO */
  inicio: Date;
  /** ORCAMENTOS.NFS do orçamento importado */
  nf_orcamento: NfChave | null;
  /** NF do condicional aberto a partir do orçamento (ORCAMENTOS.CONDICIONAL → CONDICIONAIS.NFS) */
  nfs_condicional: NfChave[];
  itens: { pro_codigo: number; quantidade: number; preco_unit: number; custo_ref: number | null }[];
}

export interface UnidadesCasadas {
  orcamento_id: string;
  numero: number;
  preco_unit_orc: number;
  custo_ref: number | null;
  quantidade: number;
}

/**
 * Casa orçamentos FECHADOS com as linhas de NF (quantidade sempre positiva; devolução marcada).
 * Por item, nesta ordem — a primeira que tiver linha do produto vale, como no ajuste da bolsa:
 *   1. NF gravada no orçamento do Celta;  2. NF do condicional;
 *   3. NF do mesmo cliente + vendedor, emitida do dia do início até início + `janela_dias`.
 * Sem condição de preço: o extrato quer justamente ver a NF que saiu abaixo do orçamento.
 * Cada unidade de NF casa com um orçamento só (consumo por ordem de emissão; disputa = quem
 * começou antes leva). Devolução não consome: volta para o orçamento que levou a venda do mesmo
 * cliente + produto emitida até a data da devolução, até a quantidade vendida a ele.
 */
export function casarOrcamentos(orcs: OrcParaCasar[], linhas: LinhaNf[], o: { janela_dias?: number } = {}) {
  const dias = o.janela_dias ?? JANELA_DIAS_PADRAO;
  const porEmissao = (a: number, b: number) => linhas[a].emissao.getTime() - linhas[b].emissao.getTime() || a - b;
  const livre = linhas.map((l) => l.quantidade);
  const porLinha = new Map<number, UnidadesCasadas[]>();
  const porOrcamento = new Map<string, { linha: number; quantidade: number }[]>();
  const casar = (i: number, orc: OrcParaCasar, item: OrcParaCasar['itens'][number], quantidade: number) => {
    porLinha.set(i, [...(porLinha.get(i) ?? []), { orcamento_id: orc.id, numero: orc.numero, preco_unit_orc: item.preco_unit, custo_ref: item.custo_ref, quantidade }]);
    porOrcamento.set(orc.id, [...(porOrcamento.get(orc.id) ?? []), { linha: i, quantidade }]);
  };
  const ordem = [...orcs].sort((a, b) => a.inicio.getTime() - b.inicio.getTime() || a.numero - b.numero);
  const indices = linhas.map((_, i) => i);

  for (const orc of ordem) {
    const j = janela(orc.inicio, dias);
    for (const item of orc.itens) {
      const vendas = indices.filter((i) => !linhas[i].devolucao && linhas[i].pro_codigo === item.pro_codigo);
      const candidatos = [
        orc.nf_orcamento ? vendas.filter((i) => mesmaNf(linhas[i], orc.nf_orcamento!)) : [],
        vendas.filter((i) => orc.nfs_condicional.some((n) => mesmaNf(linhas[i], n))),
        vendas.filter((i) => {
          const l = linhas[i];
          const t = l.emissao.getTime();
          return l.cli_codigo === orc.cli_codigo && l.rep_codigo === orc.rep_codigo && t >= j.inicio && t < j.fim;
        }),
      ].find((c) => c.length > 0) ?? [];
      let falta = item.quantidade;
      for (const i of candidatos.sort(porEmissao)) {
        if (falta <= 0) break;
        const q = Math.min(falta, livre[i]);
        if (q <= 0) continue;
        livre[i] -= q;
        falta -= q;
        casar(i, orc, item, q);
      }
    }
  }

  const devolvido = new Map<string, number>();
  for (const i of indices.filter((k) => linhas[k].devolucao).sort(porEmissao)) {
    const d = linhas[i];
    let resta = d.quantidade;
    for (const orc of ordem) {
      if (resta <= 0) break;
      const item = orc.cli_codigo === d.cli_codigo ? orc.itens.find((it) => it.pro_codigo === d.pro_codigo) : undefined;
      if (!item) continue;
      const chave = `${orc.id}|${d.pro_codigo}`;
      const vendida = (porOrcamento.get(orc.id) ?? [])
        .filter((c) => !linhas[c.linha].devolucao && linhas[c.linha].pro_codigo === d.pro_codigo && linhas[c.linha].emissao.getTime() <= d.emissao.getTime())
        .reduce((s, c) => s + c.quantidade, 0);
      const q = Math.min(resta, vendida - (devolvido.get(chave) ?? 0));
      if (q <= 0) continue;
      resta -= q;
      devolvido.set(chave, (devolvido.get(chave) ?? 0) + q);
      casar(i, orc, item, q);
    }
  }
  return { porLinha, porOrcamento };
}

/** Linha de NF na bolsa, valores com sinal (devolução negativa). */
export interface LinhaBolsa {
  liquido: number;
  /** custo da bolsa: o do lote de oportunidade quando houver, senão o do produto */
  custo_bolsa: number;
  custo_produto: number;
  promocao: boolean;
  servico: boolean;
  /** efetivo do ajuste da bolsa negativa atribuído à linha (estorno negativo) */
  ajuste: number;
}

/**
 * O que a linha põe na bolsa, sem arredondar (quem soma arredonda no fim, como o BI).
 * A metade da promoção usa o custo do PRODUTO e só a venda (na devolução o custo vem negativo)
 * — a mesma conta de `bolsaVendedor`, para a soma das linhas fechar com o card ao centavo.
 * Serviço fica fora da bolsa.
 */
export function valoresLinha(l: LinhaBolsa, piso: number) {
  if (l.servico) return { custo_piso: 0, absorvido: 0, ajuste: 0, saldo: 0 };
  const custo_piso = l.custo_bolsa * piso;
  const absorvido = l.promocao && l.custo_produto > 0 && l.custo_produto * piso > l.liquido ? (l.custo_produto * piso - l.liquido) / 2 : 0;
  return { custo_piso, absorvido, ajuste: l.ajuste, saldo: l.liquido - custo_piso + absorvido + l.ajuste };
}

/** Totais do extrato: Σ(líquido − custo × piso) + Σ absorvido + Σ ajuste, serviço só contado. */
export function conciliar(linhas: LinhaBolsa[], piso: number) {
  let venda = 0, custo = 0, absorvido = 0, ajuste = 0, servicos = 0;
  for (const l of linhas) {
    if (l.servico) { servicos++; continue; }
    const v = valoresLinha(l, piso);
    venda += l.liquido;
    custo += v.custo_piso;
    absorvido += v.absorvido;
    ajuste += v.ajuste;
  }
  return {
    venda_liquida: round2(venda),
    custo_piso: round2(custo),
    saldo_linhas: round2(venda - custo),
    absorvido: round2(absorvido),
    ajuste: round2(ajuste),
    saldo: round2(venda - custo + absorvido + ajuste),
    servicos_fora: servicos,
  };
}

/**
 * Põe o efetivo de cada ajuste da bolsa negativa (por NF + produto, como `casarAjustes` devolve)
 * na primeira linha de NF com a mesma chave. Ajuste sem linha correspondente fica de fora.
 */
export function atribuirAjustes(linhas: Array<NfChave & { pro_codigo: number; ajuste: number }>, ajustes: Array<NfChave & { pro_codigo: number; efetivo: number }>) {
  for (const a of ajustes) {
    const l = linhas.find((x) => x.pro_codigo === a.pro_codigo && mesmaNf(x, a));
    if (l) l.ajuste += a.efetivo;
  }
}

/**
 * Bolsa gerada nas NFs de cada orçamento: Σ do saldo das unidades casadas com ele (a fração
 * casada da linha), em qualquer mês. Orçamento sem unidade casada não entra no mapa.
 */
export function bolsaNfPorOrcamento(
  porOrcamento: Map<string, { linha: number; quantidade: number }[]>,
  linhas: Array<LinhaNf & { custo_produto: number; servico: boolean; ajuste: number }>,
  piso: number,
) {
  const saida = new Map<string, number>();
  for (const [id, casadas] of porOrcamento) {
    let soma = 0;
    for (const c of casadas) {
      const l = linhas[c.linha];
      if (!(l.quantidade > 0)) continue;
      const s = l.devolucao ? -1 : 1;
      const v = valoresLinha({ liquido: s * l.liquido, custo_bolsa: s * l.custo, custo_produto: s * l.custo_produto, promocao: l.promocao, servico: l.servico, ajuste: l.ajuste }, piso);
      soma += (c.quantidade / l.quantidade) * v.saldo;
    }
    saida.set(id, round2(soma));
  }
  return saida;
}

/**
 * Bolsa do orçamento a partir dos itens gravados: a mesma conta da projeção na tela
 * (`calcularBolsa().orcamento`) — receita sem serviço, custo da bolsa × piso, item sem custo
 * neutro, metade da promoção absorvida, ajuste da bolsa negativa que a empresa assume.
 */
export function bolsaDoOrcamento(
  itens: Array<{ pro_codigo: number; quantidade: number; preco_unit: number; total: number; custo_ref: number | null; promocao_codigo: number | null; fora_promocao: boolean }>,
  ajustes: Array<{ quantidade: number; assumido_unit: number }>,
  piso: number,
  servicos: Set<number>,
) {
  let receita = 0, custo = 0, semCusto = 0, absorvido = 0;
  for (const i of itens) {
    if (servicos.has(i.pro_codigo)) continue;
    receita += i.total;
    if (i.custo_ref != null && i.custo_ref > 0) custo += i.custo_ref * i.quantidade;
    else semCusto += i.total;
    if (i.promocao_codigo != null && !i.fora_promocao) absorvido += absorcaoPromocao(i.preco_unit, i.custo_ref, piso, i.quantidade);
  }
  return calcularBolsa({
    receita_mtd: 0, custo_mtd: 0, desconto_mtd: 0,
    receita_orc: receita, custo_orc: custo, sem_custo_orc: semCusto, absorvido_orc: absorvido,
    ajuste_orc: ajustes.reduce((s, a) => s + a.assumido_unit * a.quantidade, 0),
    piso,
  }).orcamento;
}
