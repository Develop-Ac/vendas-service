import { calcularDifal, calcularSt, regimeInterestadual, seloTributacao } from './tributacao';

// Parâmetros da situação 010 (revenda PA) no Celta em 24/09/2026.
const ST_PA = { mva: 0.7178, aliq_interna: 0.19, aliq_interestadual: 0.12 };

describe('calcularSt', () => {
  it('reproduz a nota 155592 item a item (ICMS 12%, base × 1,7178, 19% da base − ICMS)', () => {
    // 449,90 → ICMS 53,99 · base 772,84 · 146,84 − 53,99
    expect(calcularSt(449.9, ST_PA)).toBe(92.85);
    expect(calcularSt(978.06, ST_PA)).toBe(201.85);
    expect(calcularSt(615.11, ST_PA)).toBe(126.95);
    // soma por item = ST da nota
    expect(92.85 + 201.85 + 126.95).toBeCloseTo(421.65, 2);
  });
  it('zero para linha sem valor', () => {
    expect(calcularSt(0, ST_PA)).toBe(0);
  });
});

describe('calcularDifal', () => {
  it('reproduz a nota 155277 (base = total ÷ 0,93, DIFAL = base × 7%)', () => {
    expect(calcularDifal(268, 0.07)).toBe(20.17);
    expect(calcularDifal(693.6, 0.07)).toBe(52.21);
    expect(20.17 + 52.21).toBeCloseTo(72.38, 2);
  });
  it('sem alíquota não há DIFAL', () => {
    expect(calcularDifal(100, 0)).toBe(0);
  });
});

describe('regimeInterestadual', () => {
  const ufs = ['PA'];
  it('MT: nada muda', () => {
    expect(regimeInterestadual({ uf: 'MT', indicador_ie: 1 }, false, ufs)).toBe('NENHUM');
    expect(regimeInterestadual({ uf: null, indicador_ie: 9 }, false, ufs)).toBe('NENHUM');
  });
  it('PA contribuinte: ST, presencial ou não', () => {
    expect(regimeInterestadual({ uf: 'PA', indicador_ie: 1 }, false, ufs)).toBe('ST');
    expect(regimeInterestadual({ uf: 'PA', indicador_ie: 1 }, true, ufs)).toBe('ST');
  });
  it('PA não contribuinte ou isento: DIFAL se não presencial, nada se presencial', () => {
    expect(regimeInterestadual({ uf: 'PA', indicador_ie: 9 }, false, ufs)).toBe('DIFAL');
    expect(regimeInterestadual({ uf: 'PA', indicador_ie: 2 }, false, ufs)).toBe('DIFAL');
    expect(regimeInterestadual({ uf: 'PA', indicador_ie: 9 }, true, ufs)).toBe('PRESENCIAL');
  });
  it('outra UF: fora do escopo enquanto não liberada', () => {
    expect(regimeInterestadual({ uf: 'GO', indicador_ie: 1 }, false, ufs)).toBe('FORA_ESCOPO');
    expect(regimeInterestadual({ uf: 'GO', indicador_ie: 1 }, false, ['PA', 'GO'])).toBe('ST');
  });
  it('selo por regime', () => {
    expect(seloTributacao('DIFAL', 'PA')).toBe('PA · não contribuinte: DIFAL por conta da AC');
    expect(seloTributacao('NENHUM', 'MT')).toBeNull();
  });
});
