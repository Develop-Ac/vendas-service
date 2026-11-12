import { OrcamentoService } from './orcamento.service';

/** Caches da bolsa: falha não vira resultado guardado; valor velho segue servido; casamento reaproveitado. */
describe('caches da bolsa', () => {
  const montar = () => {
    const db = { ajustes: jest.fn() };
    const service = new OrcamentoService({} as never, {} as never, db as never, {} as never, {} as never);
    const s = service as unknown as Record<string, unknown>;
    return { service, db, s };
  };
  const efetivo = (s: Record<string, unknown>) => (s.efetivoAjustes as (rep: number, meses: number, piso: number) => Promise<unknown[]>).call(s, 1, 2, 1.5);

  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-12T12:00:00')));
  afterEach(() => jest.useRealTimers());

  it('efetivoAjustes com falha devolve [] e a chamada seguinte consulta de novo', async () => {
    const { db, s } = montar();
    db.ajustes.mockRejectedValue(new Error('BI fora'));
    expect(await efetivo(s)).toEqual([]);
    expect(await efetivo(s)).toEqual([]);
    expect(db.ajustes).toHaveBeenCalledTimes(2);
  });

  it('efetivoAjustes com valor bom e falha depois de 6 min devolve o valor anterior', async () => {
    const { db, s } = montar();
    const bom = [{ nf: 1 }];
    Object.assign(s, { casarAjustesComNf: async () => ({ linhas: bom }) });
    db.ajustes.mockResolvedValueOnce([{ id: 1 }]);
    expect(await efetivo(s)).toBe(bom);
    jest.setSystemTime(Date.now() + 6 * 60_000);
    db.ajustes.mockRejectedValue(new Error('BI fora'));
    expect(await efetivo(s)).toBe(bom);
    expect(db.ajustes).toHaveBeenCalledTimes(2);
  });

  it('casamentoDoRep duas vezes em 5 min calcula uma vez', async () => {
    const { service, s } = montar();
    const casarFechados = jest.fn(async () => ({ linhas: [] }));
    Object.assign(s, { casarFechados });
    await service.casamentoDoRep(7);
    jest.setSystemTime(Date.now() + 4 * 60_000);
    await service.casamentoDoRep(7);
    expect(casarFechados).toHaveBeenCalledTimes(1);
  });

  const teto = { corte: 0.3, pct: 0.5, desde: '2026-11-01' };
  const montarMes = () => {
    const bi = {
      bolsaVendedor: jest.fn(async () => ({ venda_liquida: 100, custo: 50, desconto: 0, absorvido: 0, excedente: 0 })),
      dreCanalMensal: jest.fn(),
    };
    const service = new OrcamentoService({} as never, bi as never, {} as never, {} as never, {} as never);
    const s = service as unknown as Record<string, unknown>;
    const efetivoAjustes = jest.fn(async () => []);
    Object.assign(s, { efetivoAjustes, absorvidoPromoPortalNoMes: async () => 0 });
    const mes = (direto?: boolean) =>
      (s.mesDaBolsa as (...a: unknown[]) => Promise<unknown>).call(s, 1, { ano: 2026, mes: 11 }, 1.5, [], [], 2, teto, direto);
    return { bi, s, mes, efetivoAjustes };
  };

  it('mesDaBolsa no mesmo minuto lê o BI uma vez; depois de 61 s lê de novo', async () => {
    const { bi, mes } = montarMes();
    await mes();
    await mes();
    expect(bi.bolsaVendedor).toHaveBeenCalledTimes(1);
    jest.setSystemTime(Date.now() + 61_000);
    await mes();
    expect(bi.bolsaVendedor).toHaveBeenCalledTimes(2);
  });

  it('mesDaBolsa direto ignora o cache e pede os ajustes direto', async () => {
    const { bi, mes, efetivoAjustes } = montarMes();
    await mes();
    await mes(true);
    expect(bi.bolsaVendedor).toHaveBeenCalledTimes(2);
    expect(efetivoAjustes).toHaveBeenLastCalledWith(1, 2, 1.5, true);
  });

  it('pisoVigente no modo dre: DRE fora dá o piso fixo sem guardar; DRE ok fica em cache', async () => {
    const { bi, s } = montarMes();
    const piso = () => (s.pisoVigente as (p: unknown) => Promise<{ piso: number }>).call(s, { ano: 2026, mes: 11 });
    const fixo = (s.parametros as () => { bolsa_piso: number }).call(s).bolsa_piso;
    bi.dreCanalMensal.mockRejectedValue(new Error('BI fora'));
    expect((await piso()).piso).toBe(fixo);
    bi.dreCanalMensal.mockResolvedValue([]);
    await piso();
    expect(bi.dreCanalMensal).toHaveBeenCalledTimes(2);
    await piso();
    expect(bi.dreCanalMensal).toHaveBeenCalledTimes(2);
  });
});
