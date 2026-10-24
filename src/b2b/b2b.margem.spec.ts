import { semMargem } from './b2b.margem';

describe('semMargem', () => {
  it('volta o preço visto à tabela', () => {
    expect(semMargem(33, 32)).toBe(25);
    expect(semMargem(11, 10)).toBe(10);
    // 12,35 × 1,15 = 14,2025 → o portal congelou 14,20; a volta acha 12,35.
    expect(semMargem(14.2, 15)).toBe(12.35);
  });

  it('sem margem, o preço fica como está', () => {
    expect(semMargem(10, null)).toBe(10);
    expect(semMargem(10, 0)).toBe(10);
  });

  it('sem preço, sem preço', () => {
    expect(semMargem(null, 32)).toBeNull();
    expect(semMargem(undefined, 32)).toBeNull();
  });
});
