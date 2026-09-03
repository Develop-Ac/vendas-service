import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ven_encomenda_pecas,
  ven_encomenda_pecas_anexos,
  ven_encomenda_pecas_itens_cotados,
  ven_encomenda_pecas_itens_encomendados,
} from '@prisma/client';

/**
 * Origem do anexo: `carro` para as imagens mandadas na criação da encomenda e
 * `comprovante` para os arquivos enviados depois, em POST /encomenda-pecas/anexo/:id.
 */
export const ANEXO_TIPO_CARRO = 'carro';
export const ANEXO_TIPO_COMPROVANTE = 'comprovante';
export type AnexoTipo = typeof ANEXO_TIPO_CARRO | typeof ANEXO_TIPO_COMPROVANTE;

/** Campos escalares da encomenda (sem o id autoincrement nem created_at, que tem default no banco). */
export type CreateEncomendaPecasInput = Omit<ven_encomenda_pecas, 'id' | 'created_at'>;

/** Item encomendado; o id é uuid gerado pelo banco e o vínculo vem do create aninhado. */
export type CreateItemEncomendadoInput = Omit<
  ven_encomenda_pecas_itens_encomendados,
  'id' | 'encomenda_pecas_id'
>;

export type CreateVendaCasadaItemInput = Omit<
  ven_encomenda_pecas_itens_cotados,
  'id' | 'encomenda_pecas_id'
>;

export type VendaCasadaComItens = ven_encomenda_pecas & {
  pecas: ven_encomenda_pecas_itens_encomendados[];
  pecas_cotadas: ven_encomenda_pecas_itens_cotados[];
  anexos: ven_encomenda_pecas_anexos[];
};

/** Traz as três tabelas filhas junto com a encomenda. */
const INCLUDE_ITENS = {
  ven_encomenda_pecas_itens_encomendados: { orderBy: { pro_descricao: 'asc' } },
  ven_encomenda_pecas_itens_cotados: { orderBy: { id: 'asc' } },
  ven_encomenda_pecas_anexos: { orderBy: { anexo: 'asc' } },
} as const;

type EncomendaComRelacoes = ven_encomenda_pecas & {
  ven_encomenda_pecas_itens_encomendados: ven_encomenda_pecas_itens_encomendados[];
  ven_encomenda_pecas_itens_cotados: ven_encomenda_pecas_itens_cotados[];
  ven_encomenda_pecas_anexos: ven_encomenda_pecas_anexos[];
};

/** Os nomes das relações vêm do `prisma db pull`; para fora expomos nomes curtos. */
function toVendaCasadaComItens(encomenda: EncomendaComRelacoes): VendaCasadaComItens {
  const {
    ven_encomenda_pecas_itens_encomendados: pecas,
    ven_encomenda_pecas_itens_cotados: pecasCotadas,
    ven_encomenda_pecas_anexos: anexos,
    ...resto
  } = encomenda;
  return { ...resto, pecas, pecas_cotadas: pecasCotadas, anexos };
}

@Injectable()
export class EncomendaPecasRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<VendaCasadaComItens[]> {
    const encomendas = await this.prisma.ven_encomenda_pecas.findMany({
      orderBy: { id: 'desc' },
      include: INCLUDE_ITENS,
    });
    return encomendas.map(toVendaCasadaComItens);
  }

  async findById(id: number): Promise<VendaCasadaComItens | null> {
    const encomenda = await this.prisma.ven_encomenda_pecas.findUnique({
      where: { id },
      include: INCLUDE_ITENS,
    });
    if (!encomenda) return null;
    return toVendaCasadaComItens(encomenda);
  }

  /** Cria a encomenda e os itens encomendados na mesma transação (create aninhado). */
  async create(
    data: CreateEncomendaPecasInput,
    itens: CreateItemEncomendadoInput[],
  ): Promise<VendaCasadaComItens> {
    const encomenda = await this.prisma.ven_encomenda_pecas.create({
      data: {
        ...data,
        ven_encomenda_pecas_itens_encomendados: { create: itens },
      },
      include: INCLUDE_ITENS,
    });
    return toVendaCasadaComItens(encomenda);
  }

  async addPecasCotadas(
    vendaCasadaId: number,
    itens: CreateVendaCasadaItemInput[],
  ): Promise<{
    created: ven_encomenda_pecas_itens_cotados[];
    venda: VendaCasadaComItens;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const created: ven_encomenda_pecas_itens_cotados[] = [];
      for (const item of itens) {
        const novo = await tx.ven_encomenda_pecas_itens_cotados.create({
          data: { ...item, encomenda_pecas_id: vendaCasadaId },
        });
        created.push(novo);
      }

      const venda = await tx.ven_encomenda_pecas.findUniqueOrThrow({
        where: { id: vendaCasadaId },
        include: INCLUDE_ITENS,
      });

      return { created, venda: toVendaCasadaComItens(venda) };
    });
  }

  async updateStatus(id: number, status: string): Promise<VendaCasadaComItens> {
    const encomenda = await this.prisma.ven_encomenda_pecas.update({
      where: { id },
      data: { status },
      include: INCLUDE_ITENS,
    });
    return toVendaCasadaComItens(encomenda);
  }

  async findItemCotadoById(
    id: number,
  ): Promise<ven_encomenda_pecas_itens_cotados | null> {
    return this.prisma.ven_encomenda_pecas_itens_cotados.findUnique({ where: { id } });
  }

  async updateItemCotadoAutorizado(
    id: number,
    autorizado: boolean,
  ): Promise<ven_encomenda_pecas_itens_cotados> {
    return this.prisma.ven_encomenda_pecas_itens_cotados.update({
      where: { id },
      data: { autorizado },
    });
  }

  /**
   * Salva as chaves dos anexos já enviados ao MinIO, vinculadas à encomenda.
   * `tipo` diz de onde veio o arquivo (ver AnexoTipo).
   */
  async addAnexos(
    vendaCasadaId: number,
    chaves: string[],
    tipo: AnexoTipo,
  ): Promise<ven_encomenda_pecas_anexos[]> {
    return this.prisma.$transaction(
      chaves.map((anexo) =>
        this.prisma.ven_encomenda_pecas_anexos.create({
          data: { ven_encomenda_id: vendaCasadaId, anexo, tipo },
        }),
      ),
    );
  }
}
