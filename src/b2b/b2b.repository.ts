import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface responsePedidoApi {
  data: PortalOrder[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface PortalProduct {
  id: string;
  proCodigo: string;
  name: string;
  promotion: PortalProductPromotion;
}

export interface PortalProductPromotion {
  textoPromocional: string;
}

export interface PortalOrderItem {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  priceAtTime: number;
  product: PortalProduct;
}

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  company: string;
  role: string;
  carteira: string;
}

export interface PortalOrder {
  id: string;
  orderNumber: string;
  userId: string;
  total: number;
  status: string;
  shippingAddress: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  items: PortalOrderItem[];
  user: PortalUser;
  comprador: string;
}

@Injectable()
export class B2bRepository {
  private readonly logger = new Logger(B2bRepository.name);

  constructor(private readonly httpService: HttpService) {}

  async listarPedidos(): Promise<responsePedidoApi> {
    const baseUrl = process.env.PORTAL_B2B_URL ?? 'http://localhost:3000';
    const url = `${baseUrl}/api/pedidos`;
    const authSecret = process.env.AUTH_SECRET ?? '';

    // NÃO registrar `authSecret` em log: é o segredo de serviço, e ele
    // trafega a cada chamada. Havia um `console.log` aqui imprimindo-o junto
    // com a URL a cada consulta de pedidos.

    try {
      const res = await firstValueFrom(
        this.httpService.get<responsePedidoApi>(url, {
          headers: { 'x-servico-token': authSecret },
        }), 
      );
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.error(
        `Erro ao consultar pedidos do portal B2B: ${status} - ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Erro ao consultar a API de pedidos do portal B2B: ${err.message}`,
      );
    }
  }

  /** PUT /api/pedidos/:id no portal — o `id` é o do pedido lá (pedidoId aqui). */
  async atualizarStatusPedido(pedidoId: string, status: string): Promise<void> {
    const baseUrl = process.env.PORTAL_B2B_URL ?? 'http://localhost:3000';
    const url = `${baseUrl}/api/pedidos/${encodeURIComponent(pedidoId)}`;
    const authSecret = process.env.AUTH_SECRET ?? '';

    try {
      await firstValueFrom(
        this.httpService.put(
          url,
          { status },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-servico-token': authSecret,
            },
          },
        ),
      );
    } catch (err: any) {
      const statusHttp: number | undefined = err?.response?.status;
      // O portal responde `{ error: '...' }`; sem isto o motivo real ("Transição
      // de status inválida", "Status inválido", "Pedido não encontrado") não
      // chegava nem ao log nem a quem chamou.
      const motivo =
        err?.response?.data?.error ??
        err?.response?.data?.message ??
        err.message;

      this.logger.error(
        `Erro ao atualizar o status do pedido ${pedidoId} no portal B2B: ${statusHttp ?? 'sem status'} - ${motivo}`,
      );

      // 4xx é recusa do portal (status inválido, transição proibida, pedido
      // inexistente), não falha nossa: repassa o código em vez de virar 500.
      if (statusHttp && statusHttp >= 400 && statusHttp < 500) {
        throw new HttpException(
          `O portal B2B recusou a mudança de status: ${motivo}`,
          statusHttp,
        );
      }

      throw new InternalServerErrorException(
        `Erro ao atualizar o status do pedido no portal B2B: ${motivo}`,
      );
    }
  }
}