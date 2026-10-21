import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { B2bRepository, PortalEmpresa } from './b2b.repository';
import {
  B2bPrismaRepository,
  OrcamentoB2bGravado,
  OrcamentoB2bInput,
} from './b2b.prisma.repository';

export interface PedidoItemResumo {
  pro_codigo: string;
  quantidade: number;
  promocao: string | null;
  /**
   * Preço unitário que o comprador viu ao cotar (tabela + margem), congelado
   * pelo portal. `null` quando ele não viu preço ou a peça não tinha preço.
   */
  preco_unitario: number | null;
}

export interface PedidoUsuarioResumo {
  id: string;
  nome: string;
  phone: string;
  carteira: string;
  /** Empresa do comprador no portal. */
  company: string;
}

/**
 * Quem atende o pedido. `CARTEIRA`: o vendedor do cliente na carteirização;
 * `PEDIDO`: o vendedor que a gestão atribuiu só a este pedido.
 */
export interface ResponsavelPedido {
  rep_codigo: number;
  rep_nome: string | null;
  origem: 'CARTEIRA' | 'PEDIDO';
}

export interface PedidoResumo {
  orderNumber: string;
  createdAt: string;
  pedidoId: string;
  items: PedidoItemResumo[];
  user: PedidoUsuarioResumo;
  comprador: string;
  status: string;
  /**
   * O comprador via preço quando fez o pedido: `true` viu, `false` não viu.
   * `null` só quando nem o banco nem o portal sabem (pedido antigo).
   */
  clienteViuPreco: boolean | null;
  /** Margem (%) do comprador já embutida no `preco_unitario`. */
  margem: number | null;
  /** Soma de `preco_unitario × quantidade` dos itens com preço; `null` sem preço. */
  valorTotal: number | null;
  /** Cliente do Celta da empresa; `null` = empresa ainda sem vínculo. */
  cli_codigo: number | null;
  /** `null` = sem vínculo, ou cliente sem vendedor e sem atribuição. */
  responsavel: ResponsavelPedido | null;
}

/** Só pedido ainda não assumido entra nas filas da gestão. */
const STATUS_AGUARDANDO = 'PENDING';

/**
 * Total cotado: soma dos itens que têm preço. Calculado na saída, depois da
 * fusão banco + portal, para valer igual nas duas fontes.
 */
function comValorTotal(pedido: PedidoResumo): PedidoResumo {
  const comPreco = pedido.items.filter(
    (item) => typeof item.preco_unitario === 'number',
  );
  if (!comPreco.length) return { ...pedido, valorTotal: null };

  const centavos = comPreco.reduce(
    (acc, item) =>
      acc + Math.round((item.preco_unitario as number) * 100) * item.quantidade,
    0,
  );
  return { ...pedido, valorTotal: centavos / 100 };
}

@Injectable()
export class B2bService {
  private readonly logger = new Logger(B2bService.name);

  constructor(
    private readonly b2bRepository: B2bRepository,
    private readonly b2bPrismaRepository: B2bPrismaRepository,
    private readonly orcamento: OrcamentoService,
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
    if (!gravados.length) {
      return this.comResponsaveis(doPortal.map(comValorTotal));
    }

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

    return this.comResponsaveis(
      [...mesclados, ...somenteNoPortal]
        .map(comValorTotal)
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    );
  }

  /**
   * O vendedor de cada pedido: o atribuído ao pedido pela gestão vence; sem
   * ele, o da carteira do cliente. Carteira fora do ar não derruba a
   * listagem — os pedidos saem sem responsável e o erro vai para o log.
   */
  private async comResponsaveis(
    pedidos: PedidoResumo[],
  ): Promise<PedidoResumo[]> {
    const clientes = pedidos
      .filter((p) => !p.responsavel && p.cli_codigo != null)
      .map((p) => p.cli_codigo as number);
    if (!clientes.length) return pedidos;

    let carteira = new Map<number, { rep_codigo: number; rep_nome: string | null }>();
    try {
      carteira = await this.b2bPrismaRepository.vendedoresDaCarteira(clientes);
    } catch (err: any) {
      this.logger.error(
        `Erro ao ler a carteira dos clientes B2B: ${err?.message}`,
      );
    }

    return pedidos.map((p) => {
      if (p.responsavel || p.cli_codigo == null) return p;
      const vendedor = carteira.get(p.cli_codigo);
      return vendedor
        ? { ...p, responsavel: { ...vendedor, origem: 'CARTEIRA' as const } }
        : p;
    });
  }

  /* ------------------------------------------------ vínculo e responsável */

  /** As empresas do portal; `semVinculo` deixa só as sem cliente do Celta. */
  listarEmpresas(semVinculo: boolean): Promise<PortalEmpresa[]> {
    return this.b2bRepository.listarEmpresas(semVinculo);
  }

  /**
   * Vincula a empresa do master ao cliente do Celta. O cliente é conferido no
   * ERP antes; o vínculo é gravado no portal (master e equipe) e os pedidos
   * já gravados aqui recebem o cliente na mesma hora.
   */
  async vincularCliente(
    masterId: string,
    cliCodigo: number,
  ): Promise<{ company: string; cli_codigo: number; cli_nome: string }> {
    if (!Number.isInteger(cliCodigo) || cliCodigo <= 0) {
      throw new BadRequestException('Informe o código do cliente do Celta.');
    }
    // NotFound sobe para a tela: "Cliente N não encontrado no ERP."
    const cliente = await this.orcamento.cliente(cliCodigo);
    const vinculo = await this.b2bRepository.vincularCliente(
      masterId,
      cliCodigo,
    );

    // Os pedidos já gravados da empresa só saem da fila "Sem vínculo" quando
    // ganham o cliente; a listagem lê o portal de novo e preenche.
    await this.listarPedidos().catch((err: any) =>
      this.logger.warn(
        `Vínculo gravado, mas a releitura dos pedidos falhou: ${err?.message}`,
      ),
    );

    return {
      company: vinculo.company,
      cli_codigo: cliCodigo,
      cli_nome: cliente.cli_nome,
    };
  }

  /**
   * Pedidos aguardando atendimento cujo cliente não tem vendedor na carteira
   * nem atribuição da gestão: a fila "Sem responsável".
   */
  async pedidosSemResponsavel(): Promise<PedidoResumo[]> {
    const pedidos = await this.listarPedidos();
    return pedidos.filter(
      (p) =>
        p.status === STATUS_AGUARDANDO &&
        p.cli_codigo != null &&
        !p.responsavel,
    );
  }

  /**
   * A gestão escolhe o vendedor deste pedido. Vale só para o pedido: o
   * cliente continua sem carteira até a gestão carteirizá-lo pela tela de
   * carteirização. Cliente que já tem vendedor na carteira não aceita.
   */
  async atribuirVendedor(
    identificador: string,
    repCodigo: number,
    usuarioNome?: string | null,
  ): Promise<{ id: string; responsavel: ResponsavelPedido }> {
    if (!Number.isInteger(repCodigo) || repCodigo <= 0) {
      throw new BadRequestException('Informe o vendedor.');
    }
    const pedido =
      await this.b2bPrismaRepository.buscarPorIdentificador(identificador);
    if (!pedido) {
      throw new NotFoundException(
        `Pedido B2B não encontrado: ${identificador}`,
      );
    }
    if (pedido.status !== STATUS_AGUARDANDO) {
      throw new BadRequestException(
        `Pedido ${pedido.orderNumber} já está em ${pedido.status}: só pedido aguardando recebe vendedor.`,
      );
    }
    if (pedido.cli_codigo == null) {
      throw new BadRequestException(
        `Pedido ${pedido.orderNumber} sem cliente do Celta: vincule a empresa primeiro.`,
      );
    }
    const daCarteira = (
      await this.b2bPrismaRepository.vendedoresDaCarteira([pedido.cli_codigo])
    ).get(pedido.cli_codigo);
    if (daCarteira) {
      throw new ConflictException(
        `O cliente ${pedido.cli_codigo} já é da carteira de ${daCarteira.rep_nome ?? daCarteira.rep_codigo}.`,
      );
    }

    const vendedor = (await this.orcamento.vendedores()).find(
      (v) => v.rep_codigo === repCodigo,
    );
    if (!vendedor) {
      throw new BadRequestException(
        `Vendedor ${repCodigo} não é um vendedor ativo do atacado.`,
      );
    }

    await this.b2bPrismaRepository.atribuirVendedor(pedido.id, {
      rep_codigo: vendedor.rep_codigo,
      rep_nome: vendedor.rep_nome,
      atribuido_por: usuarioNome?.trim() || null,
    });
    return {
      id: pedido.id,
      responsavel: {
        rep_codigo: vendedor.rep_codigo,
        rep_nome: vendedor.rep_nome,
        origem: 'PEDIDO',
      },
    };
  }

  /**
   * O que está no banco tem precedência; o portal preenche o que falta ali —
   * na prática, nome, telefone e carteira do comprador, e o preço cotado dos
   * pedidos gravados antes das colunas de preço existirem.
   */
  private mesclar(
    gravado: PedidoResumo,
    portal: PedidoResumo | undefined,
  ): PedidoResumo {
    if (!portal) return gravado;

    const precoDoPortal = new Map(
      portal.items.map((item) => [item.pro_codigo, item.preco_unitario]),
    );

    return {
      orderNumber: gravado.orderNumber || portal.orderNumber,
      createdAt: gravado.createdAt || portal.createdAt,
      pedidoId: gravado.pedidoId || portal.pedidoId,
      comprador: gravado.comprador || portal.comprador,
      status: gravado.status || portal.status,
      clienteViuPreco: gravado.clienteViuPreco ?? portal.clienteViuPreco,
      margem: gravado.margem ?? portal.margem,
      valorTotal: null,
      cli_codigo: gravado.cli_codigo ?? portal.cli_codigo,
      responsavel: gravado.responsavel,
      items: gravado.items.length
        ? gravado.items.map((item) => ({
            ...item,
            preco_unitario:
              item.preco_unitario ?? precoDoPortal.get(item.pro_codigo) ?? null,
          }))
        : portal.items,
      user: {
        id: gravado.user.id || portal.user?.id,
        nome: gravado.user.nome || portal.user?.nome,
        phone: gravado.user.phone || portal.user?.phone,
        carteira: gravado.user.carteira || portal.user?.carteira,
        company: gravado.user.company || portal.user?.company,
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
        // Portal antigo, sem o campo: "não sei", e não "não viu".
        clienteViuPreco: pedido.clienteViuPreco ?? null,
        margem: pedido.margem ?? null,
        valorTotal: null,
        cli_codigo: pedido.user?.cliCodigo ?? null,
        responsavel: null,
        items: pedido.items.map((item) => ({
          pro_codigo: item.product?.proCodigo,
          quantidade: item.quantity,
          promocao: item.product?.promotion?.textoPromocional || null,
          preco_unitario: item.precoUnitario ?? null,
        })),
        user: {
          id: pedido.user?.id,
          nome: pedido.user?.name,
          phone: pedido.user?.phone,
          carteira: pedido.user?.carteira,
          company: pedido.user?.company,
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
      clienteViuPreco: row.clienteViuPreco,
      margem: row.margem,
      valorTotal: null,
      cli_codigo: row.cli_codigo,
      responsavel:
        row.rep_codigo != null
          ? { rep_codigo: row.rep_codigo, rep_nome: row.rep_nome, origem: 'PEDIDO' }
          : null,
      items: row.itens.map((item) => ({
        pro_codigo: String(item.pro_codigo),
        quantidade: item.quantidade,
        promocao: item.promocao,
        preco_unitario: item.preco_unitario,
      })),
      // A tabela só tem o id do comprador; nome, telefone e carteira vêm do
      // portal, no `mesclar`.
      user: {
        id: row.userId,
        nome: '',
        phone: '',
        carteira: '',
        company: '',
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

      await this.preencherClientes(
        resumos.filter((p) => existentes.has(p.orderNumber)),
      );

      for (const resumo of resumos) {
        if (!resumo.orderNumber || existentes.has(resumo.orderNumber)) continue;

        const criadoEm = resumo.createdAt ? new Date(resumo.createdAt) : null;

        const pedido: OrcamentoB2bInput = {
          orderNumber: resumo.orderNumber,
          userId: resumo.user?.id ?? '',
          pedidoId: resumo.pedidoId ?? null,
          comprador: resumo.comprador ?? null,
          status: resumo.status ?? null,
          clienteViuPreco: resumo.clienteViuPreco,
          margem: resumo.margem,
          cli_codigo: resumo.cli_codigo,
          createdAt:
            criadoEm && !Number.isNaN(criadoEm.getTime()) ? criadoEm : null,
          itens: resumo.items
            .map((item) => ({
              pro_codigo: Number(item.pro_codigo),
              quantidade: Number(item.quantidade),
              promocao: item.promocao ?? null,
              preco_unitario: item.preco_unitario ?? null,
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

  /**
   * Pedidos gravados antes do vínculo da empresa ganham o cliente que o portal
   * passou a informar. Um UPDATE por cliente; só onde ainda está vazio.
   */
  private async preencherClientes(resumos: PedidoResumo[]): Promise<void> {
    const porCliente = new Map<number, string[]>();
    for (const p of resumos) {
      if (p.cli_codigo == null) continue;
      porCliente.set(p.cli_codigo, [
        ...(porCliente.get(p.cli_codigo) ?? []),
        p.orderNumber,
      ]);
    }
    for (const [cli, orderNumbers] of porCliente) {
      await this.b2bPrismaRepository.preencherCliente(orderNumbers, cli);
    }
  }
}
