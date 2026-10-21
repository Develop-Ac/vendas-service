import { B2bService } from './b2b.service';
import { B2bRepository, PortalOrder } from './b2b.repository';
import { B2bPrismaRepository, OrcamentoB2bGravado } from './b2b.prisma.repository';

function pedidoPortal(over: Partial<PortalOrder> = {}): PortalOrder {
  return {
    id: 'p1',
    orderNumber: 'ORD-1',
    userId: 'u1',
    total: 0,
    status: 'PENDING',
    shippingAddress: 'A definir',
    notes: '',
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    comprador: 'Fulano',
    clienteViuPreco: true,
    margem: 10,
    user: {
      id: 'u1',
      email: 'x@y.z',
      name: 'Loja',
      phone: '1',
      company: '',
      role: 'COMPRADOR_ATACADO',
      carteira: 'C1',
    },
    items: [
      {
        id: 'i1',
        orderId: 'p1',
        productId: 'pr1',
        quantity: 3,
        precoUnitario: 10.1,
        product: {
          id: 'pr1',
          proCodigo: '100',
          name: 'Peça',
          promotion: null as any,
        },
      },
    ],
    ...over,
  };
}

function montar(portal: PortalOrder[], gravados: OrcamentoB2bGravado[] = []) {
  const repo = {
    listarPedidos: jest.fn().mockResolvedValue({ data: portal }),
  } as unknown as B2bRepository;
  const prisma = {
    listarPedidos: jest.fn().mockResolvedValue(gravados),
    orderNumbersExistentes: jest
      .fn()
      .mockResolvedValue(new Set(gravados.map((g) => g.orderNumber))),
    salvarPedido: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new B2bService(repo, prisma as unknown as B2bPrismaRepository),
    prisma,
  };
}

describe('B2bService.listarPedidos — preço cotado', () => {
  it('repassa o preço, a flag e o total do pedido em que o comprador viu preço', async () => {
    const { service, prisma } = montar([pedidoPortal()]);

    const [pedido] = await service.listarPedidos();

    expect(pedido.clienteViuPreco).toBe(true);
    expect(pedido.margem).toBe(10);
    expect(pedido.items[0].preco_unitario).toBe(10.1);
    expect(pedido.valorTotal).toBe(30.3);
    expect(prisma.salvarPedido).toHaveBeenCalledWith(
      expect.objectContaining({
        clienteViuPreco: true,
        margem: 10,
        itens: [expect.objectContaining({ preco_unitario: 10.1 })],
      }),
    );
  });

  it('marca "não viu preço" sem valor quando o comprador não vê preço', async () => {
    const portal = pedidoPortal({ clienteViuPreco: false, margem: null });
    portal.items[0].precoUnitario = null;
    const { service } = montar([portal]);

    const [pedido] = await service.listarPedidos();

    expect(pedido.clienteViuPreco).toBe(false);
    expect(pedido.items[0].preco_unitario).toBeNull();
    expect(pedido.valorTotal).toBeNull();
  });

  it('completa com o portal o pedido gravado antes das colunas de preço', async () => {
    const gravado: OrcamentoB2bGravado = {
      id: 'g1',
      orderNumber: 'ORD-1',
      userId: 'u1',
      pedidoId: 'p1',
      comprador: 'Fulano',
      status: 'PENDING',
      createdAt: new Date('2026-10-20T10:00:00.000Z'),
      clienteViuPreco: null,
      margem: null,
      itens: [
        { pro_codigo: 100, quantidade: 3, promocao: null, preco_unitario: null },
      ],
    };
    const { service } = montar([pedidoPortal()], [gravado]);

    const [pedido] = await service.listarPedidos();

    expect(pedido.clienteViuPreco).toBe(true);
    expect(pedido.items[0].preco_unitario).toBe(10.1);
    expect(pedido.valorTotal).toBe(30.3);
  });
});
