import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { B2bCarteiraService } from './b2b.carteira.service';
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
    atualizarStatusPedido: jest.fn().mockResolvedValue(undefined),
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
    resumoDoPedido: jest.fn().mockResolvedValue({ itens: 2, valor: 50 }),
    completarDoPortal: jest.fn().mockResolvedValue(undefined),
    listarAguardando: jest.fn().mockResolvedValue([]),
    buscarParaAssumir: jest.fn(),
    reservar: jest.fn().mockResolvedValue(true),
    liberarReserva: jest.fn().mockResolvedValue(undefined),
    concluirAssumir: jest.fn().mockResolvedValue(undefined),
    registrarRecusa: jest.fn().mockResolvedValue(undefined),
    preencherCliente: jest.fn().mockResolvedValue(1),
    vendedoresDaCarteira: jest.fn().mockResolvedValue(new Map(carteira)),
    buscarPorIdentificador: jest.fn(),
    atribuirVendedor: jest.fn().mockResolvedValue(undefined),
  };
  const orcamento = {
    cliente: jest
      .fn()
      .mockResolvedValue({ cli_codigo: 555, cli_nome: 'LOJA X LTDA', tabela_preco: '2' }),
    produtosPorCodigo: jest.fn().mockResolvedValue([]),
    criar: jest.fn().mockResolvedValue({ id: 'orc1', numero: 42 }),
    vendedores: jest
      .fn()
      .mockResolvedValue([{ rep_codigo: 7, rep_nome: 'Alison', papel: null }]),
  };
  const carteiraPortal = { enviarCliente: jest.fn().mockResolvedValue(undefined) };
  const avisos = {
    b2bNovo: jest.fn().mockResolvedValue(undefined),
    b2bSemResponsavel: jest.fn().mockResolvedValue(undefined),
    b2bEncerrado: jest.fn(),
  };
  return {
    service: new B2bService(
      repo as unknown as B2bRepository,
      prisma as unknown as B2bPrismaRepository,
      orcamento as unknown as OrcamentoService,
      carteiraPortal as unknown as B2bCarteiraService,
      avisos as unknown as AvisosVendasService,
    ),
    avisos,
    repo,
    prisma,
    orcamento,
    carteiraPortal,
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

  it('vincular confere o cliente no ERP e o envia ao portal antes de gravar', async () => {
    const { service, repo, orcamento, carteiraPortal } = montar([]);
    orcamento.cliente.mockRejectedValueOnce(new Error('Cliente 1 não encontrado no ERP.'));

    await expect(service.vincularCliente('m1', 1)).rejects.toThrow('não encontrado');
    expect(repo.vincularCliente).not.toHaveBeenCalled();

    await expect(service.vincularCliente('m1', 555)).resolves.toEqual({
      company: 'Loja X',
      cli_codigo: 555,
      cli_nome: 'LOJA X LTDA',
    });
    expect(repo.vincularCliente).toHaveBeenCalledWith('m1', 555);
    expect(carteiraPortal.enviarCliente).toHaveBeenCalledWith(
      expect.objectContaining({ cli_codigo: 555 }),
    );
    expect(carteiraPortal.enviarCliente.mock.invocationCallOrder[0]).toBeLessThan(
      repo.vincularCliente.mock.invocationCallOrder[0],
    );
  });

  it('empresas sem vínculo: quem tem pedido esperando vem primeiro, com a contagem', async () => {
    const semVinculo = (company: string, n: string) => {
      const p = pedidoPortal({ orderNumber: n, id: n });
      p.user = { ...p.user, company, cliCodigo: null };
      return p;
    };
    const { service, repo } = montar([
      semVinculo('Loja B', 'ORD-1'),
      semVinculo('Loja B', 'ORD-2'),
    ]);
    repo.listarEmpresas.mockResolvedValue([
      { id: 'a', company: 'Loja A', cliCodigo: null },
      { id: 'b', company: 'Loja B', cliCodigo: null },
    ]);

    const empresas = await service.listarEmpresas(true);

    expect(empresas.map((e) => [e.company, e.pedidos_aguardando])).toEqual([
      ['Loja B', 2],
      ['Loja A', 0],
    ]);
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

    it('pode designar sobre o vendedor da carteira (vale só para o pedido)', async () => {
      const { service, prisma } = montar([], [], [
        [555, { rep_codigo: 9, rep_nome: 'Fernando' }],
      ]);
      prisma.buscarPorIdentificador.mockResolvedValue(PEDIDO);

      const r = await service.atribuirVendedor('ORD-1', 7);

      expect(r.responsavel).toEqual({ rep_codigo: 7, rep_nome: 'Alison', origem: 'PEDIDO' });
      expect(prisma.atribuirVendedor).toHaveBeenCalled();
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

describe('B2bService.sincronizarComPortal — busca a cada minuto', () => {
  const AGORA = new Date().toISOString();
  const ANTIGO = '2020-01-01T00:00:00.000Z';
  const pedidoEm = (n: string, createdAt: string, cliCodigo: number | null = 555) => {
    const p = pedidoPortal({ orderNumber: n, id: n, createdAt });
    p.user = { ...p.user, company: 'Loja X', cliCodigo };
    return p;
  };

  afterEach(() => {
    delete process.env.B2B_PEDIDOS_DESDE;
  });

  it('pedido novo é gravado e avisa o vendedor da carteira', async () => {
    const { service, prisma, avisos } = montar([pedidoEm('ORD-9', AGORA)], [], [
      [555, { rep_codigo: 9, rep_nome: 'Fernando' }],
    ]);

    await expect(service.sincronizarComPortal()).resolves.toEqual({
      novos: 1,
      avisados: 1,
    });
    expect(prisma.salvarPedido).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORD-9' }),
    );
    expect(avisos.b2bNovo).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORD-9', rep_codigo: 9, cliente: 'Loja X' }),
    );
  });

  it('sem vínculo ou sem vendedor, o aviso vai para a gestão', async () => {
    const { service, avisos } = montar([
      pedidoEm('ORD-A', AGORA, null),
      pedidoEm('ORD-B', AGORA, 777),
    ]);

    await service.sincronizarComPortal();

    expect(avisos.b2bNovo).not.toHaveBeenCalled();
    expect(avisos.b2bSemResponsavel).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORD-A', motivo: expect.stringContaining('sem vínculo') }),
    );
    expect(avisos.b2bSemResponsavel).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORD-B', motivo: expect.stringContaining('777') }),
    );
  });

  it('pedido antigo (antes do corte) é gravado calado', async () => {
    process.env.B2B_PEDIDOS_DESDE = '2026-10-01T00:00:00-04:00';
    const { service, prisma, avisos } = montar([pedidoEm('ORD-V', ANTIGO)]);

    await expect(service.sincronizarComPortal()).resolves.toEqual({
      novos: 1,
      avisados: 0,
    });
    expect(prisma.salvarPedido).toHaveBeenCalled();
    expect(avisos.b2bNovo).not.toHaveBeenCalled();
    expect(avisos.b2bSemResponsavel).not.toHaveBeenCalled();
  });

  it('pedido já gravado não avisa de novo', async () => {
    const { service, avisos } = montar(
      [pedidoEm('ORD-1', AGORA)],
      [gravadoBase({ orderNumber: 'ORD-1' })],
    );

    await expect(service.sincronizarComPortal()).resolves.toEqual({
      novos: 0,
      avisados: 0,
    });
    expect(avisos.b2bNovo).not.toHaveBeenCalled();
  });

  it('lê página a página e para na primeira sem novidade', async () => {
    const { service, repo, prisma } = montar([]);
    repo.listarPedidos
      .mockResolvedValueOnce({ data: [pedidoEm('N1', AGORA)], pagination: { pages: 3 } })
      .mockResolvedValueOnce({ data: [pedidoEm('V1', ANTIGO)], pagination: { pages: 3 } });
    // V1 já está gravado; N1 não.
    prisma.orderNumbersExistentes.mockImplementation(
      async (ns: string[]) => new Set(ns.filter((n) => n === 'V1')),
    );

    await service.sincronizarComPortal();

    expect(repo.listarPedidos.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('a listagem da tela (Atualizar) lê todas as páginas', async () => {
    const { service, repo } = montar([]);
    repo.listarPedidos
      .mockResolvedValueOnce({ data: [pedidoEm('P1', AGORA)], pagination: { pages: 2 } })
      .mockResolvedValueOnce({ data: [pedidoEm('P2', ANTIGO)], pagination: { pages: 2 } });

    const pedidos = await service.listarPedidos();

    expect(pedidos.map((p) => p.orderNumber).sort()).toEqual(['P1', 'P2']);
  });

  it('atribuir vendedor tira o aviso da gestão e avisa o vendedor escolhido', async () => {
    const { service, prisma, avisos } = montar([]);
    prisma.buscarPorIdentificador.mockResolvedValue({
      id: 'g1',
      orderNumber: 'ORD-1',
      pedidoId: 'p1',
      status: 'PENDING',
      cli_codigo: 555,
    });

    await service.atribuirVendedor('ORD-1', 7);

    expect(avisos.b2bEncerrado).toHaveBeenCalledWith('ORD-1');
    expect(avisos.b2bNovo).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'ORD-1', rep_codigo: 7, itens: 2, valor: 50 }),
    );
  });
});

describe('B2bService — assumir e recusar', () => {
  const pedido = (over: Record<string, unknown> = {}) => ({
    ...gravadoBase({
      cli_codigo: 555,
      clienteViuPreco: true,
      margem: 10,
      itens: [
        { pro_codigo: 100, quantidade: 3, promocao: null, preco_unitario: 12.5 },
        { pro_codigo: 200, quantidade: 1, promocao: 'Leve 3', preco_unitario: 8 },
      ],
    }),
    empresa: 'Loja X',
    observacao: 'Entregar pela manhã',
    endereco: 'Rua A, 10',
    orcamento_id: null,
    assumido_em: null,
    ...over,
  });
  const CARTEIRA: Array<[number, { rep_codigo: number; rep_nome: string | null }]> = [
    [555, { rep_codigo: 9, rep_nome: 'Fernando' }],
  ];

  it('vendedor responsável assume: orçamento com o preço visto, portal em atendimento', async () => {
    const { service, prisma, repo, orcamento, avisos } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    orcamento.produtosPorCodigo.mockResolvedValue([
      { pro_codigo: 100, preco_tabela: 10 },
      { pro_codigo: 200, preco_tabela: 9 },
    ]);

    const r = await service.assumir('ORD-1', { rep_codigo: 9, usuario_nome: 'Fernando' });

    expect(r).toEqual({ orcamento_id: 'orc1', numero: 42, fora: [] });
    const dto = orcamento.criar.mock.calls[0][0];
    expect(dto).toEqual(
      expect.objectContaining({
        cli_codigo: 555,
        rep_codigo: 9,
        itens: [
          { pro_codigo: 100, quantidade: 3, preco_base: 12.5 },
          { pro_codigo: 200, quantidade: 1, preco_base: 8 },
        ],
      }),
    );
    expect(dto.observacao).toContain('Pedido B2B ORD-1');
    expect(dto.observacao).toContain('Entrega: Rua A, 10');
    expect(dto.observacao).toContain('Obs. do cliente: Entregar pela manhã');
    expect(dto.observacao).toContain('Promoção do portal nos itens: 200');
    expect(prisma.concluirAssumir).toHaveBeenCalledWith('g1', 'orc1');
    expect(repo.atualizarStatusPedido).toHaveBeenCalledWith('p1', 'PROCESSING');
    expect(avisos.b2bEncerrado).toHaveBeenCalledWith('ORD-1');
  });

  it('cliente que não viu preço: tabela com a margem do comprador, e a observação avisa', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(
      pedido({
        clienteViuPreco: false,
        itens: [{ pro_codigo: 100, quantidade: 2, promocao: null, preco_unitario: null }],
      }),
    );
    orcamento.produtosPorCodigo.mockResolvedValue([{ pro_codigo: 100, preco_tabela: 10 }]);

    await service.assumir('ORD-1', { rep_codigo: 9 });

    const dto = orcamento.criar.mock.calls[0][0];
    expect(dto.itens).toEqual([{ pro_codigo: 100, quantidade: 2, preco_base: 11 }]);
    expect(dto.observacao).toContain('Preço não exibido ao cliente');
  });

  it('item que não existe mais no ERP fica de fora e vai para a observação', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    orcamento.produtosPorCodigo.mockResolvedValue([{ pro_codigo: 100, preco_tabela: 10 }]);

    const r = await service.assumir('ORD-1', { rep_codigo: 9 });

    expect(r.fora).toEqual([200]);
    const dto = orcamento.criar.mock.calls[0][0];
    expect(dto.itens.map((i: { pro_codigo: number }) => i.pro_codigo)).toEqual([100]);
    expect(dto.observacao).toContain('Fora do orçamento (não existem mais no ERP): 200');
  });

  it('outro vendedor não assume; a gestão assume com o vendedor responsável', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    orcamento.produtosPorCodigo.mockResolvedValue([
      { pro_codigo: 100, preco_tabela: 10 },
      { pro_codigo: 200, preco_tabela: 9 },
    ]);

    await expect(service.assumir('ORD-1', { rep_codigo: 7 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.reservar).not.toHaveBeenCalled();

    await service.assumir('ORD-1', { gestao: true, usuario_nome: 'Gestora' });
    expect(orcamento.criar.mock.calls[0][0]).toEqual(
      expect.objectContaining({ rep_codigo: 9, usuario_nome: 'Gestora' }),
    );
  });

  it('clique duplo: o segundo encontra o pedido reservado', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    prisma.reservar.mockResolvedValue(false);

    await expect(service.assumir('ORD-1', { rep_codigo: 9 })).rejects.toThrow(
      ConflictException,
    );
    expect(orcamento.criar).not.toHaveBeenCalled();
  });

  it('falha ao criar o orçamento libera a reserva', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    orcamento.produtosPorCodigo.mockResolvedValue([{ pro_codigo: 100, preco_tabela: 10 }]);
    orcamento.criar.mockRejectedValue(new Error('ERP fora'));

    await expect(service.assumir('ORD-1', { rep_codigo: 9 })).rejects.toThrow('ERP fora');
    expect(prisma.liberarReserva).toHaveBeenCalledWith('g1');
    expect(prisma.concluirAssumir).not.toHaveBeenCalled();
  });

  it('gestão assume com o vendedor escolhido, mesmo sem responsável', async () => {
    const { service, prisma, orcamento } = montar([]);
    prisma.buscarParaAssumir.mockResolvedValue(pedido({ cli_codigo: 999 }));
    orcamento.produtosPorCodigo.mockResolvedValue([
      { pro_codigo: 100, preco_tabela: 10 },
      { pro_codigo: 200, preco_tabela: 9 },
    ]);

    await expect(service.assumir('ORD-1', { gestao: true })).rejects.toThrow(
      BadRequestException,
    );

    await service.assumir('ORD-1', { gestao: true, vendedor_codigo: 7, usuario_nome: 'Gestora' });
    expect(orcamento.criar.mock.calls[0][0]).toEqual(
      expect.objectContaining({ rep_codigo: 7, rep_nome: 'Alison' }),
    );
    expect(prisma.atribuirVendedor).toHaveBeenCalledWith('g1', {
      rep_codigo: 7,
      rep_nome: 'Alison',
      atribuido_por: 'Gestora',
    });
  });

  it('vendedor não escolhe outro vendedor ao assumir', async () => {
    const { service, prisma, orcamento } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());
    orcamento.produtosPorCodigo.mockResolvedValue([{ pro_codigo: 100, preco_tabela: 10 }]);

    await service.assumir('ORD-1', { rep_codigo: 9, vendedor_codigo: 7 });

    expect(orcamento.criar.mock.calls[0][0]).toEqual(expect.objectContaining({ rep_codigo: 9 }));
  });

  it('vincular pelo pedido acha o master pela empresa e devolve o vendedor da carteira', async () => {
    const { service, prisma, repo } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido({ cli_codigo: null }));
    repo.listarEmpresas.mockResolvedValue([
      { id: 'm-outra', company: 'Loja Y' },
      { id: 'm1', company: 'Loja X' },
    ]);

    const r = await service.vincularClienteDoPedido('ORD-1', 555);

    expect(repo.vincularCliente).toHaveBeenCalledWith('m1', 555);
    expect(r).toEqual({
      cli_codigo: 555,
      cli_nome: 'LOJA X LTDA',
      responsavel: { rep_codigo: 9, rep_nome: 'Fernando', origem: 'CARTEIRA' },
    });

    prisma.buscarParaAssumir.mockResolvedValue(pedido({ empresa: 'Sumiu' }));
    await expect(service.vincularClienteDoPedido('ORD-1', 555)).rejects.toThrow('não encontrada');
  });

  it('recusar exige motivo e cancela no portal com ele', async () => {
    const { service, prisma, repo, avisos } = montar([], [], CARTEIRA);
    prisma.buscarParaAssumir.mockResolvedValue(pedido());

    await expect(service.recusar('ORD-1', ' ', { rep_codigo: 9 })).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.recusar('ORD-1', 'Sem estoque', { rep_codigo: 7 })).rejects.toThrow(
      ForbiddenException,
    );

    await service.recusar('ORD-1', ' Sem estoque ', { rep_codigo: 9 });
    expect(repo.atualizarStatusPedido).toHaveBeenCalledWith('p1', 'CANCELLED', 'Sem estoque');
    expect(prisma.registrarRecusa).toHaveBeenCalledWith('g1', 'Sem estoque');
    expect(avisos.b2bEncerrado).toHaveBeenCalledWith('ORD-1');
  });

  it('aguardando: o vendedor vê só os dele; a gestão vê todos', async () => {
    const { service, prisma } = montar([], [], CARTEIRA);
    prisma.listarAguardando.mockResolvedValue([
      pedido({ id: 'a', orderNumber: 'A' }),
      pedido({ id: 'b', orderNumber: 'B', cli_codigo: 999 }),
    ]);

    const doVendedor = await service.pedidosAguardando(9);
    const daGestao = await service.pedidosAguardando(null);

    expect(doVendedor.map((p) => p.orderNumber)).toEqual(['A']);
    expect(doVendedor[0]).toEqual(
      expect.objectContaining({ empresa: 'Loja X', itens: 2, promocao: true, valorTotal: 45.5 }),
    );
    expect(daGestao.map((p) => [p.orderNumber, p.responsavel?.rep_codigo ?? null])).toEqual([
      ['A', 9],
      ['B', null],
    ]);
  });
});
