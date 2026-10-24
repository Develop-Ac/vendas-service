import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { semMargem } from './b2b.margem';

export interface OrcamentoB2bItemInput {
  pro_codigo: number;
  quantidade: number;
  promocao: string | null;
  /**
   * Preço unitário que o comprador viu, já SEM a margem dele (o preço da
   * tabela); `null` quando ele não vê preço.
   */
  preco_unitario: number | null;
  /** Promoção do portal: preço puro (sem margem) e fim. */
  promocao_preco?: number | null;
  promocao_fim?: Date | null;
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
    promocao_preco?: number | null;
    promocao_fim?: Date | null;
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
  empresa: string | null;
  observacao: string | null;
  endereco: string | null;
  itens: OrcamentoB2bItemInput[];
}

/** O pedido gravado com o que o "assumir" precisa para montar o orçamento. */
export interface PedidoParaAssumir extends OrcamentoB2bGravado {
  empresa: string | null;
  observacao: string | null;
  endereco: string | null;
  orcamento_id: string | null;
  assumido_em: Date | null;
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

type LinhaB2b = Prisma.ven_orcamento_b2bGetPayload<{
  include: { ven_orcamento_b2b_itens: true };
}>;

function paraGravado(row: LinhaB2b): OrcamentoB2bGravado {
  const margem = paraNumero(row.margem);
  // Linha gravada antes de a margem sair da intranet: o preço ainda a tem.
  const preco = (valor: Prisma.Decimal | null) =>
    row.precoSemMargem
      ? paraNumero(valor)
      : semMargem(paraNumero(valor), margem);
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    userId: row.userId,
    pedidoId: row.pedidoId,
    comprador: row.comprador,
    status: row.status,
    createdAt: row.createdAt,
    clienteViuPreco: row.clienteViuPreco,
    margem,
    cli_codigo: row.cli_codigo,
    rep_codigo: row.rep_codigo,
    rep_nome: row.rep_nome,
    itens: row.ven_orcamento_b2b_itens.map((item) => ({
      pro_codigo: item.pro_codigo,
      quantidade: item.quantidade,
      promocao: item.promocao,
      preco_unitario: preco(item.preco_unitario),
      promocao_preco: paraNumero(item.promocao_preco),
      promocao_fim: item.promocao_fim,
    })),
  };
}

function paraParaAssumir(row: LinhaB2b): PedidoParaAssumir {
  return {
    ...paraGravado(row),
    empresa: row.empresa,
    observacao: row.observacao,
    endereco: row.endereco,
    orcamento_id: row.orcamento_id,
    assumido_em: row.assumido_em,
  };
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
    return rows.map(paraGravado);
  }

  /**
   * Pedidos esperando atendimento, do banco (a busca de cada minuto o mantém
   * em dia): pendentes, criados a partir do corte, sem orçamento nem recusa.
   */
  async listarAguardando(desde: Date): Promise<PedidoParaAssumir[]> {
    const rows = await this.prisma.ven_orcamento_b2b.findMany({
      where: {
        status: 'PENDING',
        createdAt: { gte: desde },
        orcamento_id: null,
        recusado_em: null,
      },
      orderBy: { createdAt: 'asc' },
      include: { ven_orcamento_b2b_itens: true },
    });
    return rows.map(paraParaAssumir);
  }

  async buscarParaAssumir(identificador: string): Promise<PedidoParaAssumir | null> {
    const achado = await this.buscarPorIdentificador(identificador);
    if (!achado) return null;
    const row = await this.prisma.ven_orcamento_b2b.findUnique({
      where: { id: achado.id },
      include: { ven_orcamento_b2b_itens: true },
    });
    return row ? paraParaAssumir(row) : null;
  }

  /**
   * Reserva o pedido para quem assume — antes de criar o orçamento, para dois
   * cliques (ou vendedor e gestão juntos) não gerarem dois. `false` = alguém
   * já reservou ou o pedido não está mais aguardando.
   */
  async reservar(id: string, por: string): Promise<boolean> {
    const { count } = await this.prisma.ven_orcamento_b2b.updateMany({
      where: { id, status: 'PENDING', assumido_em: null, orcamento_id: null, recusado_em: null },
      data: { assumido_em: new Date(), assumido_por: por },
    });
    return count === 1;
  }

  /** Desfaz a reserva quando a criação do orçamento falhou. */
  async liberarReserva(id: string): Promise<void> {
    await this.prisma.ven_orcamento_b2b.updateMany({
      where: { id, orcamento_id: null },
      data: { assumido_em: null, assumido_por: null },
    });
  }

  async concluirAssumir(id: string, orcamentoId: string): Promise<void> {
    await this.prisma.ven_orcamento_b2b.update({
      where: { id },
      data: { orcamento_id: orcamentoId, status: 'PROCESSING' },
    });
  }

  async registrarRecusa(id: string, motivo: string): Promise<void> {
    await this.prisma.ven_orcamento_b2b.update({
      where: { id },
      data: { status: 'CANCELLED', recusa_motivo: motivo, recusado_em: new Date() },
    });
  }

  /**
   * Preço promocional e fim nos itens de pedidos AGUARDANDO gravados antes de o
   * portal mandá-los: só onde ainda estão vazios.
   */
  async completarPromocoes(
    itens: Array<{ orderNumber: string; pro_codigo: number; promocao_preco: number; promocao_fim: Date | null }>,
  ): Promise<void> {
    for (const i of itens) {
      if (!Number.isInteger(i.pro_codigo)) continue;
      await this.prisma.ven_orcamento_b2b_itens.updateMany({
        where: {
          pro_codigo: i.pro_codigo,
          promocao_preco: null,
          ven_orcamento_b2b: { orderNumber: i.orderNumber, status: 'PENDING' },
        },
        data: { promocao_preco: i.promocao_preco, promocao_fim: i.promocao_fim },
      });
    }
  }

  /**
   * Completa empresa, observação e endereço dos pedidos AGUARDANDO gravados
   * antes destas colunas — só onde estão vazios, um UPDATE por pedido.
   */
  async completarDoPortal(
    pedidos: Array<{ orderNumber: string; empresa: string | null; observacao: string | null; endereco: string | null }>,
  ): Promise<void> {
    for (const p of pedidos) {
      if (!p.empresa) continue;
      await this.prisma.ven_orcamento_b2b.updateMany({
        where: { orderNumber: p.orderNumber, status: 'PENDING', empresa: null },
        data: { empresa: p.empresa, observacao: p.observacao, endereco: p.endereco },
      });
    }
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
        // Os itens chegam aqui já sem a margem (`resumoDoPortal`).
        precoSemMargem: true,
        cli_codigo: pedido.cli_codigo,
        empresa: pedido.empresa,
        observacao: pedido.observacao,
        endereco: pedido.endereco,
        // Sem status no payload, fica o default do banco ('PENDING').
        ...(pedido.status ? { status: pedido.status } : {}),
        ...(pedido.createdAt ? { createdAt: pedido.createdAt } : {}),
        ven_orcamento_b2b_itens: {
          create: pedido.itens.map((item) => ({
            pro_codigo: item.pro_codigo,
            quantidade: item.quantidade,
            promocao: item.promocao,
            preco_unitario: item.preco_unitario,
            promocao_preco: item.promocao_preco ?? null,
            promocao_fim: item.promocao_fim ?? null,
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

  /** Clientes do Celta que já têm pedido B2B gravado (empresas vinculadas). */
  async clientesVinculados(): Promise<number[]> {
    const rows = await this.prisma.ven_orcamento_b2b.findMany({
      where: { cli_codigo: { not: null } },
      distinct: ['cli_codigo'],
      select: { cli_codigo: true },
    });
    return rows.map((r) => r.cli_codigo as number);
  }

  /** Itens e total cotado do pedido gravado — o corpo do aviso ao vendedor. */
  async resumoDoPedido(id: string): Promise<{ itens: number; valor: number | null }> {
    const pedido = await this.prisma.ven_orcamento_b2b.findUnique({
      where: { id },
      select: {
        margem: true,
        precoSemMargem: true,
        ven_orcamento_b2b_itens: {
          select: { quantidade: true, preco_unitario: true },
        },
      },
    });
    const margem = paraNumero(pedido?.margem ?? null);
    const itens = (pedido?.ven_orcamento_b2b_itens ?? []).map((i) => ({
      quantidade: i.quantidade,
      preco: pedido?.precoSemMargem
        ? paraNumero(i.preco_unitario)
        : semMargem(paraNumero(i.preco_unitario), margem),
    }));
    const comPreco = itens.filter((i) => i.preco !== null);
    const centavos = comPreco.reduce(
      (acc, i) => acc + Math.round((i.preco as number) * 100) * i.quantidade,
      0,
    );
    return { itens: itens.length, valor: comPreco.length ? centavos / 100 : null };
  }
}
