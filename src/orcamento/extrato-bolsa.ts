import { foraDaBolsa } from '../oferta/oferta';
import { absorcaoPromocao, calcularBolsa, corteNaData, round2, tetoLinha, type TetoBolsa } from './regua';
import { JANELA_DIAS_PADRAO, janela, mesmaNf, type LinhaNf, type NfChave } from './ajuste-bolsa';
import { fracaoCasada } from './promocao-portal';

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
  /**
   * `promo_portal`: item em promoção do portal B2B (não vendido fora dela).
   * `fora_bolsa`: item em liquidação/campanha da intranet (não vendido fora dela).
   * `oferta_item_id`: item da oferta (liquidação/campanha) de que a linha saiu, se não vendida fora dela.
   */
  itens: { pro_codigo: number; quantidade: number; preco_unit: number; custo_ref: number | null; promo_portal?: boolean; fora_bolsa?: boolean; oferta_item_id?: number | null }[];
}

export interface UnidadesCasadas {
  orcamento_id: string;
  numero: number;
  preco_unit_orc: number;
  custo_ref: number | null;
  quantidade: number;
  /** A unidade saiu de item em promoção do portal B2B. */
  promo_portal?: boolean;
  /** A unidade saiu de item em liquidação/campanha da intranet: fica fora da bolsa. */
  fora_bolsa?: boolean;
  /** Item da oferta de que a unidade saiu (apuração dos ganhos da campanha). */
  oferta_item_id?: number;
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
  const porOrcamento = new Map<string, { linha: number; quantidade: number; promo_portal?: boolean; fora_bolsa?: boolean }[]>();
  const casar = (i: number, orc: OrcParaCasar, item: OrcParaCasar['itens'][number], quantidade: number) => {
    const marcas = { ...(item.promo_portal && { promo_portal: true }), ...(item.fora_bolsa && { fora_bolsa: true }), ...(item.oferta_item_id != null && { oferta_item_id: item.oferta_item_id }) };
    porLinha.set(i, [...(porLinha.get(i) ?? []), { orcamento_id: orc.id, numero: orc.numero, preco_unit_orc: item.preco_unit, custo_ref: item.custo_ref, quantidade, ...marcas }]);
    porOrcamento.set(orc.id, [...(porOrcamento.get(orc.id) ?? []), { linha: i, quantidade, ...marcas }]);
  };
  const vendidoDoItem = new Map<OrcParaCasar['itens'][number], { linha: number; quantidade: number }[]>();
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
        vendidoDoItem.set(item, [...(vendidoDoItem.get(item) ?? []), { linha: i, quantidade: q }]);
      }
    }
  }

  // Devolução volta para a linha do orçamento que levou a venda, até o que ela vendeu. Com o
  // produto em mais de uma linha (na oferta e fora dela), a linha da oferta recebe primeiro:
  // a devolução desconta o ganho antes de mexer na venda comum.
  const devolvido = new Map<OrcParaCasar['itens'][number], number>();
  for (const i of indices.filter((k) => linhas[k].devolucao).sort(porEmissao)) {
    const d = linhas[i];
    let resta = d.quantidade;
    for (const orc of ordem) {
      if (orc.cli_codigo !== d.cli_codigo) continue;
      const itens = orc.itens.filter((it) => it.pro_codigo === d.pro_codigo).sort((a, b) => Number(b.oferta_item_id != null) - Number(a.oferta_item_id != null));
      for (const item of itens) {
        if (resta <= 0) break;
        const vendida = (vendidoDoItem.get(item) ?? [])
          .filter((c) => linhas[c.linha].emissao.getTime() <= d.emissao.getTime())
          .reduce((s, c) => s + c.quantidade, 0);
        const q = Math.min(resta, vendida - (devolvido.get(item) ?? 0));
        if (q <= 0) continue;
        resta -= q;
        devolvido.set(item, (devolvido.get(item) ?? 0) + q);
        casar(i, orc, item, q);
      }
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
  /** devolução: fica fora do teto da bolsa por linha (o líquido já vem negativo) */
  devolucao?: boolean;
  /** preço de tabela oficial do atacado (PRECO2) do produto, que classifica o teto da linha; 0 = desconhecido */
  preco_tabela: number;
  /** efetivo do ajuste da bolsa negativa atribuído à linha (estorno negativo) */
  ajuste: number;
  /**
   * Fração da linha vendida em promoção do PORTAL B2B (o BI não a marca:
   * no Celta é venda normal). Vale a mesma metade da promoção sobre ela.
   */
  promo_portal?: number;
  /**
   * Fração da linha casada com item em liquidação/campanha da intranet: essa parte
   * fica fora da bolsa (líquido, custo, metade da promoção, ajuste e excedente).
   */
  fora_bolsa?: number;
}

/**
 * O que a linha põe na bolsa, sem arredondar (quem soma arredonda no fim, como o BI).
 * A metade da promoção usa o custo do PRODUTO e só a venda (na devolução o custo vem negativo)
 * — a mesma conta de `bolsaVendedor`, para a soma das linhas fechar com o card ao centavo.
 * Serviço fica fora da bolsa. `corte`/`pct`: teto da bolsa por linha (tetoLinha) — o corte já
 * resolvido para a data da linha (corteNaData; 0 = regra fora); o excedente sai do `saldo`.
 * A fração `fora_bolsa` (liquidação/campanha) sai de tudo: os valores (e o `liquido`) devolvidos
 * já são só da parte que fica na bolsa.
 */
export function valoresLinha(l: LinhaBolsa, piso: number, corte = 0, pct = 0) {
  if (l.servico) return { liquido: 0, custo_piso: 0, absorvido: 0, ajuste: 0, excedente: 0, saldo: 0 };
  const fracao = (x: number | undefined) => Math.min(1, Math.max(0, x ?? 0));
  const k = 1 - fracao(l.fora_bolsa);
  const liquido = l.liquido * k;
  const custo_piso = l.custo_bolsa * piso * k;
  // marca S do BI: a linha toda leva a metade (menos a parte fora da bolsa) e a fração do portal
  // não soma de novo; sem a marca, só a parte casada com promoção do portal (disjunta da fora da bolsa)
  const fator = l.promocao ? k : fracao(l.promo_portal);
  const absorvido = fator > 0 && l.custo_produto > 0 && l.custo_produto * piso > l.liquido ? ((l.custo_produto * piso - l.liquido) / 2) * fator : 0;
  const excedente = l.devolucao ? 0 : tetoLinha({ liquido: l.liquido, custo_bolsa: l.custo_bolsa, preco_tabela: l.preco_tabela }, piso, corte, pct).excedente * k;
  const ajuste = l.ajuste * k;
  return { liquido, custo_piso, absorvido, ajuste, excedente, saldo: liquido - custo_piso + absorvido + ajuste - excedente };
}

/**
 * Totais do extrato: Σ(líquido − custo × piso) + Σ absorvido + Σ ajuste − Σ excedente do teto,
 * serviço só contado. O teto vale para a linha emitida a partir de `teto.desde` (`emissao` AAAA-MM-DD).
 */
export function conciliar(linhas: Array<LinhaBolsa & { emissao?: string }>, piso: number, teto?: TetoBolsa | null) {
  let venda = 0, custo = 0, absorvido = 0, ajuste = 0, excedente = 0, servicos = 0;
  for (const l of linhas) {
    if (l.servico) { servicos++; continue; }
    const v = valoresLinha(l, piso, corteNaData(teto, l.emissao), teto?.pct ?? 0);
    venda += v.liquido;
    custo += v.custo_piso;
    absorvido += v.absorvido;
    ajuste += v.ajuste;
    excedente += v.excedente;
  }
  return {
    venda_liquida: round2(venda),
    custo_piso: round2(custo),
    saldo_linhas: round2(venda - custo),
    absorvido: round2(absorvido),
    ajuste: round2(ajuste),
    excedente: round2(excedente),
    saldo: round2(venda - custo + absorvido + ajuste - excedente),
    servicos_fora: servicos,
  };
}

/** Dia (AAAA-MM-DD) de uma data montada como meia-noite local (emissão das linhas de NF). */
export const diaLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
 * casada da linha), em qualquer mês, com o teto por linha na NF emitida a partir de `teto.desde`.
 * Orçamento sem unidade casada não entra no mapa.
 */
export function bolsaNfPorOrcamento(
  porOrcamento: Map<string, { linha: number; quantidade: number; promo_portal?: boolean; fora_bolsa?: boolean }[]>,
  linhas: Array<LinhaNf & { custo_produto: number; servico: boolean; ajuste: number; preco_tabela: number }>,
  piso: number,
  teto?: TetoBolsa | null,
) {
  const saida = new Map<string, number>();
  for (const [id, casadas] of porOrcamento) {
    let soma = 0;
    for (const c of casadas) {
      const l = linhas[c.linha];
      if (!(l.quantidade > 0)) continue;
      const s = l.devolucao ? -1 : 1;
      // a parte deste orçamento em promoção do portal B2B leva a metade da promoção (só na venda);
      // a parte em liquidação/campanha da intranet não põe nada na bolsa
      const v = valoresLinha(
        { liquido: s * l.liquido, custo_bolsa: s * l.custo, custo_produto: s * l.custo_produto, promocao: l.promocao, servico: l.servico, devolucao: l.devolucao, preco_tabela: l.preco_tabela, ajuste: l.ajuste, promo_portal: c.promo_portal ? 1 : 0, fora_bolsa: c.fora_bolsa ? 1 : 0 },
        piso,
        corteNaData(teto, diaLocal(l.emissao)),
        teto?.pct ?? 0,
      );
      soma += (c.quantidade / l.quantidade) * v.saldo;
    }
    saida.set(id, round2(soma));
  }
  return saida;
}

/**
 * O que a leitura do mês no BI (`bolsaVendedor`/`bolsaPorCliente`) contou da parte das linhas de NF
 * casada com item em liquidação/campanha da intranet — quem chama subtrai do resultado do BI.
 * Por linha do casamento emitida no mês (`noMes`), sem serviço, com f = fração fora da bolsa:
 * f × líquido, f × custo da bolsa, f × excedente do teto (corte da data da linha) e, com a marca
 * de promoção do BI, f × a metade da promoção. Devolução entra com sinal (o BI a soma negativa).
 * `porCliente`: venda, custo e excedente do mesmo desconto por cliente da linha.
 */
export function descontoForaBolsaNoMes(
  linhas: Array<LinhaNf & { custo_produto: number; preco_tabela: number }>,
  porLinha: Map<number, Array<{ quantidade: number; fora_bolsa?: boolean }>>,
  noMes: (emissao: Date) => boolean,
  piso: number,
  servicos: number[],
  teto?: TetoBolsa | null,
) {
  const fora = new Set(servicos);
  const total = { venda_liquida: 0, custo: 0, absorvido: 0, excedente: 0 };
  const porCliente = new Map<number, { venda_liquida: number; custo: number; excedente: number }>();
  linhas.forEach((l, i) => {
    if (fora.has(l.pro_codigo) || !noMes(l.emissao)) return;
    const f = fracaoCasada(l.quantidade, porLinha.get(i) ?? [], 'fora_bolsa');
    if (!f) return;
    const s = l.devolucao ? -1 : 1;
    const v = valoresLinha(
      { liquido: s * l.liquido, custo_bolsa: s * l.custo, custo_produto: s * l.custo_produto, promocao: l.promocao, servico: false, devolucao: l.devolucao, preco_tabela: l.preco_tabela, ajuste: 0 },
      piso,
      corteNaData(teto, diaLocal(l.emissao)),
      teto?.pct ?? 0,
    );
    const d = { venda_liquida: f * v.liquido, custo: f * s * l.custo, excedente: f * v.excedente };
    total.venda_liquida += d.venda_liquida;
    total.custo += d.custo;
    total.excedente += d.excedente;
    total.absorvido += f * v.absorvido;
    const c = porCliente.get(l.cli_codigo) ?? { venda_liquida: 0, custo: 0, excedente: 0 };
    porCliente.set(l.cli_codigo, { venda_liquida: c.venda_liquida + d.venda_liquida, custo: c.custo + d.custo, excedente: c.excedente + d.excedente });
  });
  return { ...total, porCliente };
}

/**
 * Bolsa do orçamento a partir dos itens gravados: a mesma conta da projeção na tela
 * (`calcularBolsa().orcamento`) — receita sem serviço, custo da bolsa × piso, item sem custo
 * neutro, metade da promoção absorvida, ajuste da bolsa negativa que a empresa assume, menos o
 * excedente do teto por linha (`excedenteDoOrcamento`; corte 0 = regra fora).
 */
export function bolsaDoOrcamento(
  itens: Array<{ pro_codigo: number; quantidade: number; preco_unit: number; total: number; custo_ref: number | null; preco_tabela: number; promocao_codigo: number | null; fora_promocao: boolean; oferta_tipo?: string | null }>,
  ajustes: Array<{ quantidade: number; assumido_unit: number }>,
  piso: number,
  servicos: Set<number>,
  corte = 0,
  pct = 0,
) {
  let receita = 0, custo = 0, semCusto = 0, absorvido = 0;
  // serviço e liquidação/campanha da intranet (não vendida fora) ficam fora da bolsa
  const naBolsa = itens.filter((i) => !servicos.has(i.pro_codigo) && (i.fora_promocao || !foraDaBolsa(i.oferta_tipo)));
  for (const i of naBolsa) {
    receita += i.total;
    if (i.custo_ref != null && i.custo_ref > 0) custo += i.custo_ref * i.quantidade;
    else semCusto += i.total;
    if (i.promocao_codigo != null && !i.fora_promocao) absorvido += absorcaoPromocao(i.preco_unit, i.custo_ref, piso, i.quantidade);
  }
  return calcularBolsa({
    receita_mtd: 0, custo_mtd: 0, desconto_mtd: 0,
    receita_orc: receita, custo_orc: custo, sem_custo_orc: semCusto, absorvido_orc: absorvido,
    ajuste_orc: ajustes.reduce((s, a) => s + a.assumido_unit * a.quantidade, 0),
    excedente_orc: excedenteDoOrcamento(naBolsa, piso, corte, pct),
    piso,
  }).orcamento;
}

/**
 * Σ do excedente do teto por linha nos itens de um orçamento (líquido = total da linha, custo da
 * bolsa × quantidade). Item sem custo já entra neutro na bolsa do orçamento (vendido no piso),
 * por isso fica fora do teto. Quem chama tira o serviço.
 */
export function excedenteDoOrcamento(itens: Array<{ quantidade: number; total: number; custo_ref: number | null; preco_tabela: number }>, piso: number, corte: number, pct: number) {
  if (!(corte > 0)) return 0;
  return itens.reduce(
    (s, i) => (i.custo_ref != null && i.custo_ref > 0 ? s + tetoLinha({ liquido: i.total, custo_bolsa: i.custo_ref * i.quantidade, preco_tabela: i.preco_tabela }, piso, corte, pct).excedente : s),
    0,
  );
}
