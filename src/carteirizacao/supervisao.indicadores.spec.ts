import { fimDia, hojeYmd, mesComissionalDe, metaVigente, pct, periodoComissional, piorCor, semaforo, somarDiasUteis } from './supervisao.indicadores';

describe('semáforo', () => {
  it('percentual: amarelo até a faixa em pontos abaixo da meta', () => {
    expect(semaforo(80, 80, 10, 'pct', 'MAIOR')).toBe('verde');
    expect(semaforo(70, 80, 10, 'pct', 'MAIOR')).toBe('amarelo');
    expect(semaforo(69.9, 80, 10, 'pct', 'MAIOR')).toBe('vermelho');
  });

  it('valor absoluto: amarelo até a faixa em % da meta', () => {
    expect(semaforo(261, 290, 10, 'qtd', 'MAIOR')).toBe('amarelo');
    expect(semaforo(260, 290, 10, 'qtd', 'MAIOR')).toBe('vermelho');
  });

  it('quanto menos, melhor', () => {
    expect(semaforo(150_000, 155_000, 10, 'brl', 'MENOR')).toBe('verde');
    expect(semaforo(170_000, 155_000, 10, 'brl', 'MENOR')).toBe('amarelo');
    expect(semaforo(171_000, 155_000, 10, 'brl', 'MENOR')).toBe('vermelho');
  });

  it('meta zero (curva A fora da régua): qualquer um já é vermelho', () => {
    expect(semaforo(0, 0, 10, 'qtd', 'MENOR')).toBe('verde');
    expect(semaforo(1, 0, 10, 'qtd', 'MENOR')).toBe('vermelho');
  });

  it('sem base para medir não tem cor', () => {
    expect(semaforo(null, 80, 10, 'pct', 'MAIOR')).toBeNull();
    expect(pct(0, 0)).toBeNull();
    expect(pct(1, 3)).toBe(33.3);
  });

  it('a pior cor manda', () => {
    expect(piorCor(['verde', null, 'amarelo'])).toBe('amarelo');
    expect(piorCor(['verde', 'vermelho'])).toBe('vermelho');
    expect(piorCor([null, null])).toBeNull();
  });
});

describe('meta vigente', () => {
  const linhas = [
    { indicador: 'RECEITA_MES', valor: 500_000, faixa_amarela: 10, vigente_desde: '2026-08-26', created_at: '2026-08-20' },
    { indicador: 'RECEITA_MES', valor: 550_000, faixa_amarela: 5, vigente_desde: '2026-09-26', created_at: '2026-09-20' },
    { indicador: 'RECEITA_MES', valor: 560_000, faixa_amarela: 5, vigente_desde: '2026-09-26', created_at: '2026-09-25' },
  ];

  it('mês passado é avaliado pela meta que valia nele', () => {
    expect(metaVigente(linhas, 'RECEITA_MES', '2026-09-01').valor).toBe(500_000);
  });

  it('mesma vigência: vale a gravada por último', () => {
    expect(metaVigente(linhas, 'RECEITA_MES', '2026-10-01')).toMatchObject({ valor: 560_000, faixa_amarela: 5 });
  });

  it('sem linha gravada, vale o padrão do catálogo', () => {
    expect(metaVigente([], 'CONVERSAO_7D_PCT', '2026-10-01')).toEqual({ valor: 65, faixa_amarela: 10, vigente_desde: null });
  });
});

describe('datas em Cuiabá', () => {
  it('3 dias úteis pulam sábado e domingo', () => {
    expect(somarDiasUteis('2026-10-09', 3)).toBe('2026-10-14'); // sexta + 3 úteis = quarta
  });

  it('"hoje" é o dia de Cuiabá mesmo com o servidor em UTC', () => {
    expect(hojeYmd(new Date('2026-10-10T02:30:00Z'))).toBe('2026-10-09'); // 22h30 em Cuiabá
    expect(fimDia('2026-10-25').toISOString()).toBe('2026-10-26T03:59:59.999Z');
  });

  it('mês comissional vira no dia 26, inclusive na virada do ano', () => {
    expect(mesComissionalDe('2026-10-25')).toEqual({ ano: 2026, mes: 10 });
    expect(mesComissionalDe('2026-12-26')).toEqual({ ano: 2027, mes: 1 });
    expect(periodoComissional(2027, 1)).toMatchObject({ inicio: '2026-12-26', fim: '2027-01-25' });
  });
});
