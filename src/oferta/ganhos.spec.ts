import { LinhaNf } from '../orcamento/ajuste-bolsa';
import { UnidadesCasadas } from '../orcamento/extrato-bolsa';
import { periodoComissional } from '../carteirizacao/supervisao.indicadores';
import { apurarGanhos, GrupoGanho, resultadoDoGrupo, VendaOferta, vendasDaOferta } from './ganhos';

const linhaNf = (o: Partial<LinhaNf>): LinhaNf => ({
  empresa: 3, serie: '1', nfs: 100, pro_codigo: 10, cli_codigo: 1, rep_codigo: 7,
  emissao: new Date(2026, 10, 10), devolucao: false, quantidade: 10,
  preco_unit: 100, liquido: 1000, custo: 50, promocao: false, ...o,
});
const unid = (quantidade: number, o: Partial<UnidadesCasadas> = {}): UnidadesCasadas => ({
  orcamento_id: 'o1', numero: 1, preco_unit_orc: 100, custo_ref: 180, quantidade, ...o,
});
const venda = (o: Partial<VendaOferta>): VendaOferta => ({
  rep_codigo: 7, oferta_id: 1, oferta_item_id: 11, pro_codigo: 10, empresa: 3, serie: '1', nfs: 100,
  emissao: '2026-11-10', devolucao: false, quantidade: 1, liquido: 100, custo_ref: 180, ...o,
});
const grupo = (o: Partial<GrupoGanho>): GrupoGanho => ({
  id: 1, nome: 'G', tipo: 'CAMPANHA', origem: 'EMPRESA', fornecedor_codigo: null, fornecedor_nome: null,
  premio: null, inicio: '2026-11-01', fim: '2026-11-20', ...o,
});

const novembro = periodoComissional(2026, 11); // 26/10 a 25/11
const hoje = '2026-11-21';
const liquidacao = grupo({ id: 1, nome: 'Liq', tipo: 'LIQUIDACAO', origem: null, premio: { tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] } });
const porUnidade = grupo({ id: 2, nome: 'Camp R$', premio: { tipo: 'VALOR_UNIDADE', valor: 3, faixas: [{ a_partir_de: 50, valor: 4 }] } });
const pctVenda = grupo({ id: 3, nome: 'Camp 2%', premio: { tipo: 'PCT_VENDA', valor: 0.02, faixas: [] } });

describe('vendasDaOferta', () => {
  it('líquido pela fração casada; devolução negativa; sem item de oferta ou fora do mapa não entra (critério 8)', () => {
    const linhas = [linhaNf({}), linhaNf({ nfs: 101, devolucao: true, quantidade: 2, liquido: 200 })];
    const porLinha = new Map([
      [0, [unid(4, { oferta_item_id: 11 }), unid(3), unid(3, { oferta_item_id: 99 })]],
      [1, [unid(2, { oferta_item_id: 11 })]],
    ]);
    const v = vendasDaOferta(7, linhas, porLinha, new Map([[11, 1]]));
    expect(v).toEqual([
      expect.objectContaining({ oferta_id: 1, oferta_item_id: 11, quantidade: 4, liquido: 400, emissao: '2026-11-10', custo_ref: 180 }),
      expect.objectContaining({ nfs: 101, devolucao: true, quantidade: -2, liquido: -200 }),
    ]);
  });
});

describe('apurarGanhos', () => {
  it('critério 5: 48 un = 144,00; 60 un = 240,00', () => {
    const r = apurarGanhos([porUnidade], [venda({ oferta_id: 2, quantidade: 48 }), venda({ rep_codigo: 8, oferta_id: 2, quantidade: 60 })], novembro, hoje);
    expect(r.vendedores.map((v) => [v.rep_codigo, v.premios_campanha, v.total])).toEqual([[7, 144, 144], [8, 240, 240]]);
    expect(r.vendedores[1].linhas[0]).toMatchObject({ ganho: 240, situacao: 'PAGAR', grupo: 'Camp R$' });
  });

  it('critério 6: 2% de R$ 1.000,00 líquidos = R$ 20,00', () => {
    const r = apurarGanhos([pctVenda], [venda({ oferta_id: 3, quantidade: 10, liquido: 1000 })], novembro, hoje);
    expect(r.vendedores[0]).toMatchObject({ premios_campanha: 20, total: 20 });
  });

  it('critério 7: devolução de 2 un da liquidação reduz o bônus dessas 2 un', () => {
    const vendas = [venda({ quantidade: 10 }), venda({ nfs: 101, devolucao: true, quantidade: -2, emissao: '2026-11-15' })];
    const r = apurarGanhos([liquidacao], vendas, novembro, hoje);
    // 10 × 180 × 5% = 90; −2 × 180 × 5% = −18
    expect(r.vendedores[0]).toMatchObject({ bonus_liquidacao: 72, total: 72 });
    expect(r.vendedores[0].linhas.map((l) => l.ganho)).toEqual([90, -18]);
  });

  it('linhas fecham com o total: centavo do arredondamento e campanha no piso zero', () => {
    const tres = [1, 2, 3].map((n) => venda({ nfs: n, custo_ref: 3.33 }));
    const liq = apurarGanhos([liquidacao], tres, novembro, hoje).vendedores[0];
    expect(liq.bonus_liquidacao).toBe(0.5);
    expect(liq.linhas.reduce((s, l) => s + l.ganho, 0)).toBeCloseTo(0.5, 10);
    const camp = apurarGanhos([porUnidade], [venda({ oferta_id: 2, quantidade: 2 }), venda({ oferta_id: 2, nfs: 101, devolucao: true, quantidade: -3 })], novembro, hoje).vendedores[0];
    expect(camp.premios_campanha).toBe(0);
    expect(camp.linhas.map((l) => l.ganho)).toEqual([0, 0]);
  });

  it('liquidação conta só as notas emitidas no mês', () => {
    const r = apurarGanhos([liquidacao], [venda({ quantidade: 10, emissao: '2026-11-26' })], novembro, hoje);
    expect(r.vendedores).toEqual([]);
  });

  it('critério 8: promoção e grupo fora da lista não geram ganho', () => {
    const promo = grupo({ id: 4, tipo: 'PROMOCAO', origem: null });
    const r = apurarGanhos([promo], [venda({ oferta_id: 4, quantidade: 10 }), venda({ oferta_id: 99, quantidade: 5 })], novembro, hoje);
    expect(r.vendedores).toEqual([]);
  });

  it('critério 9: campanha 01/12–31/12 em andamento em dezembro (fora do total) e inteira em janeiro', () => {
    const dez = grupo({ id: 2, inicio: '2026-12-01', fim: '2026-12-31', premio: porUnidade.premio });
    const vendas = [venda({ oferta_id: 2, quantidade: 30, emissao: '2026-12-05' }), venda({ oferta_id: 2, quantidade: 30, emissao: '2026-12-28' })];
    const emDez = apurarGanhos([dez], vendas, periodoComissional(2026, 12), '2026-12-20');
    expect(emDez.vendedores[0]).toMatchObject({ premios_campanha: 0, total: 0, em_andamento: 240 });
    expect(emDez.vendedores[0].linhas.every((l) => l.situacao === 'ANDAMENTO')).toBe(true);
    const emJan = apurarGanhos([dez], vendas, periodoComissional(2027, 1), '2027-01-02');
    expect(emJan.vendedores[0]).toMatchObject({ premios_campanha: 240, total: 240, em_andamento: 0 });
  });

  it('critério 10: a cobrar = soma dos prêmios pagos das campanhas do fornecedor encerradas no mês', () => {
    const forn = { origem: 'FORNECEDOR' as const, fornecedor_codigo: 500, fornecedor_nome: 'Forn' };
    const a = grupo({ ...forn, id: 2, nome: 'A', premio: porUnidade.premio });
    const b = grupo({ ...forn, id: 3, nome: 'B', premio: pctVenda.premio });
    const andando = grupo({ ...forn, id: 5, nome: 'C', fim: '2026-11-30', premio: porUnidade.premio });
    const vendas = [
      venda({ oferta_id: 2, quantidade: 48 }),
      venda({ rep_codigo: 8, oferta_id: 2, quantidade: 10 }),
      venda({ oferta_id: 3, quantidade: 5, liquido: 1000 }),
      venda({ oferta_id: 5, quantidade: 100 }),
    ];
    const r = apurarGanhos([a, b, andando, pctVenda], vendas, novembro, hoje);
    expect(r.fornecedores).toEqual([
      {
        fornecedor_codigo: 500, fornecedor_nome: 'Forn', unidades: 63, valor: 194,
        campanhas: [{ oferta_id: 2, grupo: 'A', unidades: 58, valor: 174 }, { oferta_id: 3, grupo: 'B', unidades: 5, valor: 20 }],
      },
    ]);
  });
});

describe('resultadoDoGrupo', () => {
  it('faturado por item e ganho por vendedor; promoção sem vendedores', () => {
    const vendas = [venda({ oferta_id: 2, quantidade: 48, liquido: 4800 }), venda({ oferta_id: 2, oferta_item_id: 12, rep_codigo: 8, quantidade: 2, liquido: 200 })];
    expect(resultadoDoGrupo(porUnidade, vendas, '2026-11-18')).toEqual({
      faturado: [
        { oferta_item_id: 11, pro_codigo: 10, quantidade: 48, valor: 4800 },
        { oferta_item_id: 12, pro_codigo: 10, quantidade: 2, valor: 200 },
      ],
      vendedores: [
        { rep_codigo: 7, quantidade: 48, valor: 4800, ganho: 144, situacao: 'ANDAMENTO' },
        { rep_codigo: 8, quantidade: 2, valor: 200, ganho: 6, situacao: 'ANDAMENTO' },
      ],
    });
    expect(resultadoDoGrupo(grupo({ id: 2, tipo: 'PROMOCAO' }), vendas, hoje).vendedores).toEqual([]);
  });
});
