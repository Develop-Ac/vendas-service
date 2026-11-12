import { CacheVelho } from './cache-velho';

describe('CacheVelho', () => {
  const T0 = new Date('2026-11-12T12:00:00').getTime();
  const andar = (ms: number) => jest.setSystemTime(Date.now() + ms);
  const esvaziar = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  beforeEach(() => jest.useFakeTimers().setSystemTime(T0));
  afterEach(() => jest.useRealTimers());

  it('valor novo: duas leituras, calcula uma vez', async () => {
    const c = new CacheVelho<number>(1000, 5000);
    const calc = jest.fn(async () => 1);
    expect(await c.ler('k', calc)).toBe(1);
    andar(500);
    expect(await c.ler('k', calc)).toBe(1);
    expect(calc).toHaveBeenCalledTimes(1);
  });

  it('valor velho: devolve o antigo na hora, um recálculo só, a leitura seguinte traz o novo', async () => {
    const c = new CacheVelho<number>(1000, 5000);
    let n = 0;
    const calc = jest.fn(async () => ++n);
    await c.ler('k', calc);
    andar(2000);
    const [a, b] = await Promise.all([c.ler('k', calc), c.ler('k', calc)]);
    expect([a, b]).toEqual([1, 1]);
    expect(calc).toHaveBeenCalledTimes(2);
    await esvaziar();
    expect(await c.ler('k', calc)).toBe(2);
    expect(calc).toHaveBeenCalledTimes(2);
  });

  it('vencido (>= maxVelho): espera o cálculo', async () => {
    const c = new CacheVelho<number>(1000, 5000);
    let n = 0;
    const calc = async () => ++n;
    await c.ler('k', calc);
    andar(5000);
    expect(await c.ler('k', calc)).toBe(2);
  });

  it('falha com valor velho: segue devolvendo o velho, avisa e tenta de novo na próxima', async () => {
    const aoFalhar = jest.fn();
    const c = new CacheVelho<number>(1000, 5000, aoFalhar);
    await c.ler('k', async () => 1);
    andar(2000);
    const falha = jest.fn(async (): Promise<number> => {
      throw new Error('fora');
    });
    expect(await c.ler('k', falha)).toBe(1);
    await esvaziar();
    expect(aoFalhar).toHaveBeenCalledWith('k', expect.objectContaining({ message: 'fora' }));
    expect(await c.ler('k', falha)).toBe(1);
    await esvaziar();
    expect(falha).toHaveBeenCalledTimes(2);
  });

  it('falha sem valor: rejeita e a próxima recalcula', async () => {
    const c = new CacheVelho<number>(1000, 5000);
    await expect(c.ler('k', async () => Promise.reject(new Error('fora')))).rejects.toThrow('fora');
    expect(await c.ler('k', async () => 7)).toBe(7);
  });

  it('renovar recalcula mesmo com valor novo', async () => {
    const c = new CacheVelho<number>(1000, 5000);
    await c.ler('k', async () => 1);
    expect(await c.renovar('k', async () => 2)).toBe(2);
    expect(await c.ler('k', async () => 3)).toBe(2);
  });
});
