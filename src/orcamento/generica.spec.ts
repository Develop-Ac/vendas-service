import { COLUNAS_GENERICA, filtrosGenerica } from './orcamento.erp.repository';

describe('filtrosGenerica', () => {
  it('cada palavra vira um grupo OU sobre todas as colunas; palavras curtas saem', () => {
    const f = filtrosGenerica('calha de chuva bepo');
    expect(f).toHaveLength(3); // "de" fora
    for (const g of f) {
      expect('ou' in g && g.ou).toHaveLength(COLUNAS_GENERICA.length);
      expect('ou' in g && g.ou.every((x) => 'op' in x && x.op === 'contem')).toBe(true);
    }
    expect('ou' in f[2] && 'valor' in f[2].ou[0] && f[2].ou[0].valor).toBe('BEPO');
  });
  it('referência com hífen é uma palavra', () => {
    const f = filtrosGenerica('calha de chuva VW-152');
    expect('ou' in f[2] && 'valor' in f[2].ou[0] && f[2].ou[0].valor).toBe('VW-152');
  });
  it('com curinga vale o padrão inteiro em qualquer coluna', () => {
    const f = filtrosGenerica('calha%bepo');
    expect(f).toHaveLength(1);
    expect('ou' in f[0] && 'op' in f[0].ou[0] && f[0].ou[0].op).toBe('parecido');
  });
  it('só palavras curtas = nada a buscar', () => {
    expect(filtrosGenerica('de a')).toEqual([]);
  });
  it('número é código exato do produto, além das colunas de texto', () => {
    const f = filtrosGenerica('48094');
    expect('ou' in f[0] && f[0].ou[0]).toEqual({ campo: 'PRO_CODIGO', op: 'igual', valor: 48094 });
    expect('ou' in f[0] && f[0].ou).toHaveLength(COLUNAS_GENERICA.length + 1);
    // número curto: só o código
    expect('ou' in filtrosGenerica('calha 12')[1] && filtrosGenerica('calha 12')[1]).toEqual({ ou: [{ campo: 'PRO_CODIGO', op: 'igual', valor: 12 }] });
  });
});
