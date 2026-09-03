import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ven_encomenda_pecas, ven_encomenda_pecas_itens } from '@prisma/client';

export type CreateVendaCasadaItemInput = Omit<ven_encomenda_pecas_itens, 'id'>;

export type VendaCasadaComItens = Omit<ven_encomenda_pecas, 'pecas_cotadas'> & {
  pecas_cotadas: ven_encomenda_pecas_itens[];
};

@Injectable()
export class EncomendaPecasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ven_encomenda_pecas[]> {
    return this.prisma.ven_encomenda_pecas.findMany({
      orderBy: { id: 'desc' },
    });
  }

  async findById(id: number): Promise<VendaCasadaComItens | null> {
    const venda = await this.prisma.ven_encomenda_pecas.findUnique({
      where: { id },
    });
    if (!venda) return null;

    const ids = (venda.pecas_cotadas ?? [])
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n));

    const itens = ids.length
      ? await this.prisma.ven_encomenda_pecas_itens.findMany({
          where: { id: { in: ids } },
        })
      : [];

    const itensPorId = new Map(itens.map((i) => [i.id, i]));
    const itensOrdenados = ids
      .map((i) => itensPorId.get(i))
      .filter((i): i is ven_encomenda_pecas_itens => i !== undefined);

    return { ...venda, pecas_cotadas: itensOrdenados };
  }

  async create(data: Omit<ven_encomenda_pecas, 'id'>): Promise<ven_encomenda_pecas> {
    return this.prisma.ven_encomenda_pecas.create({ data });
  }

  async addPecasCotadas(
    vendaCasadaId: number,
    itens: CreateVendaCasadaItemInput[],
  ): Promise<{ created: ven_encomenda_pecas_itens[]; venda: ven_encomenda_pecas }> {
    return this.prisma.$transaction(async (tx) => {
      const created: ven_encomenda_pecas_itens[] = [];
      for (const item of itens) {
        const novo = await tx.ven_encomenda_pecas_itens.create({ data: item });
        created.push(novo);
      }

      const venda = await tx.ven_encomenda_pecas.findUnique({
        where: { id: vendaCasadaId },
        select: { pecas_cotadas: true },
      });

      const novosIds = created.map((i) => String(i.id));
      const atualizadas = [...(venda?.pecas_cotadas ?? []), ...novosIds];

      const vendaAtualizada = await tx.ven_encomenda_pecas.update({
        where: { id: vendaCasadaId },
        data: { pecas_cotadas: atualizadas },
      });

      return { created, venda: vendaAtualizada };
    });
  }
}
