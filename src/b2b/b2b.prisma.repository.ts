import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrcamentoB2bItemInput {
  pro_codigo: number;
  quantidade: number;
  promocao: string | null;
}

export interface OrcamentoB2bGravado {
  id: string;
  orderNumber: string;
  userId: string;
  pedidoId: string | null;
  comprador: string | null;
  status: string | null;
  createdAt: Date;
  itens: {
    pro_codigo: number;
    quantidade: number;
    promocao: string | null;
  }[];
}

export interface OrcamentoB2bInput {
  orderNumber: string;
  userId: string;
  pedidoId: string | null;
  comprador: string | null;
  status: string | null;
  createdAt: Date | null;
  itens: OrcamentoB2bItemInput[];
}

/* =============================================================================
   B2B — persistência no Postgres da intranet.
   -----------------------------------------------------------------------------
   Os pedidos que chegam do portal B2B são gravados uma única vez em
   ven_orcamento_b2b (com os itens em ven_orcamento_b2b_itens); o orderNumber é
   a chave de deduplicação.
   ============================================================================= */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class B2bPrismaRepository {
  private readonly logger = new Logger(B2bPrismaRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Os pedidos já gravados, com seus itens, do mais recente para o mais antigo. */
  async listarPedidos(): Promise<OrcamentoB2bGravado[]> {
    const rows = await this.prisma.ven_orcamento_b2b.findMany({
      orderBy: { createdAt: 'desc' },
      include: { ven_orcamento_b2b_itens: true },
    });

    return rows.map((row) => ({
      id: row.id,
      orderNumber: row.orderNumber,
      userId: row.userId,
      pedidoId: row.pedidoId,
      comprador: row.comprador,
      status: row.status,
      createdAt: row.createdAt,
      itens: row.ven_orcamento_b2b_itens.map((item) => ({
        pro_codigo: item.pro_codigo,
        quantidade: item.quantidade,
        promocao: item.promocao,
      })),
    }));
  }

  /** Dos orderNumbers informados, os que já estão gravados. */
  async orderNumbersExistentes(orderNumbers: string[]): Promise<Set<string>> {
    if (!orderNumbers.length) return new Set();
    const rows = await this.prisma.ven_orcamento_b2b.findMany({
      where: { orderNumber: { in: orderNumbers } },
      select: { orderNumber: true },
    });
    return new Set(rows.map((r) => r.orderNumber));
  }

  /** Grava o pedido e seus itens numa única transação. */
  async salvarPedido(pedido: OrcamentoB2bInput): Promise<void> {
    await this.prisma.ven_orcamento_b2b.create({
      data: {
        orderNumber: pedido.orderNumber,
        userId: pedido.userId,
        pedidoId: pedido.pedidoId,
        comprador: pedido.comprador,
        status: pedido.status,
        ...(pedido.createdAt ? { createdAt: pedido.createdAt } : {}),
        ven_orcamento_b2b_itens: {
          create: pedido.itens.map((item) => ({
            pro_codigo: item.pro_codigo,
            quantidade: item.quantidade,
            promocao: item.promocao,
          })),
        },
      },
    });
  }

  /**
   * O pedido gravado. O identificador aceito é o id do registro aqui, o
   * orderNumber ou o pedidoId do portal — a listagem devolve os dois últimos, e
   * o id só existe depois da gravação.
   */
  async buscarPorIdentificador(
    identificador: string,
  ): Promise<{ id: string; orderNumber: string; pedidoId: string | null } | null> {
    const where: Prisma.ven_orcamento_b2bWhereInput[] = [
      { orderNumber: identificador },
      { pedidoId: identificador },
    ];
    // A coluna id é uuid: um valor fora desse formato faz o Postgres recusar a
    // query inteira, então só entra no OR quando for mesmo um uuid.
    if (UUID_RE.test(identificador)) where.unshift({ id: identificador });

    return this.prisma.ven_orcamento_b2b.findFirst({
      where: { OR: where },
      select: { id: true, orderNumber: true, pedidoId: true },
    });
  }

  /** Novo status do pedido já localizado. */
  async atualizarStatus(id: string, status: string): Promise<void> {
    await this.prisma.ven_orcamento_b2b.update({
      where: { id },
      data: { status },
    });
  }
}
