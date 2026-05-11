import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface UpdateProdutoCarroData {
  carro_1?: string | null;
  carro_2?: string | null;
  carro_3?: string | null;
  carro_4?: string | null;
  carro_5?: string | null;
  carro_6?: string | null;
  carro_7?: string | null;
  carro_8?: string | null;
  carro_9?: string | null;
  carro_10?: string | null;
  ano_1?: string | null;
  ano_2?: string | null;
  ano_3?: string | null;
  ano_4?: string | null;
  ano_5?: string | null;
  ano_6?: string | null;
  ano_7?: string | null;
  ano_8?: string | null;
  ano_9?: string | null;
  ano_10?: string | null;
}

@Injectable()
export class BuscaItensRepository {
  constructor(private readonly prisma: PrismaService) {}

  async updateProdutoCarro(proCodigo: string, data: UpdateProdutoCarroData) {
    const existing = await this.prisma.$queryRaw<any[]>`
      SELECT pro_codigo FROM eco_produtos_carros WHERE pro_codigo = ${proCodigo} LIMIT 1
    `;

    if (!existing || existing.length === 0) {
      throw new NotFoundException(`Produto com código "${proCodigo}" não encontrado em eco_produtos_carros.`);
    }

    await this.prisma.$executeRaw`
      UPDATE eco_produtos_carros
      SET
        carro_1  = ${data.carro_1  ?? null},
        carro_2  = ${data.carro_2  ?? null},
        carro_3  = ${data.carro_3  ?? null},
        carro_4  = ${data.carro_4  ?? null},
        carro_5  = ${data.carro_5  ?? null},
        carro_6  = ${data.carro_6  ?? null},
        carro_7  = ${data.carro_7  ?? null},
        carro_8  = ${data.carro_8  ?? null},
        carro_9  = ${data.carro_9  ?? null},
        carro_10 = ${data.carro_10 ?? null},
        ano_1    = ${data.ano_1    ?? null},
        ano_2    = ${data.ano_2    ?? null},
        ano_3    = ${data.ano_3    ?? null},
        ano_4    = ${data.ano_4    ?? null},
        ano_5    = ${data.ano_5    ?? null},
        ano_6    = ${data.ano_6    ?? null},
        ano_7    = ${data.ano_7    ?? null},
        ano_8    = ${data.ano_8    ?? null},
        ano_9    = ${data.ano_9    ?? null},
        ano_10   = ${data.ano_10   ?? null},
        status   = ${'Verificado'}
      WHERE pro_codigo = ${proCodigo}
    `;

    return { message: 'Produto atualizado com sucesso', pro_codigo: proCodigo };
  }
}
