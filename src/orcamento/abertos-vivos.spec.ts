import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';

/** "Em aberto" da bolsa: só orçamento na validade, ou adiado com retorno de hoje em diante. */
describe('OrcamentoPrismaRepository.abertosDoVendedor — só vivos', () => {
  // 02:00 UTC de 13/11 ainda é 12/11 em Cuiabá.
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-13T02:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('where exige validade ou retorno de hoje (Cuiabá) em diante', async () => {
    const findMany = jest.fn(async () => []);
    await new OrcamentoPrismaRepository({ ven_orcamento: { findMany } } as any).abertosDoVendedor(7);
    const w = (findMany.mock.calls[0] as any[])[0].where;
    const hoje = new Date('2026-11-12T00:00:00.000Z');
    expect(w.rep_codigo).toBe(7);
    expect(w.status).toEqual({ in: ['ENVIADO', 'APROVACAO', 'ADIADO'] });
    expect(w.OR).toEqual([{ validade: { gte: hoje } }, { status: 'ADIADO', retorno_em: { gte: hoje } }]);
    expect(w.OR[0].validade.gte.toISOString()).toBe('2026-11-12T00:00:00.000Z');
  });
});
