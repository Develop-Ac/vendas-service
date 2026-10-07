import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';

/** Filtros da lista de orçamentos: o `where` que chega ao Prisma (uma consulta, paginada). */
describe('OrcamentoPrismaRepository.listar — filtros', () => {
  const montar = async (f: Parameters<OrcamentoPrismaRepository['listar']>[0]) => {
    const where: any[] = [];
    const prisma = {
      ven_orcamento: {
        count: jest.fn(async (a: any) => (where.push(a.where), 0)),
        findMany: jest.fn(async () => []),
      },
      $transaction: (ps: Promise<unknown>[]) => Promise.all(ps),
    };
    await new OrcamentoPrismaRepository(prisma as any).listar(f);
    return where[0];
  };

  it('sem filtro novo mantém o where de antes', async () => {
    expect(await montar({ rep_codigo: 7 })).toEqual({ rep_codigo: 7 });
  });

  it('período em dias de Cuiabá, ate inclusivo', async () => {
    const w = await montar({ de: '2026-10-01', ate: '2026-10-02' });
    expect(w.created_at.gte.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(w.created_at.lt.toISOString()).toBe('2026-10-03T04:00:00.000Z');
  });

  it('número casa intranet ou Celta; produto por código ou descrição; flags', async () => {
    expect((await montar({ numero: 123 })).AND).toEqual([{ OR: [{ numero: 123 }, { celta_orcamento: 123 }] }]);
    expect((await montar({ produto: '4521' })).AND).toEqual([{ itens: { some: { pro_codigo: 4521 } } }]);
    expect((await montar({ produto: 'farol' })).AND).toEqual([{ itens: { some: { descricao: { contains: 'farol', mode: 'insensitive' } } } }]);
    expect((await montar({ flag: 'SEM_CELTA' })).AND).toEqual([{ status: 'FECHADO', celta_orcamento: null }]);
    expect((await montar({ flag: 'ACIMA_ALCADA' })).AND).toEqual([{ acima_alcada: true }]);
    expect((await montar({ flag: 'AGUARDANDO' })).AND).toEqual([{ status: 'APROVACAO' }]);
  });
});
