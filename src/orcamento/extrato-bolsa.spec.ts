import { LinhaNf } from './ajuste-bolsa';
import { LinhaBolsa, OrcParaCasar, bolsaDoOrcamento, bolsaNfPorOrcamento, casarOrcamentos, conciliar, descontoForaBolsaNoMes, valoresLinha } from './extrato-bolsa';
import { calcularBolsa, tetoLinha } from './regua';

const dia = (d: string) => new Date(`${d}T00:00:00`);

const orc = (p: Partial<OrcParaCasar> = {}): OrcParaCasar => ({
  id: 'O1', numero: 1, cli_codigo: 1, rep_codigo: 9, inicio: new Date('2026-09-01T14:30:00'),
  nf_orcamento: null, nfs_condicional: [], itens: [{ pro_codigo: 7, quantidade: 4, preco_unit: 120, custo_ref: 100 }], ...p,
});
const nf = (p: Partial<LinhaNf> = {}): LinhaNf => {
  const quantidade = p.quantidade ?? 4;
  const preco_unit = p.preco_unit ?? 120;
  return {
    empresa: 3, serie: '1', nfs: 500, pro_codigo: 7, cli_codigo: 1, rep_codigo: 9, emissao: dia('2026-09-03'),
    devolucao: false, quantidade, preco_unit, liquido: preco_unit * quantidade, custo: 100 * quantidade, promocao: false, ...p,
  };
};
const casadas = (r: ReturnType<typeof casarOrcamentos>, id: string) => (r.porOrcamento.get(id) ?? []).map((c) => [c.linha, c.quantidade]);

describe('casarOrcamentos', () => {
  it('casa pelo nº da NF gravada no orçamento do Celta, mesmo de outro cliente e fora da janela', () => {
    const linhas = [nf({ nfs: 1 }), nf({ nfs: 2, cli_codigo: 99, emissao: dia('2026-12-01') })];
    const r = casarOrcamentos([orc({ nf_orcamento: { empresa: 3, serie: '1', nfs: 2 } })], linhas);
    expect(casadas(r, 'O1')).toEqual([[1, 4]]);
    expect(r.porLinha.get(0)).toBeUndefined();
  });

  it('casa pela NF do condicional', () => {
    const linhas = [nf({ nfs: 1 }), nf({ nfs: 3, emissao: dia('2026-11-20') })];
    const r = casarOrcamentos([orc({ nfs_condicional: [{ empresa: 3, serie: '1', nfs: 3 }] })], linhas);
    expect(casadas(r, 'O1')).toEqual([[1, 4]]);
  });

  it('casa pela janela mesmo com o preço ABAIXO do orçamento, e devolve o preço do orçamento na linha', () => {
    const r = casarOrcamentos([orc()], [nf({ preco_unit: 90 })]);
    expect(casadas(r, 'O1')).toEqual([[0, 4]]);
    expect(r.porLinha.get(0)).toEqual([{ orcamento_id: 'O1', numero: 1, preco_unit_orc: 120, custo_ref: 100, quantidade: 4 }]);
  });

  it('não casa fora da janela, com outro vendedor ou antes da importação', () => {
    const linhas = [nf({ emissao: dia('2026-10-02') }), nf({ rep_codigo: 8 }), nf({ emissao: dia('2026-08-31') })];
    expect(casarOrcamentos([orc()], linhas).porOrcamento.size).toBe(0);
    // NF do mesmo dia da importação (sem hora) e no último dia da janela casam
    expect(casadas(casarOrcamentos([orc()], [nf({ emissao: dia('2026-09-01'), quantidade: 2 }), nf({ emissao: dia('2026-10-01'), quantidade: 2 })]), 'O1')).toEqual([[0, 2], [1, 2]]);
  });

  it('uma NF cobre dois orçamentos: cada unidade vai para um só, quem começou antes leva primeiro', () => {
    const a = orc({ id: 'A', numero: 1, itens: [{ pro_codigo: 7, quantidade: 3, preco_unit: 120, custo_ref: 100 }] });
    const b = orc({ id: 'B', numero: 2, inicio: new Date('2026-09-02T10:00:00'), itens: [{ pro_codigo: 7, quantidade: 3, preco_unit: 110, custo_ref: 100 }] });
    const r = casarOrcamentos([b, a], [nf({ quantidade: 5 })]);
    expect(casadas(r, 'A')).toEqual([[0, 3]]);
    expect(casadas(r, 'B')).toEqual([[0, 2]]);
    expect(r.porLinha.get(0)!.map((c) => [c.orcamento_id, c.quantidade])).toEqual([['A', 3], ['B', 2]]);
  });

  it('dois NFs cobrem um orçamento, por ordem de emissão', () => {
    const r = casarOrcamentos([orc()], [nf({ nfs: 2, quantidade: 3, emissao: dia('2026-09-10') }), nf({ nfs: 1, quantidade: 3, emissao: dia('2026-09-05') })]);
    expect(casadas(r, 'O1')).toEqual([[1, 3], [0, 1]]);
  });

  it('devolução volta para o orçamento da venda, até a quantidade vendida e só depois dela', () => {
    const linhas = [
      nf({ quantidade: 4 }),
      nf({ nfs: 600, devolucao: true, quantidade: 6, emissao: dia('2026-09-20') }),
      nf({ nfs: 601, devolucao: true, quantidade: 1, emissao: dia('2026-09-02') }), // antes da venda: fica sem orçamento
    ];
    const r = casarOrcamentos([orc()], linhas);
    expect(casadas(r, 'O1')).toEqual([[0, 4], [1, 4]]);
    expect(r.porLinha.get(2)).toBeUndefined();
  });

  it('unidade casada de venda e de devolução leva o item da oferta; item sem oferta sai sem o campo', () => {
    const o = orc({ itens: [{ pro_codigo: 7, quantidade: 4, preco_unit: 120, custo_ref: 100, oferta_item_id: 42 }, { pro_codigo: 8, quantidade: 1, preco_unit: 50, custo_ref: 30, oferta_item_id: null }] });
    const linhas = [nf({ quantidade: 4 }), nf({ nfs: 600, devolucao: true, quantidade: 1, emissao: dia('2026-09-20') }), nf({ pro_codigo: 8, quantidade: 1 })];
    const r = casarOrcamentos([o], linhas);
    expect(r.porLinha.get(0)?.map((c) => c.oferta_item_id)).toEqual([42]);
    expect(r.porLinha.get(1)?.map((c) => c.oferta_item_id)).toEqual([42]);
    expect(r.porLinha.get(2)?.[0]).not.toHaveProperty('oferta_item_id');
  });

  it('produto em duas linhas (fora e na oferta): devolução vai primeiro para a da oferta, até o que ela vendeu', () => {
    const o = orc({ itens: [{ pro_codigo: 7, quantidade: 5, preco_unit: 120, custo_ref: 100, oferta_item_id: null }, { pro_codigo: 7, quantidade: 5, preco_unit: 100, custo_ref: 100, oferta_item_id: 42 }] });
    const linhas = [nf({ quantidade: 10 }), nf({ nfs: 600, devolucao: true, quantidade: 7, emissao: dia('2026-09-20') })];
    const r = casarOrcamentos([o], linhas);
    expect(r.porLinha.get(1)?.map((c) => [c.oferta_item_id ?? null, c.quantidade])).toEqual([[42, 5], [null, 2]]);
  });
});

describe('conciliar', () => {
  const PISO = 1.5;
  // venda, promoção abaixo do piso, lote de oportunidade, devolução, serviço e ajuste
  const linhas: LinhaBolsa[] = [
    { liquido: 480, custo_bolsa: 400, custo_produto: 400, promocao: false, servico: false, preco_tabela: 130, ajuste: 0 },
    { liquido: 100, custo_bolsa: 90, custo_produto: 90, promocao: true, servico: false, preco_tabela: 110, ajuste: 0 },
    { liquido: 300, custo_bolsa: 150, custo_produto: 100, promocao: true, servico: false, preco_tabela: 120, ajuste: 0 },
    { liquido: -120, custo_bolsa: -100, custo_produto: -100, promocao: true, servico: false, devolucao: true, preco_tabela: 120, ajuste: -10 },
    { liquido: 200, custo_bolsa: 0, custo_produto: 0, promocao: false, servico: true, preco_tabela: 0, ajuste: 0 },
    { liquido: 90, custo_bolsa: 100, custo_produto: 100, promocao: false, servico: false, preco_tabela: 110, ajuste: 40.5 },
  ];

  it('soma das linhas fecha com calcularBolsa().saldo (absorvido e ajuste incluídos)', () => {
    const t = conciliar(linhas, PISO);
    // o que o BI devolve para o card: sem serviço, metade da promoção sobre o custo do produto, só na venda
    const semServico = linhas.filter((l) => !l.servico);
    const card = calcularBolsa({
      receita_mtd: semServico.reduce((s, l) => s + l.liquido, 0),
      custo_mtd: semServico.reduce((s, l) => s + l.custo_bolsa, 0),
      desconto_mtd: 0,
      absorvido_mtd: semServico.reduce((s, l) => s + (l.promocao && l.custo_produto > 0 && l.custo_produto * PISO > l.liquido ? (l.custo_produto * PISO - l.liquido) / 2 : 0), 0),
      ajuste_mtd: semServico.reduce((s, l) => s + l.ajuste, 0),
      piso: PISO,
    });
    expect(t.saldo).toBe(card.saldo);
    expect(t).toEqual({ venda_liquida: 850, custo_piso: 960, saldo_linhas: -110, absorvido: 17.5, ajuste: 30.5, excedente: 0, saldo: -62, servicos_fora: 1 });
  });

  it('teto por linha: soma das linhas fecha com o card ao centavo; linha antes da vigência não muda', () => {
    const teto = { corte: 100, pct: 0.4, desde: '2026-10-28' };
    const comDia: Array<LinhaBolsa & { emissao: string }> = [
      { liquido: 90, custo_bolsa: 30, custo_produto: 30, promocao: false, servico: false, preco_tabela: 95, ajuste: 0, emissao: '2026-10-28' }, // barata: 90 − 45 − 36 = 9
      { liquido: 333.33, custo_bolsa: 111.11, custo_produto: 111.11, promocao: false, servico: false, preco_tabela: 150, ajuste: 0, emissao: '2026-10-29' }, // cara: 333,33 − 166,665 − 111,11
      { liquido: 90, custo_bolsa: 30, custo_produto: 30, promocao: false, servico: false, preco_tabela: 95, ajuste: 0, emissao: '2026-10-27' }, // antes da vigência
      { liquido: -90, custo_bolsa: -30, custo_produto: -30, promocao: false, servico: false, devolucao: true, preco_tabela: 95, ajuste: 0, emissao: '2026-10-29' },
      ...linhas.map((l) => ({ ...l, emissao: '2026-10-29' })),
    ];
    const t = conciliar(comDia, PISO, teto);
    // o BI: Σ do excedente das linhas de venda emitidas a partir de `desde` (excedenteSql)
    const semServico = comDia.filter((l) => !l.servico);
    const excedente = semServico
      .filter((l) => !l.devolucao && l.emissao >= teto.desde)
      .reduce((s, l) => s + tetoLinha(l, PISO, teto.corte, teto.pct).excedente, 0);
    const card = calcularBolsa({
      receita_mtd: semServico.reduce((s, l) => s + l.liquido, 0),
      custo_mtd: semServico.reduce((s, l) => s + l.custo_bolsa, 0),
      desconto_mtd: 0,
      absorvido_mtd: semServico.reduce((s, l) => s + (l.promocao && l.custo_produto > 0 && l.custo_produto * PISO > l.liquido ? (l.custo_produto * PISO - l.liquido) / 2 : 0), 0),
      ajuste_mtd: semServico.reduce((s, l) => s + l.ajuste, 0),
      excedente_mtd: excedente,
      piso: PISO,
    });
    // só as duas primeiras passam do teto (a promoção cara de 300 fica abaixo do custo da linha, 150)
    expect(t.excedente).toBe(64.56); // 9 + (333,33 − 111,11 × 1,5 − 111,11)
    expect(t.saldo).toBe(card.saldo);
    // corte 0 = sem teto: o mesmo de antes
    expect(conciliar(comDia, PISO, { ...teto, corte: 0 }).saldo).toBe(conciliar(comDia, PISO).saldo);
  });
});

describe('bolsa do orçamento × bolsa nas NFs', () => {
  it('orçamento gravado: mesma conta de calcularBolsa().orcamento, serviço fora, promoção pela metade', () => {
    const itens = [
      { pro_codigo: 7, quantidade: 2, preco_unit: 160, total: 320, custo_ref: 100, preco_tabela: 170, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 8, quantidade: 1, preco_unit: 130, total: 130, custo_ref: 100, preco_tabela: 150, promocao_codigo: 5, fora_promocao: false },
      { pro_codigo: 9, quantidade: 1, preco_unit: 50, total: 50, custo_ref: null, preco_tabela: 50, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 99, quantidade: 1, preco_unit: 80, total: 80, custo_ref: null, preco_tabela: 80, promocao_codigo: null, fora_promocao: false },
    ];
    // 320 − 300 + 130 − 150 + 10 (metade da promoção) + 0 (sem custo) + 5 (ajuste)
    expect(bolsaDoOrcamento(itens, [{ quantidade: 1, assumido_unit: 5 }], 1.5, new Set([99]))).toBe(15);
  });

  it('orçamento gravado com teto: sai o excedente por item; sem custo e serviço ficam fora; corte 0 = antes', () => {
    const itens = [
      // tabela 95 (≤ 100) a markup 3: saldo 90 − 45 = 45, teto 40% × 90 = 36 → excedente 9
      { pro_codigo: 7, quantidade: 1, preco_unit: 90, total: 90, custo_ref: 30, preco_tabela: 95, promocao_codigo: null, fora_promocao: false },
      // tabela 160 (> 100) a markup 3: 2 × 150 − 150 = 150, teto = custo 100 → excedente 50
      { pro_codigo: 8, quantidade: 2, preco_unit: 150, total: 300, custo_ref: 50, preco_tabela: 160, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 9, quantidade: 1, preco_unit: 50, total: 50, custo_ref: null, preco_tabela: 50, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 99, quantidade: 1, preco_unit: 80, total: 80, custo_ref: 10, preco_tabela: 80, promocao_codigo: null, fora_promocao: false },
    ];
    const sem = bolsaDoOrcamento(itens, [], 1.5, new Set([99]));
    expect(bolsaDoOrcamento(itens, [], 1.5, new Set([99]), 0, 0.4)).toBe(sem);
    expect(bolsaDoOrcamento(itens, [], 1.5, new Set([99]), 100, 0.4)).toBeCloseTo(sem - 59, 2);
  });

  it('liquidação abaixo de custo × piso não muda a bolsa; a mesma linha em promoção sai metade; fora da oferta, inteira', () => {
    const base = { pro_codigo: 7, quantidade: 2, preco_unit: 160, total: 320, custo_ref: 100, preco_tabela: 200, promocao_codigo: null, fora_promocao: false };
    // 2 × 120 contra piso 150 → −60 na linha
    const oferta = { pro_codigo: 8, quantidade: 2, preco_unit: 120, total: 240, custo_ref: 100, preco_tabela: 200, promocao_codigo: -1, fora_promocao: false };
    const so = bolsaDoOrcamento([base], [], 1.5, new Set());
    expect(so).toBe(20);
    expect(bolsaDoOrcamento([base, { ...oferta, oferta_tipo: 'LIQUIDACAO' }], [], 1.5, new Set())).toBe(so);
    expect(bolsaDoOrcamento([base, { ...oferta, oferta_tipo: 'CAMPANHA' }], [], 1.5, new Set(), 100, 0.4)).toBe(bolsaDoOrcamento([base], [], 1.5, new Set(), 100, 0.4));
    expect(bolsaDoOrcamento([base, { ...oferta, oferta_tipo: 'PROMOCAO' }], [], 1.5, new Set())).toBe(so - 30);
    expect(bolsaDoOrcamento([base, { ...oferta, promocao_codigo: null, oferta_tipo: null, fora_promocao: true }], [], 1.5, new Set())).toBe(so - 60);
  });

  it('bolsa nas NFs: fração casada da linha, devolução negativa', () => {
    const linhas = [nf({ quantidade: 5 }), nf({ nfs: 600, devolucao: true, quantidade: 1, emissao: dia('2026-09-20') })].map((l) => ({ ...l, custo_produto: l.custo, servico: false, ajuste: 0, preco_tabela: 130 }));
    const r = casarOrcamentos([orc()], linhas);
    // 4/5 de (600 − 500 × 1,5) − (120 − 100 × 1,5)
    expect(bolsaNfPorOrcamento(r.porOrcamento, linhas, 1.5).get('O1')).toBe(-90);
  });

  it('bolsa nas NFs com teto: só a NF emitida a partir da vigência perde o excedente', () => {
    // 4 un. de custo 100 a 300 (tabela 320): 1200 − 600 = 600, teto 400 → excedente 200
    const linhas = [nf({ quantidade: 4, preco_unit: 300 })].map((l) => ({ ...l, custo_produto: l.custo, servico: false, ajuste: 0, preco_tabela: 320 }));
    const r = casarOrcamentos([orc()], linhas);
    expect(bolsaNfPorOrcamento(r.porOrcamento, linhas, 1.5, { corte: 100, pct: 0.4, desde: '2026-09-04' }).get('O1')).toBe(600);
    expect(bolsaNfPorOrcamento(r.porOrcamento, linhas, 1.5, { corte: 100, pct: 0.4, desde: '2026-09-03' }).get('O1')).toBe(400);
  });
});

describe('liquidação/campanha da intranet fora da bolsa do mês e do extrato', () => {
  const PISO = 1.5;
  // promoção com a marca S do BI, abaixo do piso: 4 × 120 = 480 contra custo 400 × 1,5 = 600
  const linha: LinhaBolsa = { liquido: 480, custo_bolsa: 400, custo_produto: 400, promocao: true, servico: false, preco_tabela: 130, ajuste: 0 };

  it('linha casada inteira com liquidação contribui zero', () => {
    const v = valoresLinha({ ...linha, fora_bolsa: 1 }, PISO);
    expect(v).toEqual({ liquido: 0, custo_piso: 0, absorvido: 0, ajuste: 0, excedente: 0, saldo: 0 });
    expect(conciliar([{ ...linha, fora_bolsa: 1 }], PISO)).toEqual(expect.objectContaining({ venda_liquida: 0, custo_piso: 0, absorvido: 0, saldo: 0 }));
  });

  it('casada pela metade da quantidade: contribui pela outra metade, inclusive o absorvido da marca S', () => {
    const inteira = valoresLinha(linha, PISO);
    const meia = valoresLinha({ ...linha, fora_bolsa: 0.5 }, PISO);
    expect(inteira.absorvido).toBe(60);
    expect(meia).toEqual({ liquido: 240, custo_piso: 300, absorvido: 30, ajuste: 0, excedente: 0, saldo: -30 });
    expect(conciliar([{ ...linha, fora_bolsa: 0.5 }], PISO)).toEqual(expect.objectContaining({ venda_liquida: 240, custo_piso: 300, absorvido: 30, saldo: -30 }));
  });

  it('o casamento leva a marca até a NF e a bolsa por orçamento zera a parte da liquidação', () => {
    const l = { ...nf({ promocao: true }), custo_produto: 400, servico: false, ajuste: 0, preco_tabela: 130 };
    const liq = orc({ itens: [{ pro_codigo: 7, quantidade: 2, preco_unit: 120, custo_ref: 100, fora_bolsa: true }] });
    const comum = orc({ id: 'O2', numero: 2, itens: [{ pro_codigo: 7, quantidade: 2, preco_unit: 120, custo_ref: 100 }] });
    const r = casarOrcamentos([liq, comum], [l]);
    expect(r.porLinha.get(0)?.map((c) => c.fora_bolsa ?? false)).toEqual([true, false]);
    const bolsa = bolsaNfPorOrcamento(r.porOrcamento, [l], PISO);
    expect(bolsa.get('O1')).toBe(0);
    expect(bolsa.get('O2')).toBe(-30); // metade da linha: (480 − 600 + 60) / 2
  });
});

describe('descontoForaBolsaNoMes', () => {
  const PISO = 1.5;
  const noMes = () => true;
  // 4 × 120 = 480, custo 400, marca S do BI: metade da promoção = (600 − 480) / 2 = 60
  const l = { ...nf({ promocao: true }), custo_produto: 400, preco_tabela: 130 };
  const zero = { venda_liquida: 0, custo: 0, absorvido: 0, excedente: 0 };

  it('sem item de liquidação/campanha casado o desconto é zero', () => {
    const r = casarOrcamentos([orc()], [l]);
    const d = descontoForaBolsaNoMes([l], r.porLinha, noMes, PISO, []);
    expect(d).toEqual(expect.objectContaining(zero));
    expect(d.porCliente.size).toBe(0);
  });

  it('metade da quantidade casada com liquidação desconta metade da linha (também do cliente)', () => {
    const liq = orc({ itens: [{ pro_codigo: 7, quantidade: 2, preco_unit: 120, custo_ref: 100, fora_bolsa: true }] });
    const r = casarOrcamentos([liq], [l]);
    const d = descontoForaBolsaNoMes([l], r.porLinha, noMes, PISO, []);
    expect(d).toEqual(expect.objectContaining({ venda_liquida: 240, custo: 200, absorvido: 30, excedente: 0 }));
    expect(d.porCliente.get(1)).toEqual({ venda_liquida: 240, custo: 200, excedente: 0 });
    // o mês do BI menos o desconto = a soma das linhas do extrato com a fração
    const bi = calcularBolsa({ receita_mtd: 480 - d.venda_liquida, custo_mtd: 400 - d.custo, desconto_mtd: 0, absorvido_mtd: 60 - d.absorvido, piso: PISO }).saldo;
    expect(bi).toBe(conciliar([{ liquido: 480, custo_bolsa: 400, custo_produto: 400, promocao: true, servico: false, preco_tabela: 130, ajuste: 0, fora_bolsa: 0.5 }], PISO).saldo);
  });

  it('serviço e linha fora do mês não descontam', () => {
    const liq = orc({ itens: [{ pro_codigo: 7, quantidade: 4, preco_unit: 120, custo_ref: 100, fora_bolsa: true }] });
    const r = casarOrcamentos([liq], [l]);
    expect(descontoForaBolsaNoMes([l], r.porLinha, noMes, PISO, [7])).toEqual(expect.objectContaining(zero));
    expect(descontoForaBolsaNoMes([l], r.porLinha, () => false, PISO, [])).toEqual(expect.objectContaining(zero));
  });
});
