import { custoParaBolsa } from './oportunidade';

describe('custoParaBolsa', () => {
  // Farol Mobi (50129) em 25/09/2026: custo 210,66 · tabela 882,07 · piso 1,538.
  it('reparte a sobra a preço de tabela e devolve o custo que fecha a conta', () => {
    const c = custoParaBolsa(210.66, 882.07, 1.538, 0.2);
    expect(c.sobra).toBe(558.07);
    expect(c.vendedor).toBe(111.61);
    expect(c.reserva).toBe(446.46);
    // preço − custo_bolsa × piso = parte do vendedor
    expect(882.07 - c.custo_bolsa * 1.538).toBeCloseTo(c.vendedor, 1);
  });
  it('100% para o vendedor = custo real; 0% = tudo para a empresa', () => {
    expect(custoParaBolsa(100, 200, 1.5, 1).custo_bolsa).toBe(100);
    const zero = custoParaBolsa(100, 200, 1.5, 0);
    expect(zero.vendedor).toBe(0);
    expect(200 - zero.custo_bolsa * 1.5).toBeCloseTo(0, 2);
  });
  it('tabela abaixo do piso: não há sobra a repartir', () => {
    const c = custoParaBolsa(100, 120, 1.5, 0.2);
    expect(c.sobra).toBe(0);
    expect(c.custo_bolsa).toBe(100);
  });
});
