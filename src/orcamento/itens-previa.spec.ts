import { NotFoundException } from '@nestjs/common';
import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';
import { OrcamentoService } from './orcamento.service';

/** GET /orcamento/:id/itens: prévia dos itens só com o Postgres, sem custo/desconto máximo/preço mínimo. */
describe('prévia dos itens do orçamento', () => {
  const repo = (row: unknown) => {
    const findUnique = jest.fn(async () => row);
    return { findUnique, db: new OrcamentoPrismaRepository({ ven_orcamento: { findUnique } } as any) };
  };

  it('Decimals viram número, ordem mantida e contagem certa', async () => {
    const { db, findUnique } = repo({
      itens: [
        { pro_codigo: 10, descricao: 'Farol', quantidade: '2.000', preco_unit: '15.50', total: '31.00' },
        { pro_codigo: 5, descricao: null, quantidade: '1.000', preco_unit: '7.25', total: '7.25' },
      ],
    });
    expect(await db.itensPrevia('o1')).toEqual({
      quantidade_itens: 2,
      itens: [
        { pro_codigo: 10, descricao: 'Farol', quantidade: 2, preco_unit: 15.5, total: 31 },
        { pro_codigo: 5, descricao: null, quantidade: 1, preco_unit: 7.25, total: 7.25 },
      ],
    });
    const arg = (findUnique.mock.calls[0] as any[])[0];
    expect(arg.where).toEqual({ id: 'o1' });
    expect(arg.select.itens.orderBy).toEqual({ item: 'asc' });
    expect(Object.keys(arg.select.itens.select).sort()).toEqual(['descricao', 'preco_unit', 'pro_codigo', 'quantidade', 'total']);
  });

  it('inexistente → null no repositório', async () => {
    expect(await repo(null).db.itensPrevia('x')).toBeNull();
  });

  // erp e bi vazios: qualquer consulta a eles quebraria o teste
  const service = (r: unknown) => new OrcamentoService({} as never, {} as never, { itensPrevia: jest.fn(async () => r) } as never, {} as never, {} as never, {} as never);

  it('service devolve a prévia sem consultar ERP nem BI', async () => {
    const r = { quantidade_itens: 1, itens: [{ pro_codigo: 1, descricao: 'X', quantidade: 1, preco_unit: 2, total: 2 }] };
    expect(await service(r).itens('o1')).toBe(r);
  });

  it('inexistente → 404', async () => {
    await expect(service(null).itens('x')).rejects.toThrow(NotFoundException);
  });
});
