import { LinhaNf } from './ajuste-bolsa';
import { LinhaBolsa, OrcParaCasar, bolsaDoOrcamento, bolsaNfPorOrcamento, casarOrcamentos, conciliar } from './extrato-bolsa';
import { calcularBolsa } from './regua';

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
});

describe('conciliar', () => {
  const PISO = 1.5;
  // venda, promoção abaixo do piso, lote de oportunidade, devolução, serviço e ajuste
  const linhas: LinhaBolsa[] = [
    { liquido: 480, custo_bolsa: 400, custo_produto: 400, promocao: false, servico: false, ajuste: 0 },
    { liquido: 100, custo_bolsa: 90, custo_produto: 90, promocao: true, servico: false, ajuste: 0 },
    { liquido: 300, custo_bolsa: 150, custo_produto: 100, promocao: true, servico: false, ajuste: 0 },
    { liquido: -120, custo_bolsa: -100, custo_produto: -100, promocao: true, servico: false, ajuste: -10 },
    { liquido: 200, custo_bolsa: 0, custo_produto: 0, promocao: false, servico: true, ajuste: 0 },
    { liquido: 90, custo_bolsa: 100, custo_produto: 100, promocao: false, servico: false, ajuste: 40.5 },
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
    expect(t).toEqual({ venda_liquida: 850, custo_piso: 960, saldo_linhas: -110, absorvido: 17.5, ajuste: 30.5, saldo: -62, servicos_fora: 1 });
  });
});

describe('bolsa do orçamento × bolsa nas NFs', () => {
  it('orçamento gravado: mesma conta de calcularBolsa().orcamento, serviço fora, promoção pela metade', () => {
    const itens = [
      { pro_codigo: 7, quantidade: 2, preco_unit: 160, total: 320, custo_ref: 100, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 8, quantidade: 1, preco_unit: 130, total: 130, custo_ref: 100, promocao_codigo: 5, fora_promocao: false },
      { pro_codigo: 9, quantidade: 1, preco_unit: 50, total: 50, custo_ref: null, promocao_codigo: null, fora_promocao: false },
      { pro_codigo: 99, quantidade: 1, preco_unit: 80, total: 80, custo_ref: null, promocao_codigo: null, fora_promocao: false },
    ];
    // 320 − 300 + 130 − 150 + 10 (metade da promoção) + 0 (sem custo) + 5 (ajuste)
    expect(bolsaDoOrcamento(itens, [{ quantidade: 1, assumido_unit: 5 }], 1.5, new Set([99]))).toBe(15);
  });

  it('bolsa nas NFs: fração casada da linha, devolução negativa', () => {
    const linhas = [nf({ quantidade: 5 }), nf({ nfs: 600, devolucao: true, quantidade: 1, emissao: dia('2026-09-20') })].map((l) => ({ ...l, custo_produto: l.custo, servico: false, ajuste: 0 }));
    const r = casarOrcamentos([orc()], linhas);
    // 4/5 de (600 − 500 × 1,5) − (120 − 100 × 1,5)
    expect(bolsaNfPorOrcamento(r.porOrcamento, linhas, 1.5).get('O1')).toBe(-90);
  });
});
