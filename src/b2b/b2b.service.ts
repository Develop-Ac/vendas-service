import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { B2bRepository } from './b2b.repository';
import {
  B2bPrismaRepository,
  OrcamentoB2bGravado,
  OrcamentoB2bInput,
} from './b2b.prisma.repository';

export interface PedidoItemResumo {
  pro_codigo: string;
  quantidade: number;
  promocao: string | null;
}

export interface PedidoUsuarioResumo {
  id: string;
  nome: string;
  phone: string;
  carteira: string;
}

export interface PedidoResumo {
  orderNumber: string;
  createdAt: string;
  pedidoId: string;
  items: PedidoItemResumo[];
  user: PedidoUsuarioResumo;
  comprador: string;
  status: string;
}

@Injectable()
export class B2bService {
  private readonly logger = new Logger(B2bService.name);

  constructor(
    private readonly b2bRepository: B2bRepository,
    private readonly b2bPrismaRepository: B2bPrismaRepository,
  ) {}

  /**
   * Troca o status do pedido em ven_orcamento_b2b. O identificador da rota pode
   * ser o id do registro, o orderNumber ou o pedidoId do portal.
   */
  async atualizarStatus(
    identificador: string,
    status: string,
  ): Promise<{ id: string; status: string }> {
    const novoStatus = (status ?? '').trim();
    if (!novoStatus) {
      throw new BadRequestException('Informe o novo status do pedido.');
    }
    if (novoStatus.length > 50) {
      throw new BadRequestException(
        'O status do pedido deve ter no máximo 50 caracteres.',
      );
    }

    const pedido =
      await this.b2bPrismaRepository.buscarPorIdentificador(identificador);
    if (!pedido) {
      throw new NotFoundException(
        `Pedido B2B não encontrado: ${identificador}`,
      );
    }

    // O portal primeiro: se ele recusar a mudança, o banco daqui não fica com
    // um status que lá não existe (o erro sobe para quem chamou).
    if (pedido.pedidoId) {
      await this.b2bRepository.atualizarStatusPedido(
        pedido.pedidoId,
        novoStatus,
      );
    } else {
      this.logger.warn(
        `Pedido B2B ${pedido.orderNumber} sem pedidoId: status alterado só na intranet.`,
      );
    }

    await this.b2bPrismaRepository.atualizarStatus(pedido.id, novoStatus);

    return { id: identificador, status: novoStatus };
  }

  /**
   * Os pedidos do B2B, do banco da intranet somados aos do portal.
   *
   * ven_orcamento_b2b guarda só `userId` do comprador — nome, telefone e
   * carteira não têm coluna lá. Então o portal também é consultado e os dois
   * lados são fundidos por orderNumber: o que está gravado aqui manda, e o que
   * falta é preenchido com o payload do portal. Pedido que só existe no portal
   * entra na resposta e fica gravado para as próximas chamadas.
   *
   * Se o portal estiver fora, a resposta sai só com o que há no banco (sem os
   * dados do comprador); se o banco estiver fora, sai só com o do portal. Com
   * as duas fontes fora, o erro do portal sobe.
   */
  async listarPedidos(): Promise<PedidoResumo[]> {
    const gravados = await this.lerPedidosGravados();
    const doPortal = await this.lerPedidosDoPortal(gravados.length > 0);

    if (doPortal.length) await this.gravarPedidosNovos(doPortal);
    if (!gravados.length) return doPortal;

    // Indexado pelas duas chaves porque o portal é localizável tanto pelo
    // orderNumber quanto pelo id do pedido de lá (pedidoId aqui).
    const porChave = new Map<string, PedidoResumo>();
    for (const pedido of doPortal) {
      if (pedido.orderNumber) porChave.set(pedido.orderNumber, pedido);
      if (pedido.pedidoId) porChave.set(pedido.pedidoId, pedido);
    }

    const mesclados = gravados.map((gravado) =>
      this.mesclar(
        gravado,
        porChave.get(gravado.orderNumber) ??
          (gravado.pedidoId ? porChave.get(gravado.pedidoId) : undefined),
      ),
    );

    const jaGravados = new Set(gravados.map((p) => p.orderNumber));
    const somenteNoPortal = doPortal.filter(
      (p) => !jaGravados.has(p.orderNumber),
    );

    return [...mesclados, ...somenteNoPortal].sort(
      (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''),
    );
  }

  /**
   * O que está no banco tem precedência; o portal preenche o que falta ali —
   * na prática, nome, telefone e carteira do comprador.
   */
  private mesclar(
    gravado: PedidoResumo,
    portal: PedidoResumo | undefined,
  ): PedidoResumo {
    if (!portal) return gravado;

    return {
      orderNumber: gravado.orderNumber || portal.orderNumber,
      createdAt: gravado.createdAt || portal.createdAt,
      pedidoId: gravado.pedidoId || portal.pedidoId,
      comprador: gravado.comprador || portal.comprador,
      status: gravado.status || portal.status,
      items: gravado.items.length ? gravado.items : portal.items,
      user: {
        id: gravado.user.id || portal.user?.id,
        nome: gravado.user.nome || portal.user?.nome,
        phone: gravado.user.phone || portal.user?.phone,
        carteira: gravado.user.carteira || portal.user?.carteira,
      },
    };
  }

  /**
   * Os pedidos do portal. `tolerante` vale quando o banco já respondeu: aí uma
   * falha do portal vira log e lista vazia, em vez de derrubar a listagem.
   */
  private async lerPedidosDoPortal(tolerante: boolean): Promise<PedidoResumo[]> {
    try {
      const pedidos = await this.b2bRepository.listarPedidos();

      return pedidos.data.map((pedido) => ({
        orderNumber: pedido.orderNumber,
        createdAt: pedido.createdAt,
        pedidoId: pedido.id,
        comprador: pedido.comprador,
        status: pedido.status,
        items: pedido.items.map((item) => ({
          pro_codigo: item.product?.proCodigo,
          quantidade: item.quantity,
          promocao: item.product?.promotion?.textoPromocional || null,
        })),
        user: {
          id: pedido.user?.id,
          nome: pedido.user?.name,
          phone: pedido.user?.phone,
          carteira: pedido.user?.carteira,
        },
      }));
    } catch (err: any) {
      if (!tolerante) throw err;
      this.logger.error(
        `Erro ao consultar os pedidos no portal B2B, respondendo só com o banco: ${err?.message}`,
      );
      return [];
    }
  }

  /** Leitura do banco; se ela falhar, devolve vazio e a resposta vem do portal. */
  private async lerPedidosGravados(): Promise<PedidoResumo[]> {
    try {
      const rows = await this.b2bPrismaRepository.listarPedidos();
      return rows.map((row) => this.paraResumo(row));
    } catch (err: any) {
      this.logger.error(
        `Erro ao ler os pedidos B2B gravados, consultando o portal: ${err?.message}`,
      );
      return [];
    }
  }

  private paraResumo(row: OrcamentoB2bGravado): PedidoResumo {
    return {
      orderNumber: row.orderNumber,
      createdAt: row.createdAt.toISOString(),
      pedidoId: row.pedidoId ?? '',
      comprador: row.comprador ?? '',
      status: row.status ?? '',
      items: row.itens.map((item) => ({
        pro_codigo: String(item.pro_codigo),
        quantidade: item.quantidade,
        promocao: item.promocao,
      })),
      // A tabela só tem o id do comprador; nome, telefone e carteira vêm do
      // portal, no `mesclar`.
      user: {
        id: row.userId,
        nome: '',
        phone: '',
        carteira: '',
      },
    };
  }

  /**
   * Grava em ven_orcamento_b2b (e ven_orcamento_b2b_itens) os pedidos que ainda
   * não existem por orderNumber. A gravação é acessória à listagem: uma falha
   * aqui é registrada em log e não derruba a resposta.
   */
  private async gravarPedidosNovos(resumos: PedidoResumo[]): Promise<void> {
    try {
      const orderNumbers = resumos
        .map((p) => p.orderNumber)
        .filter((n): n is string => !!n);
      if (!orderNumbers.length) return;

      const existentes =
        await this.b2bPrismaRepository.orderNumbersExistentes(orderNumbers);

      for (const resumo of resumos) {
        if (!resumo.orderNumber || existentes.has(resumo.orderNumber)) continue;

        const criadoEm = resumo.createdAt ? new Date(resumo.createdAt) : null;

        const pedido: OrcamentoB2bInput = {
          orderNumber: resumo.orderNumber,
          userId: resumo.user?.id ?? '',
          pedidoId: resumo.pedidoId ?? null,
          comprador: resumo.comprador ?? null,
          status: resumo.status ?? null,
          createdAt:
            criadoEm && !Number.isNaN(criadoEm.getTime()) ? criadoEm : null,
          itens: resumo.items
            .map((item) => ({
              pro_codigo: Number(item.pro_codigo),
              quantidade: Number(item.quantidade),
              promocao: item.promocao ?? null,
            }))
            .filter(
              (item) =>
                Number.isInteger(item.pro_codigo) &&
                Number.isFinite(item.quantidade),
            ),
        };

        try {
          await this.b2bPrismaRepository.salvarPedido(pedido);
          existentes.add(pedido.orderNumber);
        } catch (err: any) {
          this.logger.error(
            `Erro ao gravar o pedido B2B ${pedido.orderNumber}: ${err?.message}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Erro ao gravar os pedidos do portal B2B: ${err?.message}`,
      );
    }
  }
}
