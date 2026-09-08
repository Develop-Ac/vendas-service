import {
  avaliarItem,
  calcularBolsa,
  parseDegrausBolsa,
  pisoPorDre,
  pisoPorVolume,
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
    expect(a.desc_max_pct).toBe(0.015); // 1 un = metade do máximo da faixa (3%)
    expect(a.preco_minimo).toBe(34.38); // 34,90 × 0,985
    expect(a.tabela_abaixo_regua).toBe(false);
    expect(a.markup_tabela).toBeCloseTo(2.52, 2);
  });

  it('tabela abaixo da lista da régua: desconto encolhe até o piso (nunca acima da tabela)', () => {
    // custo 240,96 PB (154) -> 2A PB markup 1,60 -> lista 385,54; piso 385,54×0,95=366,26; tabela 377,87
    const a = avaliarItem({ custo: 240.96, preco_tabela: 377.87, subgrp_codigo: 154, descricao: 'P/BRISA', quantidade: 6 });
    expect(a.classe).toBe('PB');
    expect(a.faixa).toBe('2A');
    expect(a.tabela_abaixo_regua).toBe(true);
    expect(a.preco_minimo).toBe(366.26);
    expect(a.desc_max_efetivo_pct).toBeCloseTo(0.0307, 3);
  });

  it('tabela muito abaixo da régua: zero de desconto', () => {
    const a = avaliarItem({ custo: 100, preco_tabela: 150, subgrp_codigo: 1, descricao: 'X', quantidade: 6 }); // 1D GERAL 1,85 -> 185; piso 179,45
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
      excecao: { classe: 'EXCLUSIVO', desc_max: 0.05 }, quantidade: 6,
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

describe('escala por volume', () => {
  it('o máximo da faixa é o teto; a quantidade libera 50% / 75% / 100% dele', () => {
    const base = { custo: 100, preco_tabela: 200, subgrp_codigo: 1, descricao: 'X' }; // 1D GERAL: máx 3%
    const q1 = avaliarItem({ ...base, quantidade: 1 });
    const q3 = avaliarItem({ ...base, quantidade: 3 });
    const q6 = avaliarItem({ ...base, quantidade: 6 });
    const q50 = avaliarItem({ ...base, quantidade: 50 });
    expect(q1.desc_max_pct).toBe(0.015);
    expect(q3.desc_max_pct).toBe(0.0225);
    expect(q6.desc_max_pct).toBe(0.03);
    expect(q50.desc_max_pct).toBe(0.03); // nunca acima do máximo da faixa
    expect(q1.preco_minimo).toBe(197); // 200 × 0,985
    expect(q6.preco_minimo).toBe(194); // 200 × 0,97
    expect(q1.fracao_volume).toBe(0.5);
    expect(q1.escala_volume.map((d) => d.qtd_min)).toEqual([1, 3, 6]);
    expect(q1.escala_volume[2].desc_max_pct).toBe(0.03);
  });
  it('nunca abaixo do custo mesmo com volume', () => {
    const a = avaliarItem({ custo: 100, preco_tabela: 102, subgrp_codigo: 1, descricao: 'X', quantidade: 50 });
    expect(a.preco_minimo).toBeGreaterThanOrEqual(100);
  });
});

describe('calcularBolsa', () => {
  it('bolsa = receita − custo × piso; todo desconto subtrai; projeção com o orçamento', () => {
    // mês: R$ 100 mil a preço cheio, R$ 4 mil de desconto, custo R$ 60 mil → gerada 100 − 88,8 = 11,2; saldo 96 − 88,8 = 7,2
    const b = calcularBolsa({ receita_mtd: 96000, custo_mtd: 60000, desconto_mtd: 4000, piso: 1.48, linha: 1.586, premio_pct: 0.25,
      receita_orc: 9000, desconto_orc: 1000, custo_orc: 5000 });
    expect(b.gerada).toBe(11200);
    expect(b.saldo).toBe(7200);
    expect(b.pct_desconto).toBe(0.04);
    // orçamento: 9.000 − 5.000 × 1,48 = +1.600
    expect(b.saldo_apos).toBe(8800);
    // linha dos 4%: 96.000 − 60.000 × 1,586 = +840 → prêmio 25% = 210
    expect(b.acima_linha).toBe(840);
    expect(b.premio_estimado).toBe(210);
    expect(b.semaforo_atual).toBe('VERDE');
  });
  it('dentro da bolsa mas abaixo da linha é amarelo; bolsa estourada é vermelho', () => {
    expect(calcularBolsa({ receita_mtd: 90000, custo_mtd: 60000, desconto_mtd: 10000 }).semaforo_atual).toBe('AMARELO');
    expect(calcularBolsa({ receita_mtd: 85000, custo_mtd: 60000, desconto_mtd: 15000 }).semaforo_atual).toBe('VERMELHO');
  });
  it('item sem custo é neutro na projeção', () => {
    const b = calcularBolsa({ receita_mtd: 0, custo_mtd: 0, desconto_mtd: 0, receita_orc: 1480, sem_custo_orc: 1480, piso: 1.48 });
    expect(b.saldo_apos).toBe(0);
  });
});

describe('pisoPorVolume', () => {
  it('o piso segue o maior degrau alcançado e aponta o próximo', () => {
    const d = parseDegrausBolsa('0:1.586,560000:1.538,645000:1.48,700000:1.45,763000:1.421');
    expect(pisoPorVolume(d, 441000)).toMatchObject({ piso: 1.586, degrau_min: 0, proximo_min: 560000, proximo_piso: 1.538, falta: 119000 });
    expect(pisoPorVolume(d, 645000)).toMatchObject({ piso: 1.48, proximo_min: 700000 });
    expect(pisoPorVolume(d, 900000)).toMatchObject({ piso: 1.421, proximo_min: null });
  });
  it('texto inválido cai no padrão', () => {
    expect(parseDegrausBolsa('abc')).toHaveLength(5);
    expect(parseDegrausBolsa(undefined)[0].piso).toBe(1.586);
  });
});

describe('pisoPorDre', () => {
  it('reproduz a DRE 12m do canal: (CMV + fixas) / (CMV × (1 − variáveis − 4%))', () => {
    // um mês "médio" da DRE ago/25–jul/26 do atacado, repetido 12×, mais 2 meses abertos que devem ser ignorados
    const mes = { receita_bruta: 534333, abatimento: 14635, cmv: 336503, comerciais: 25804, fixas: 150244, fechado: true };
    const meses = Array.from({ length: 12 }, (_, i) => ({ ano: 2025 + Math.floor((7 + i) / 12), mes: ((7 + i) % 12) + 1, ...mes }));
    meses.push({ ano: 2026, mes: 8, ...mes, fechado: false }, { ano: 2026, mes: 9, ...mes, cmv: 0, fechado: false });
    const p = pisoPorDre(meses, 12, 0.04)!;
    expect(p.meses).toBe(12);
    expect(p.ate).toEqual({ ano: 2026, mes: 7 });
    expect(p.piso).toBeCloseTo(1.59, 2);
    expect(p.variaveis_pct).toBeCloseTo(0.0497, 3);
    expect(p.markup_realizado).toBeCloseTo(1.544, 3);
  });
  it('fixas maiores sobem o piso; volume maior baixa', () => {
    const base = { ano: 2026, mes: 1, receita_bruta: 500000, abatimento: 10000, cmv: 320000, comerciais: 25000, fixas: 150000, fechado: true };
    const p0 = pisoPorDre([base], 1)!.piso;
    expect(pisoPorDre([{ ...base, fixas: 180000 }], 1)!.piso).toBeGreaterThan(p0);
    expect(pisoPorDre([{ ...base, receita_bruta: 650000, cmv: 416000, comerciais: 32500 }], 1)!.piso).toBeLessThan(p0);
  });
  it('mês meio lançado (fixas < metade da mediana) fica fora da janela', () => {
    const mes = { receita_bruta: 500000, abatimento: 10000, cmv: 320000, comerciais: 25000, fixas: 150000, fechado: true };
    const meses = Array.from({ length: 6 }, (_, i) => ({ ano: 2026, mes: i + 1, ...mes }));
    meses.push({ ano: 2026, mes: 7, ...mes, fixas: 20000 }); // folha lançada pela metade
    const p = pisoPorDre(meses, 12)!;
    expect(p.meses).toBe(6);
    expect(p.ate).toEqual({ ano: 2026, mes: 6 });
  });
  it('sem mês fechado, sem piso', () => {
    expect(pisoPorDre([{ ano: 2026, mes: 9, receita_bruta: 1, abatimento: 0, cmv: 1, comerciais: 0, fixas: 0, fechado: false }])).toBeNull();
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
