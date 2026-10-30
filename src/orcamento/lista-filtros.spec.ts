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

  describe('retornos de hoje', () => {
    // 01:00 UTC de 30/10 ainda é 29/10 em Cuiabá: o dia do retorno segue Cuiabá, não o UTC.
    beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-30T01:00:00Z')));
    afterEach(() => jest.useRealTimers());
    const hoje = new Date('2026-10-29T00:00:00Z');

    it('flag RETORNO_HOJE filtra adiados com retorno no dia de Cuiabá', async () => {
      expect((await montar({ flag: 'RETORNO_HOJE' })).AND).toEqual([{ status: 'ADIADO', retorno_em: hoje }]);
    });

    it('página 1 sem flag: retornos do dia vêm primeiro e saem do restante', async () => {
      const retorno = { id: 9, status: 'ADIADO', retorno_em: hoje };
      const findMany = jest.fn().mockResolvedValueOnce([retorno]).mockResolvedValueOnce([{ id: 1, status: 'ENVIADO' }]);
      const prisma = {
        ven_orcamento: { count: jest.fn(async () => 2), findMany },
        $transaction: (ps: Promise<unknown>[]) => Promise.all(ps),
      };
      const r = await new OrcamentoPrismaRepository(prisma as any).listar({ rep_codigo: 7, pageSize: 10 });
      expect(findMany.mock.calls[0][0].where).toEqual({ rep_codigo: 7, AND: [{ status: 'ADIADO', retorno_em: hoje }] });
      expect(findMany.mock.calls[1][0]).toMatchObject({ where: { rep_codigo: 7, AND: [{ id: { notIn: [9] } }] }, skip: 0, take: 9 });
      expect(r.total).toBe(2);
      expect(r.itens.map((o) => [o.id, o.retorno_hoje])).toEqual([[9, true], [1, false]]);
    });

    it('página 2 desloca o skip pelo que foi ao topo', async () => {
      const findMany = jest.fn().mockResolvedValueOnce([{ id: 9 }]).mockResolvedValueOnce([]);
      const prisma = { ven_orcamento: { count: jest.fn(async () => 0), findMany }, $transaction: (ps: Promise<unknown>[]) => Promise.all(ps) };
      const r = await new OrcamentoPrismaRepository(prisma as any).listar({ page: 2, pageSize: 10 });
      expect(findMany.mock.calls[1][0]).toMatchObject({ skip: 9, take: 10 });
      expect(r.itens).toEqual([]);
    });
  });
});
