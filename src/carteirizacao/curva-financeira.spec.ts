import { TituloBoleto, ehAPrazo, perfilFinanceiro } from './curva-financeira';

const HOJE = new Date('2026-10-14T12:00:00Z');

/** Data `d` dias antes de HOJE, no formato que a API devolve. */
function dia(d: number): string {
  return new Date(HOJE.getTime() - d * 86_400_000).toISOString().slice(0, 10);
}

/** Boleto de 30 dias emitido há `emitidoHa` dias e pago `atraso` dias depois do vencimento. */
function pago(emitidoHa: number, atraso: number, valor = 1000): TituloBoleto {
  return { emissao: dia(emitidoHa), vencimento: dia(emitidoHa - 30), data_pagto: dia(emitidoHa - 30 - atraso), valor };
}

function aberto(venceHa: number, valor = 1000): TituloBoleto {
  return { emissao: dia(venceHa + 30), vencimento: dia(venceHa), data_pagto: null, valor };
}

const emDia = (n: number) => Array.from({ length: n }, (_, i) => pago(100 - i * 10, 0));

describe('curva financeira', () => {
  it('bom pagador, sem uso relevante do limite: curva A com 100 pontos', () => {
    const p = perfilFinanceiro(emDia(6), [aberto(-20, 1000)], 10_000, 1, HOJE);
    expect(p.pontos).toBe(100);
    expect(p.curva).toBe('A');
    expect(p.pct_boletos_em_dia).toBe(100);
    expect(p.uso_limite_pct).toBe(10);
  });

  it('só à vista não pontua: curva C', () => {
    const vista: TituloBoleto = { emissao: dia(10), vencimento: dia(10), data_pagto: dia(10), valor: 500 };
    expect(ehAPrazo(vista)).toBe(false);
    const p = perfilFinanceiro([vista, vista, vista], [], 10_000, 1, HOJE);
    expect(p.pontos).toBe(0);
    expect(p.curva).toBe('C');
    expect(p.motivo).toMatch(/à vista/);
  });

  it('boleto vencido em aberto além da tolerância trava em C, mesmo com histórico perfeito', () => {
    const p = perfilFinanceiro(emDia(6), [aberto(12)], 10_000, 1, HOJE);
    expect(p.pontos).toBeGreaterThanOrEqual(80);
    expect(p.curva).toBe('C');
    expect(p.valor_vencido_aberto).toBe(1000);
    expect(p.motivo).toMatch(/Inadimplente/);
  });

  it('vencido dentro da tolerância de 5 dias não é inadimplência', () => {
    expect(perfilFinanceiro(emDia(6), [aberto(5)], 10_000, 1, HOJE).curva).toBe('A');
  });

  it('atraso de até 5 dias conta como em dia', () => {
    const p = perfilFinanceiro([pago(200, 5), pago(150, 5), pago(100, 5)], [], 10_000, 1, HOJE);
    expect(p.pct_boletos_em_dia).toBe(100);
    expect(p.atraso_medio_dias).toBe(0);
  });

  it('atrasos frequentes derrubam a curva', () => {
    const p = perfilFinanceiro([pago(200, 20), pago(150, 0), pago(100, 25), pago(60, 30)], [], 10_000, 1, HOJE);
    expect(p.pct_boletos_em_dia).toBe(25);
    expect(p.curva).toBe('C');
  });

  it('limite estourado zera os pontos de uso do limite', () => {
    const p = perfilFinanceiro(emDia(6), [aberto(-20, 12_000)], 10_000, 1, HOJE);
    expect(p.detalhe.uso_limite).toBe(0);
    expect(p.pontos).toBe(85);
  });

  it('menos de 3 boletos pagos: no máximo B', () => {
    const p = perfilFinanceiro(emDia(2), [], 10_000, 1, HOJE);
    expect(p.pontos).toBe(100);
    expect(p.curva).toBe('B');
  });

  it('conceito 8 (CLIENTE INADIMPLENTE) trava em C', () => {
    expect(perfilFinanceiro(emDia(6), [], 10_000, 8, HOJE).curva).toBe('C');
  });
});
