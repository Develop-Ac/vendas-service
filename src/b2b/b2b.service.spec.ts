import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrcamentoService } from '../orcamento/orcamento.service';
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

function gravadoBase(over: Partial<OrcamentoB2bGravado> = {}): OrcamentoB2bGravado {
  return {
    id: 'g1',
    orderNumber: 'ORD-1',
    userId: 'u1',
    pedidoId: 'p1',
    comprador: 'Fulano',
    status: 'PENDING',
    createdAt: new Date('2026-10-20T10:00:00.000Z'),
    clienteViuPreco: null,
    margem: null,
    cli_codigo: null,
    rep_codigo: null,
    rep_nome: null,
    itens: [
      { pro_codigo: 100, quantidade: 3, promocao: null, preco_unitario: null },
    ],
    ...over,
  };
}

function montar(
  portal: PortalOrder[],
  gravados: OrcamentoB2bGravado[] = [],
  carteira: Array<[number, { rep_codigo: number; rep_nome: string | null }]> = [],
) {
  const repo = {
    listarPedidos: jest.fn().mockResolvedValue({ data: portal }),
    listarEmpresas: jest.fn().mockResolvedValue([]),
    vincularCliente: jest
      .fn()
      .mockResolvedValue({ company: 'Loja X', cliCodigo: 555, usuarios: 2 }),
  };
  const prisma = {
    listarPedidos: jest.fn().mockResolvedValue(gravados),
    orderNumbersExistentes: jest
      .fn()
      .mockResolvedValue(new Set(gravados.map((g) => g.orderNumber))),
    salvarPedido: jest.fn().mockResolvedValue(undefined),
    preencherCliente: jest.fn().mockResolvedValue(1),
    vendedoresDaCarteira: jest.fn().mockResolvedValue(new Map(carteira)),
    buscarPorIdentificador: jest.fn(),
    atribuirVendedor: jest.fn().mockResolvedValue(undefined),
  };
  const orcamento = {
    cliente: jest.fn().mockResolvedValue({ cli_codigo: 555, cli_nome: 'LOJA X LTDA' }),
    vendedores: jest
      .fn()
      .mockResolvedValue([{ rep_codigo: 7, rep_nome: 'Alison', papel: null }]),
  };
  return {
    service: new B2bService(
      repo as unknown as B2bRepository,
      prisma as unknown as B2bPrismaRepository,
      orcamento as unknown as OrcamentoService,
    ),
    repo,
    prisma,
    orcamento,
  };
}

function comCliente(cliCodigo: number | null): PortalOrder {
  const p = pedidoPortal();
  p.user = { ...p.user, cliCodigo };
  return p;
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
    const { service } = montar([pedidoPortal()], [gravadoBase()]);

    const [pedido] = await service.listarPedidos();

    expect(pedido.clienteViuPreco).toBe(true);
    expect(pedido.items[0].preco_unitario).toBe(10.1);
    expect(pedido.valorTotal).toBe(30.3);
  });
});

describe('B2bService — cliente do Celta e vendedor responsável', () => {
  it('pedido novo grava o cliente do portal e sai com o vendedor da carteira', async () => {
    const { service, prisma } = montar([comCliente(555)], [], [
      [555, { rep_codigo: 9, rep_nome: 'Fernando' }],
    ]);

    const [pedido] = await service.listarPedidos();

    expect(prisma.salvarPedido).toHaveBeenCalledWith(
      expect.objectContaining({ cli_codigo: 555 }),
    );
    expect(pedido.cli_codigo).toBe(555);
    expect(pedido.responsavel).toEqual({
      rep_codigo: 9,
      rep_nome: 'Fernando',
      origem: 'CARTEIRA',
    });
  });

  it('pedido gravado antes do vínculo ganha o cliente que o portal passou a informar', async () => {
    const { service, prisma } = montar([comCliente(555)], [gravadoBase()]);

    const [pedido] = await service.listarPedidos();

    expect(prisma.preencherCliente).toHaveBeenCalledWith(['ORD-1'], 555);
    expect(pedido.cli_codigo).toBe(555);
  });

  it('o vendedor atribuído ao pedido vence a carteira', async () => {
    const { service } = montar(
      [comCliente(555)],
      [gravadoBase({ cli_codigo: 555, rep_codigo: 7, rep_nome: 'Alison' })],
      [[555, { rep_codigo: 9, rep_nome: 'Fernando' }]],
    );

    const [pedido] = await service.listarPedidos();

    expect(pedido.responsavel).toEqual({
      rep_codigo: 7,
      rep_nome: 'Alison',
      origem: 'PEDIDO',
    });
  });

  it('fila "sem responsável": só pendente, vinculado e sem vendedor', async () => {
    const { service } = montar(
      [],
      [
        gravadoBase({ orderNumber: 'A', cli_codigo: 555 }),
        gravadoBase({ orderNumber: 'B', cli_codigo: null }),
        gravadoBase({ orderNumber: 'C', cli_codigo: 556 }),
        gravadoBase({ orderNumber: 'D', cli_codigo: 557, status: 'PROCESSING' }),
      ],
      [[556, { rep_codigo: 9, rep_nome: 'Fernando' }]],
    );

    const fila = await service.pedidosSemResponsavel();

    expect(fila.map((p) => p.orderNumber)).toEqual(['A']);
  });

  it('vincular confere o cliente no ERP antes de gravar no portal', async () => {
    const { service, repo, orcamento } = montar([]);
    orcamento.cliente.mockRejectedValueOnce(new Error('Cliente 1 não encontrado no ERP.'));

    await expect(service.vincularCliente('m1', 1)).rejects.toThrow('não encontrado');
    expect(repo.vincularCliente).not.toHaveBeenCalled();

    await expect(service.vincularCliente('m1', 555)).resolves.toEqual({
      company: 'Loja X',
      cli_codigo: 555,
      cli_nome: 'LOJA X LTDA',
    });
    expect(repo.vincularCliente).toHaveBeenCalledWith('m1', 555);
  });

  describe('atribuirVendedor', () => {
    const PEDIDO = {
      id: 'g1',
      orderNumber: 'ORD-1',
      pedidoId: 'p1',
      status: 'PENDING',
      cli_codigo: 555,
    };

    it('grava o vendedor só no pedido, com quem atribuiu', async () => {
      const { service, prisma } = montar([]);
      prisma.buscarPorIdentificador.mockResolvedValue(PEDIDO);

      const r = await service.atribuirVendedor('ORD-1', 7, ' Gestora ');

      expect(prisma.atribuirVendedor).toHaveBeenCalledWith('g1', {
        rep_codigo: 7,
        rep_nome: 'Alison',
        atribuido_por: 'Gestora',
      });
      expect(r.responsavel.origem).toBe('PEDIDO');
    });

    it('recusa cliente que já tem vendedor na carteira', async () => {
      const { service, prisma } = montar([], [], [
        [555, { rep_codigo: 9, rep_nome: 'Fernando' }],
      ]);
      prisma.buscarPorIdentificador.mockResolvedValue(PEDIDO);

      await expect(service.atribuirVendedor('ORD-1', 7)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.atribuirVendedor).not.toHaveBeenCalled();
    });

    it('recusa pedido já assumido, sem vínculo ou vendedor fora do atacado', async () => {
      const { service, prisma } = montar([]);

      prisma.buscarPorIdentificador.mockResolvedValue({ ...PEDIDO, status: 'PROCESSING' });
      await expect(service.atribuirVendedor('ORD-1', 7)).rejects.toThrow(BadRequestException);

      prisma.buscarPorIdentificador.mockResolvedValue({ ...PEDIDO, cli_codigo: null });
      await expect(service.atribuirVendedor('ORD-1', 7)).rejects.toThrow(BadRequestException);

      prisma.buscarPorIdentificador.mockResolvedValue(PEDIDO);
      await expect(service.atribuirVendedor('ORD-1', 99)).rejects.toThrow(BadRequestException);

      expect(prisma.atribuirVendedor).not.toHaveBeenCalled();
    });
  });
});
