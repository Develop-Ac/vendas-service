import {
  avaliarItem,
  calcularBolsa,
  classeBase,
  colunaTabela,
  degrauMix1,
  faixaPorCusto,
  precoDaTabela,
  regraDe,
  REGUA_PADRAO,
} from './regua';

describe('faixaPorCusto', () => {
  it('classifica pelos limites do ETL (FAIXA_MIX)', () => {
    expect(faixaPorCusto(5)?.chave).toBe('1A');
    expect(faixaPorCusto(10.01)?.chave).toBe('1A');
    expect(faixaPorCusto(10.02)?.chave).toBe('1B');
    expect(faixaPorCusto(38.5)?.chave).toBe('1B');
    expect(faixaPorCusto(124.37)?.chave).toBe('1D');
    expect(faixaPorCusto(124.38)?.chave).toBe('2A');
    expect(faixaPorCusto(249.6)?.chave).toBe('2A');
    expect(faixaPorCusto(299.86)?.chave).toBe('2B');
    expect(faixaPorCusto(395.02)?.chave).toBe('2C');
    expect(faixaPorCusto(496.27)?.chave).toBe('3A');
    expect(faixaPorCusto(696.35)?.chave).toBe('3B');
    expect(faixaPorCusto(995)?.chave).toBe('3C');
    expect(faixaPorCusto(996.48)?.chave).toBe('3D');
    expect(faixaPorCusto(18012)?.chave).toBe('3D');
  });
  it('sem custo não há faixa', () => {
    expect(faixaPorCusto(0)).toBeNull();
    expect(faixaPorCusto(null)).toBeNull();
  });
});

describe('classeBase', () => {
  it('subgrupo 154 é P/BRISA; descrição socorre item mal classificado', () => {
    expect(classeBase(154, 'QUALQUER')).toBe('PB');
    expect(classeBase(95, 'P/BRISA GOL G5')).toBe('PB');
    expect(classeBase(95, 'PARABRISA CORSA')).toBe('PB');
    expect(classeBase(95, 'FAROL AUX PALIO')).toBe('GERAL');
  });
});

describe('regraDe', () => {
  it('recua a letra da faixa quando a combinação não existe', () => {
    const regua = REGUA_PADRAO.filter((r) => !(r.classe === 'GERAL' && r.faixa === '2C'));
    expect(regraDe(regua, 'GERAL', '2C')?.faixa).toBe('2B');
    expect(regraDe(REGUA_PADRAO, 'PB', '3D')?.markup).toBe(1.38);
  });
});

describe('precoDaTabela', () => {
  const p = { PRECO2: 34.9, PRECO5: 38.9, PRECO_VENDA: 86.9, PRECO4: 0 };
  it('tabela do cliente -> coluna', () => {
    expect(colunaTabela('2')).toBe('PRECO2');
    expect(colunaTabela('5   ')).toBe('PRECO5');
    expect(colunaTabela('B')).toBe('PRECO_VENDA');
    expect(colunaTabela(null)).toBe('PRECO_VENDA');
  });
  it('usa a tabela do cliente; zerada cai para PRECO2 e avisa', () => {
    expect(precoDaTabela(p, '5')).toEqual({ coluna: 'PRECO5', preco: 38.9, fallback: false });
    expect(precoDaTabela(p, '4')).toEqual({ coluna: 'PRECO2', preco: 34.9, fallback: true });
    expect(precoDaTabela({ PRECO2: 0, PRECO5: 0, PRECO_VENDA: 0 }, '2').preco).toBe(0);
  });
});

describe('avaliarItem', () => {
  it('item GERAL 1B: desconto máx 3% sobre a tabela, piso da régua respeitado', () => {
    // custo 13,85 -> 1B GERAL markup 2,30 -> lista 31,86; tabela 34,90 (acima da lista)
    const a = avaliarItem({ custo: 13.85, preco_tabela: 34.9, subgrp_codigo: 151, descricao: 'VIDRO' });
    expect(a.classe).toBe('GERAL');
    expect(a.faixa).toBe('1B');
    expect(a.markup_regua).toBe(2.3);
    expect(a.preco_alvo_regua).toBe(31.86);
    expect(a.desc_max_pct).toBe(0.03);
    expect(a.preco_minimo).toBe(33.85); // 34,90 × 0,97
    expect(a.tabela_abaixo_regua).toBe(false);
    expect(a.markup_tabela).toBeCloseTo(2.52, 2);
  });

  it('tabela abaixo da lista da régua: desconto encolhe até o piso (nunca acima da tabela)', () => {
    // custo 240,96 PB (154) -> 2A PB markup 1,60 -> lista 385,54; piso 385,54×0,95=366,26; tabela 377,87
    const a = avaliarItem({ custo: 240.96, preco_tabela: 377.87, subgrp_codigo: 154, descricao: 'P/BRISA' });
    expect(a.classe).toBe('PB');
    expect(a.faixa).toBe('2A');
    expect(a.tabela_abaixo_regua).toBe(true);
    expect(a.preco_minimo).toBe(366.26);
    expect(a.desc_max_efetivo_pct).toBeCloseTo(0.0307, 3);
  });

  it('tabela muito abaixo da régua: zero de desconto', () => {
    const a = avaliarItem({ custo: 100, preco_tabela: 150, subgrp_codigo: 1, descricao: 'X' }); // 1D GERAL 1,85 -> 185; piso 179,45
    expect(a.preco_minimo).toBe(150);
    expect(a.desc_max_efetivo_pct).toBe(0);
  });

  it('nunca abaixo do custo', () => {
    const a = avaliarItem({ custo: 100, preco_tabela: 101, subgrp_codigo: 1, descricao: 'X' });
    expect(a.preco_minimo).toBeGreaterThanOrEqual(100);
  });

  it('exceção exclusivo congela o markup e usa o desconto próprio', () => {
    const a = avaliarItem({
      custo: 500, preco_tabela: 1200, subgrp_codigo: 1, descricao: 'FAROL TERA',
      excecao: { classe: 'EXCLUSIVO', desc_max: 0.05 },
    });
    expect(a.classe).toBe('EXCLUSIVO');
    expect(a.preco_minimo).toBe(1140);
    expect(a.markup_regua).toBeNull();
  });

  it('sem custo: sem faixa e sem desconto automático', () => {
    const a = avaliarItem({ custo: 0, preco_tabela: 50, subgrp_codigo: 1, descricao: 'X' });
    expect(a.faixa).toBeNull();
    expect(a.preco_minimo).toBe(50);
    expect(a.desc_max_pct).toBe(0);
  });
});

describe('calcularBolsa', () => {
  it('saldo para ficar no bônus e projeção com o orçamento', () => {
    const b = calcularBolsa({ bruto_mtd: 100000, desconto_mtd: 2000, bruto_orc: 10000, desconto_orc: 1500 });
    expect(b.pct_atual).toBe(0.02);
    expect(b.saldo_bonus).toBe(1000);
    expect(b.saldo_teto).toBe(4000);
    expect(b.pct_apos).toBeCloseTo(3500 / 110000, 4);
    expect(b.semaforo_atual).toBe('VERDE');
    expect(b.semaforo_apos).toBe('AMARELO');
  });
  it('acima de 6% é vermelho', () => {
    expect(calcularBolsa({ bruto_mtd: 1000, desconto_mtd: 70 }).semaforo_atual).toBe('VERMELHO');
  });
});

describe('degrauMix1', () => {
  it('escada 22/26/30', () => {
    expect(degrauMix1(0.2)).toMatchObject({ degrau: 0, multiplicador: 1, proximo_minimo: 0.22, falta_pp: 0.02 });
    expect(degrauMix1(0.22)).toMatchObject({ degrau: 1, multiplicador: 1.25, proximo_minimo: 0.26 });
    expect(degrauMix1(0.27)).toMatchObject({ degrau: 2, multiplicador: 1.5 });
    expect(degrauMix1(0.31)).toMatchObject({ degrau: 3, multiplicador: 2, proximo_minimo: null, falta_pp: 0 });
  });
});
