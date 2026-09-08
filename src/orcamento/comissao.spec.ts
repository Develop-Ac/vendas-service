import { calcularComissao, celulasDoOrcamento, comissaoComOrcamento, ConfigComissao } from './comissao';

const cfg: ConfigComissao = {
  metaMix1: 0.3,
  faixasMix1: [
    { faixa: 'A', atingiu_meta: false, percentual: 0.04 },
    { faixa: 'B', atingiu_meta: false, percentual: 0.03 },
    { faixa: 'C', atingiu_meta: false, percentual: 0.03 },
    { faixa: 'D', atingiu_meta: false, percentual: 0.02 },
    { faixa: 'A', atingiu_meta: true, percentual: 0.07 },
    { faixa: 'B', atingiu_meta: true, percentual: 0.06 },
    { faixa: 'C', atingiu_meta: true, percentual: 0.05 },
    { faixa: 'D', atingiu_meta: true, percentual: 0.04 },
  ],
  faixasMix23: [
    { valor_min: 0, valor_max: 70000, percentual: 0.0085 },
    { valor_min: 70000.01, valor_max: 100000, percentual: 0.01 },
    { valor_min: 100000.01, valor_max: 130000, percentual: 0.011 },
    { valor_min: 130000.01, valor_max: 999999999, percentual: 0.013 },
  ],
};

describe('calcularComissao', () => {
  it('MIX 1 fixo por faixa e MIX 2/3 progressivo pelo total', () => {
    const r = calcularComissao(
      [
        { mix: 1, faixa: 'B', valor: 10000 },
        { mix: 2, faixa: 'A', valor: 50000 },
        { mix: 3, faixa: 'C', valor: 30000 },
      ],
      cfg,
    );
    expect(r.total).toBe(90000);
    expect(r.atingiu_meta).toBe(false);
    expect(r.pct_mix23).toBe(0.01); // 90 mil cai na 2ª faixa
    expect(r.comissao).toBe(10000 * 0.03 + 80000 * 0.01);
  });
  it('participação do MIX 1 na meta dobra a tabela', () => {
    const r = calcularComissao([{ mix: 1, faixa: 'A', valor: 30000 }, { mix: 2, faixa: 'A', valor: 70000 }], cfg);
    expect(r.atingiu_meta).toBe(true);
    expect(r.comissao).toBe(30000 * 0.07 + 70000 * 0.01);
  });
});

describe('comissaoComOrcamento', () => {
  it('o orçamento pode subir a alíquota do MIX 2/3 sobre TODO o mês', () => {
    const mes = [{ mix: 2, faixa: 'A', valor: 68000 }];
    const r = comissaoComOrcamento(mes, celulasDoOrcamento({ m23: 5000 }), cfg);
    expect(r.atual.comissao).toBe(578); // 68.000 × 0,85%
    expect(r.com_orcamento.comissao).toBe(730); // 73.000 × 1,0%
    expect(r.delta).toBe(152);
  });
  it('células do orçamento: MIX 1 por faixa; o resto como MIX 2/3', () => {
    expect(celulasDoOrcamento({ m1a: 100, m1c: 50, m23: 900 })).toEqual([
      { mix: 1, faixa: 'A', valor: 100 },
      { mix: 1, faixa: 'C', valor: 50 },
      { mix: 2, faixa: 'A', valor: 900 },
    ]);
  });
});
