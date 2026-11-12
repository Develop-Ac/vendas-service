import { cronometro } from './leitura-lenta';

describe('cronometro (log de leitura lenta)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-12T10:00:00Z')));
  afterEach(() => jest.useRealTimers());

  const depois = <T>(ms: number, v: T) => new Promise<T>((ok) => setTimeout(() => ok(v), ms));

  async function rodar(limite: number, ms: number) {
    const t = cronometro(limite);
    const p = Promise.all([t.etapa('postgres', depois(ms, 1)), t.etapa('bolsa', depois(ms / 2, 2))]);
    await jest.advanceTimersByTimeAsync(ms);
    await p;
    const avisar = jest.fn();
    t.fim('lista (bolsaNf=1)', avisar);
    return avisar;
  }

  it('acima do limite avisa uma vez com o tempo de cada etapa', async () => {
    const avisar = await rodar(2000, 3000);
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar).toHaveBeenCalledWith('Leitura lenta: lista (bolsaNf=1) 3000ms · bolsa 1500ms · postgres 3000ms');
  });

  it('abaixo do limite não avisa', async () => {
    expect(await rodar(2000, 1000)).not.toHaveBeenCalled();
  });

  it('limite 0 desliga', async () => {
    expect(await rodar(0, 3000)).not.toHaveBeenCalled();
  });

  it('etapa repassa valor e rejeição sem alterar', async () => {
    const t = cronometro(1);
    await expect(t.etapa('a', Promise.resolve(42))).resolves.toBe(42);
    const erro = new Error('fora');
    await expect(t.etapa('b', Promise.reject(erro))).rejects.toBe(erro);
  });
});
