import {
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
}

@Injectable()
export class B2bRepository {
  private readonly logger = new Logger(B2bRepository.name);

  constructor(private readonly httpService: HttpService) {}

  async listarPedidos(): Promise<responsePedidoApi> {
    const baseUrl = process.env.PORTAL_B2B_URL ?? 'http://localhost:3000';
    const url = `${baseUrl}/api/pedidos`;
    const authSecret = process.env.AUTH_SECRET ?? '';

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
}