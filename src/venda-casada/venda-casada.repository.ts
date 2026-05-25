import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ven_venda_casada } from '@prisma/client';

@Injectable()
export class VendaCasadaRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<ven_venda_casada[]> {
    return this.prisma.ven_venda_casada.findMany({
      orderBy: { id: 'desc' },
    });
  }

  async findById(id: number): Promise<ven_venda_casada | null> {
    return this.prisma.ven_venda_casada.findUnique({
      where: { id },
    });
  }

  async create(data: Omit<ven_venda_casada, 'id'>): Promise<ven_venda_casada> {
    return this.prisma.ven_venda_casada.create({ data });
  }
}
