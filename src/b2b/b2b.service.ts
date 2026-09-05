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
   * Os pedidos do B2B. A fonte preferencial é o Postgres da intranet
   * (ven_orcamento_b2b); só quando não há nada gravado — ou quando a leitura do
   * banco falha — é que se consulta a API do portal, e o que vier de lá fica
   * gravado para as próximas chamadas.
   */
  async listarPedidos(): Promise<PedidoResumo[]> {
    const gravados = await this.lerPedidosGravados();
    if (gravados.length) return gravados;

    const pedidos = await this.b2bRepository.listarPedidos();

    const resumos: PedidoResumo[] = pedidos.data.map((pedido) => ({
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

    await this.gravarPedidosNovos(resumos);

    return resumos;
  }

  /** Leitura do banco; se ela falhar, devolve vazio para cair na API do portal. */
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
      // Só o id do comprador é gravado hoje; nome, telefone e carteira ficam
      // vazios quando a resposta vem do banco.
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
