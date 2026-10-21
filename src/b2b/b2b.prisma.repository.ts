import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrcamentoB2bItemInput {
  pro_codigo: number;
  quantidade: number;
  promocao: string | null;
  /** Preço unitário que o comprador viu; `null` quando ele não vê preço. */
  preco_unitario: number | null;
}

export interface OrcamentoB2bGravado {
  id: string;
  orderNumber: string;
  userId: string;
  pedidoId: string | null;
  comprador: string | null;
  status: string | null;
  createdAt: Date;
  /** `null` nos pedidos gravados antes da coluna existir. */
  clienteViuPreco: boolean | null;
  margem: number | null;
  /** Cliente do Celta da empresa; `null` = ainda sem vínculo. */
  cli_codigo: number | null;
  /** Vendedor atribuído pela gestão só para este pedido. */
  rep_codigo: number | null;
  rep_nome: string | null;
  itens: {
    pro_codigo: number;
    quantidade: number;
    promocao: string | null;
    preco_unitario: number | null;
  }[];
}

export interface OrcamentoB2bInput {
  orderNumber: string;
  userId: string;
  pedidoId: string | null;
  comprador: string | null;
  status: string | null;
  createdAt: Date | null;
  clienteViuPreco: boolean | null;
  margem: number | null;
  cli_codigo: number | null;
  itens: OrcamentoB2bItemInput[];
}

/** Vendedor do cliente na carteirização (espelho do ERP em ven_carteira_cliente). */
export interface VendedorDaCarteira {
  rep_codigo: number;
  rep_nome: string | null;
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

/** As colunas `NUMERIC` chegam como `Decimal`; a API entrega `number`. */
function paraNumero(valor: Prisma.Decimal | null): number | null {
  return valor === null ? null : valor.toNumber();
}

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
      clienteViuPreco: row.clienteViuPreco,
      margem: paraNumero(row.margem),
      cli_codigo: row.cli_codigo,
      rep_codigo: row.rep_codigo,
      rep_nome: row.rep_nome,
      itens: row.ven_orcamento_b2b_itens.map((item) => ({
        pro_codigo: item.pro_codigo,
        quantidade: item.quantidade,
        promocao: item.promocao,
        preco_unitario: paraNumero(item.preco_unitario),
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
        clienteViuPreco: pedido.clienteViuPreco,
        margem: pedido.margem,
        cli_codigo: pedido.cli_codigo,
        // Sem status no payload, fica o default do banco ('PENDING').
        ...(pedido.status ? { status: pedido.status } : {}),
        ...(pedido.createdAt ? { createdAt: pedido.createdAt } : {}),
        ven_orcamento_b2b_itens: {
          create: pedido.itens.map((item) => ({
            pro_codigo: item.pro_codigo,
            quantidade: item.quantidade,
            promocao: item.promocao,
            preco_unitario: item.preco_unitario,
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
  ): Promise<{
    id: string;
    orderNumber: string;
    pedidoId: string | null;
    status: string;
    cli_codigo: number | null;
  } | null> {
    const where: Prisma.ven_orcamento_b2bWhereInput[] = [
      { orderNumber: identificador },
      { pedidoId: identificador },
    ];
    // A coluna id é uuid: um valor fora desse formato faz o Postgres recusar a
    // query inteira, então só entra no OR quando for mesmo um uuid.
    if (UUID_RE.test(identificador)) where.unshift({ id: identificador });

    return this.prisma.ven_orcamento_b2b.findFirst({
      where: { OR: where },
      select: {
        id: true,
        orderNumber: true,
        pedidoId: true,
        status: true,
        cli_codigo: true,
      },
    });
  }

  /** Novo status do pedido já localizado. */
  async atualizarStatus(id: string, status: string): Promise<void> {
    await this.prisma.ven_orcamento_b2b.update({
      where: { id },
      data: { status },
    });
  }

  /**
   * Preenche o cliente do Celta nos pedidos gravados antes do vínculo da
   * empresa. Só onde ainda está vazio: um vínculo trocado depois não reescreve
   * o cliente de pedido antigo.
   */
  async preencherCliente(orderNumbers: string[], cliCodigo: number): Promise<number> {
    if (!orderNumbers.length) return 0;
    const { count } = await this.prisma.ven_orcamento_b2b.updateMany({
      where: { orderNumber: { in: orderNumbers }, cli_codigo: null },
      data: { cli_codigo: cliCodigo },
    });
    return count;
  }

  /** O vendedor de cada cliente na carteirização; cliente sem vendedor fica de fora. */
  async vendedoresDaCarteira(
    cliCodigos: number[],
  ): Promise<Map<number, VendedorDaCarteira>> {
    if (!cliCodigos.length) return new Map();
    const rows = await this.prisma.ven_carteira_cliente.findMany({
      where: {
        cli_codigo: { in: [...new Set(cliCodigos)] },
        trash: 0,
        rep_codigo: { not: null },
      },
      select: { cli_codigo: true, rep_codigo: true, rep_nome: true },
    });
    return new Map(
      rows.map((r) => [
        r.cli_codigo,
        { rep_codigo: r.rep_codigo as number, rep_nome: r.rep_nome },
      ]),
    );
  }

  /** Vendedor do pedido, escolhido pela gestão. Não toca na carteira do cliente. */
  async atribuirVendedor(
    id: string,
    vendedor: { rep_codigo: number; rep_nome: string; atribuido_por: string | null },
  ): Promise<void> {
    await this.prisma.ven_orcamento_b2b.update({
      where: { id },
      data: {
        rep_codigo: vendedor.rep_codigo,
        rep_nome: vendedor.rep_nome,
        rep_atribuido_por: vendedor.atribuido_por,
        rep_atribuido_em: new Date(),
      },
    });
  }
}
