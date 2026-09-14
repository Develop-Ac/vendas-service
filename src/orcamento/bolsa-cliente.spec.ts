import { mesesAnteriores } from './orcamento.bi.repository';

describe('mesesAnteriores', () => {
  it('meses fechados antes do atual, mais recente primeiro', () => {
    expect(mesesAnteriores(2026, 9, 3)).toEqual([
      { ano: 2026, mes: 8 },
      { ano: 2026, mes: 7 },
      { ano: 2026, mes: 6 },
    ]);
  });

  it('janeiro recua para dezembro do ano anterior', () => {
    expect(mesesAnteriores(2026, 2, 6)).toEqual([
      { ano: 2026, mes: 1 },
      { ano: 2025, mes: 12 },
      { ano: 2025, mes: 11 },
      { ano: 2025, mes: 10 },
      { ano: 2025, mes: 9 },
      { ano: 2025, mes: 8 },
    ]);
  });
});
