import { OrcamentoService } from './orcamento.service';
import { BolsaAquecimentoScheduler } from './bolsa-aquecimento.scheduler';

/** Aquecimento da bolsa: falha de um vendedor não para os outros; rodada não sobrepõe outra. */
describe('aquecimento da bolsa', () => {
  it('vendedor 1 falha, vendedor 2 fica aquecido e a leitura seguinte não recalcula', async () => {
    const db = { repsComFechados: jest.fn(async () => [1, 2]), ajustes: jest.fn(async () => []) };
    const service = new OrcamentoService({} as never, {} as never, db as never, {} as never, {} as never);
    const casarFechados = jest.fn(async (rep: number) => {
      if (rep === 1) throw new Error('BI fora');
      return { linhas: [] };
    });
    Object.assign(service, { casarFechados, pisoVigente: async () => ({ piso: 1.5 }) });

    const r = await service.aquecerBolsa();
    expect(r.vendedores).toBe(2);
    expect(r.falhas).toBe(1);
    expect(r.lentos.map((l) => l.rep)).toEqual([1, 2]);
    expect(db.ajustes).toHaveBeenCalledTimes(2); // só o vendedor 2: janelas de 2 e 8 meses

    await service.casamentoDoRep(2);
    expect(casarFechados.mock.calls.filter(([rep]) => rep === 2)).toHaveLength(1);
  });

  it('segunda chamada com a rodada em andamento não começa outra', async () => {
    let terminar!: () => void;
    const aquecerBolsa = jest.fn(() => new Promise<void>((ok) => (terminar = ok)));
    const s = new BolsaAquecimentoScheduler({ aquecerBolsa } as never);
    const primeira = s.aquecer();
    await s.aquecer();
    expect(aquecerBolsa).toHaveBeenCalledTimes(1);
    terminar();
    await primeira;
    const terceira = s.aquecer();
    expect(aquecerBolsa).toHaveBeenCalledTimes(2);
    terminar();
    await terceira;
  });
});
