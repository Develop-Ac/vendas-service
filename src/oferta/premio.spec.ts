import { conferirPremio, ganhoParaExibir, Premio, premioDe, premioDoVendedor, situacaoDaCampanha, valorNaFaixa } from './premio';

const campanha = {
  tipo: 'CAMPANHA' as const,
  origem: 'FORNECEDOR',
  fornecedor_codigo: 123,
  premio_tipo: 'VALOR_UNIDADE',
  premio_valor: 3,
  faixas: [{ a_partir_de: 50, valor: 4 }],
};
const porUnidade: Premio = { tipo: 'VALOR_UNIDADE', valor: 3, faixas: [{ a_partir_de: 50, valor: 4 }] };

describe('premioDe', () => {
  it('lê o cabeçalho do grupo; faixas ausentes = []', () => {
    expect(premioDe({ premio_tipo: 'PCT_CUSTO', premio_valor: '0.05', premio_faixas: null })).toEqual({ tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] });
    expect(premioDe({ premio_tipo: null, premio_valor: null })).toBeNull();
  });
});

describe('conferirPremio (critério 1)', () => {
  it('campanha completa passa', () => {
    expect(conferirPremio(campanha)).toEqual([]);
    expect(conferirPremio({ ...campanha, origem: 'EMPRESA', fornecedor_codigo: null, premio_tipo: 'PCT_VENDA', premio_valor: 0.02, faixas: [] })).toEqual([]);
  });
  it('fornecedor ausente recusa', () => {
    expect(conferirPremio({ ...campanha, fornecedor_codigo: null })).toContain('Informe o fornecedor da campanha.');
  });
  it('faixas fora de ordem recusam', () => {
    const e = conferirPremio({ ...campanha, faixas: [{ a_partir_de: 100, valor: 5 }, { a_partir_de: 50, valor: 4 }] });
    expect(e.length).toBeGreaterThan(0);
    expect(conferirPremio({ ...campanha, faixas: [{ a_partir_de: 50, valor: 2 }] })[0]).toContain('maior que o anterior');
  });
  it('percentual >= 100% e tipo errado recusam', () => {
    expect(conferirPremio({ ...campanha, premio_tipo: 'PCT_VENDA', premio_valor: 1, faixas: [] })).toHaveLength(1);
    expect(conferirPremio({ ...campanha, premio_tipo: 'PCT_CUSTO' })[0]).toContain('percentual sobre a venda');
  });
  it('liquidação: PCT_CUSTO entre 0 e 1, sem faixas; promoção sem prêmio', () => {
    expect(conferirPremio({ tipo: 'LIQUIDACAO', premio_tipo: 'PCT_CUSTO', premio_valor: 0.05 })).toEqual([]);
    expect(conferirPremio({ tipo: 'LIQUIDACAO', premio_tipo: 'PCT_CUSTO', premio_valor: 0.05, faixas: [{ a_partir_de: 1, valor: 0.1 }] })).toHaveLength(1);
    expect(conferirPremio({ tipo: 'PROMOCAO' })).toEqual([]);
    expect(conferirPremio({ tipo: 'PROMOCAO', premio_tipo: 'PCT_VENDA', premio_valor: 0.02 })).toHaveLength(1);
  });
});

describe('ganhoParaExibir', () => {
  it('critério 3: liquidação custo 180 × 5% = 9,00', () => {
    expect(ganhoParaExibir({ tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] }, { custo: 180, preco: 250 })).toEqual({ ganho_unit: 9, proxima_faixa: null });
  });
  it('critério 4: 3,00 com próxima faixa 4,00 a partir de 50', () => {
    expect(ganhoParaExibir(porUnidade, { custo: 10, preco: 20 })).toEqual({ ganho_unit: 3, proxima_faixa: { valor: 4, a_partir_de: 50 } });
  });
  it('PCT_VENDA = pct × preço; sem prêmio = null', () => {
    expect(ganhoParaExibir({ tipo: 'PCT_VENDA', valor: 0.02, faixas: [{ a_partir_de: 10, valor: 0.03 }] }, { custo: null, preco: 150 })).toEqual({
      ganho_unit: 3,
      proxima_faixa: { valor: 4.5, a_partir_de: 10 },
    });
    expect(ganhoParaExibir(null, { custo: 1, preco: 1 })).toBeNull();
  });
});

describe('premioDoVendedor', () => {
  it('critério 5: 48 un = 144,00; 60 un = 240,00', () => {
    expect(valorNaFaixa(porUnidade, 49)).toBe(3);
    expect(premioDoVendedor(porUnidade, [{ quantidade: 48, liquido: 0, custo_ref: null }])).toBe(144);
    expect(premioDoVendedor(porUnidade, [{ quantidade: 40, liquido: 0, custo_ref: null }, { quantidade: 20, liquido: 0, custo_ref: null }])).toBe(240);
  });
  it('critério 6: 2% de 1.000,00 = 20,00', () => {
    expect(premioDoVendedor({ tipo: 'PCT_VENDA', valor: 0.02, faixas: [] }, [{ quantidade: 5, liquido: 1000, custo_ref: null }])).toBe(20);
  });
  it('devolução desconta; campanha nunca negativa; liquidação custo nulo = 0', () => {
    expect(premioDoVendedor(porUnidade, [{ quantidade: 60, liquido: 0, custo_ref: null }, { quantidade: -12, liquido: 0, custo_ref: null }])).toBe(144);
    expect(premioDoVendedor(porUnidade, [{ quantidade: -5, liquido: 0, custo_ref: null }])).toBe(0);
    const liq: Premio = { tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] };
    expect(premioDoVendedor(liq, [{ quantidade: 2, liquido: 0, custo_ref: 180 }, { quantidade: 3, liquido: 0, custo_ref: null }])).toBe(18);
  });
});

describe('situacaoDaCampanha (critério 9)', () => {
  const c = { inicio: '2026-12-01', fim: '2026-12-31' };
  it('mês 26/11–25/12 = ANDAMENTO', () => {
    expect(situacaoDaCampanha(c, { inicio: '2026-11-26', fim: '2026-12-25' }, '2026-12-20')).toBe('ANDAMENTO');
  });
  it('mês 26/12–25/01: PAGAR depois do fim, ANDAMENTO antes', () => {
    const mes = { inicio: '2026-12-26', fim: '2027-01-25' };
    expect(situacaoDaCampanha(c, mes, '2027-01-02')).toBe('PAGAR');
    expect(situacaoDaCampanha(c, mes, '2026-12-28')).toBe('ANDAMENTO');
  });
  it('fora do mês = null', () => {
    expect(situacaoDaCampanha(c, { inicio: '2027-01-26', fim: '2027-02-25' }, '2027-02-01')).toBeNull();
  });
});
