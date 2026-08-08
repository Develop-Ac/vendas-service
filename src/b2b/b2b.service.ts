import { Injectable } from '@nestjs/common';
import { B2bRepository } from './b2b.repository';

export interface PedidoItemResumo {
  pro_codigo: string;
  quantidade: number;
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
  items: PedidoItemResumo[];
  user: PedidoUsuarioResumo;
}

@Injectable()
export class B2bService {
  constructor(private readonly b2bRepository: B2bRepository) {}

  async listarPedidos(): Promise<PedidoResumo[]> {
    const pedidos = await this.b2bRepository.listarPedidos();

    return pedidos.data.map((pedido) => ({
      orderNumber: pedido.orderNumber,
      createdAt: pedido.createdAt,
      pedidoId: pedido.id,
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
  }
}
