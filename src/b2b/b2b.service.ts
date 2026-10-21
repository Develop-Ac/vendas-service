import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { SalvarOrcamentoDto } from '../orcamento/dto/orcamento.dto';
import { OrcamentoService, PromosPortal } from '../orcamento/orcamento.service';
import { B2bCarteiraService } from './b2b.carteira.service';
import { B2bRepository, PortalEmpresa, PortalOrder } from './b2b.repository';
import {
  B2bPrismaRepository,
  OrcamentoB2bGravado,
  OrcamentoB2bInput,
  PedidoParaAssumir,
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
  /** Promoção do portal: preço puro (sem margem) e fim (YYYY-MM-DD). */
  promocao_preco?: number | null;
  promocao_fim?: string | null;
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
  /** Observação e endereço que o comprador escreveu no portal. */
  notas?: string | null;
  endereco?: string | null;
}

/** Pedido na fila "aguardando cotação" da tela do orçamento. */
export interface PedidoAguardando {
  id: string;
  orderNumber: string;
  createdAt: string;
  empresa: string | null;
  comprador: string | null;
  cli_codigo: number | null;
  clienteViuPreco: boolean | null;
  itens: number;
  /** Algum item estava em promoção no portal. */
  promocao: boolean;
  valorTotal: number | null;
  responsavel: ResponsavelPedido | null;
}

/** Quem está assumindo ou recusando (o vendas-service não tem sessão). */
export interface QuemAtende {
  rep_codigo?: number | null;
  usuario_id?: string | null;
  usuario_nome?: string | null;
  /** Gestão do atacado: pode assumir no lugar do vendedor responsável. */
  gestao?: boolean;
  /**
   * Só a gestão: vendedor do orçamento ao assumir. Sem ele, vale o
   * responsável (atribuído ao pedido ou da carteira).
   */
  vendedor_codigo?: number | null;
}

/** Só pedido ainda não assumido entra nas filas da gestão. */
const STATUS_AGUARDANDO = 'PENDING';

/** Teto de páginas lidas do portal (200 pedidos cada): trava contra laço sem fim. */
const MAX_PAGINAS = 50;

/** Sem `B2B_PEDIDOS_DESDE`, só pedido das últimas 2 h avisa — reinício não vira enxurrada. */
const JANELA_AVISO_MS = 2 * 3_600_000;

/**
 * A partir de quando um pedido novo gera aviso: `B2B_PEDIDOS_DESDE` (a data de
 * entrada no ar) ou, sem ela, as últimas 2 h. Pedido antigo que só agora foi
 * gravado entra no histórico, calado.
 */
export function corteDeAviso(agora = Date.now()): number {
  const desde = Date.parse(process.env.B2B_PEDIDOS_DESDE ?? '');
  return Number.isNaN(desde) ? agora - JANELA_AVISO_MS : desde;
}

/** Pedido do portal no formato da intranet. */
function resumoDoPortal(pedido: PortalOrder): PedidoResumo {
  return {
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
    notas: pedido.notes?.trim() || null,
    endereco: pedido.shippingAddress?.trim() || null,
    items: pedido.items.map((item) => ({
      pro_codigo: item.product?.proCodigo,
      quantidade: item.quantity,
      promocao: item.product?.promotion?.textoPromocional || null,
      preco_unitario: item.precoUnitario ?? null,
      promocao_preco:
        item.promocaoPreco != null && Number.isFinite(Number(item.promocaoPreco))
          ? Number(item.promocaoPreco)
          : null,
      promocao_fim: item.promocaoFim ? String(item.promocaoFim).slice(0, 10) : null,
    })),
    user: {
      id: pedido.user?.id,
      nome: pedido.user?.name,
      phone: pedido.user?.phone,
      carteira: pedido.user?.carteira,
      company: pedido.user?.company,
    },
  };
}

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
    private readonly carteira: B2bCarteiraService,
    private readonly avisos: AvisosVendasService,
  ) {}

  /* --------------------------------------------- sincronização com o portal */

  /**
   * O que roda a cada minuto (B2bPedidosScheduler): lê o portal do pedido
   * mais novo para o mais antigo e para na primeira página sem novidade. Grava
   * os novos, completa o cliente dos já gravados e avisa quem atende.
   * O portal não avisa a intranet (a rede só abre daqui para a nuvem), então
   * é esta leitura que traz o pedido sem ninguém abrir a tela.
   */
  async sincronizarComPortal(): Promise<{ novos: number; avisados: number }> {
    const novos: PedidoResumo[] = [];
    for (let page = 1; page <= MAX_PAGINAS; page++) {
      const r = await this.b2bRepository.listarPedidos(page);
      const resumos = r.data.map(resumoDoPortal).filter((p) => p.orderNumber);
      if (!resumos.length) break;

      const existentes = await this.b2bPrismaRepository.orderNumbersExistentes(
        resumos.map((p) => p.orderNumber),
      );
      const jaGravados = resumos.filter((p) => existentes.has(p.orderNumber));
      await this.preencherClientes(jaGravados);
      await this.b2bPrismaRepository
        .completarDoPortal(
          jaGravados
            .filter((p) => p.status === STATUS_AGUARDANDO)
            .map((p) => ({
              orderNumber: p.orderNumber,
              empresa: p.user?.company || null,
              observacao: p.notas ?? null,
              endereco: p.endereco ?? null,
            })),
        )
        .catch((err: any) =>
          this.logger.warn(`Completar pedidos B2B gravados: ${err?.message}`),
        );
      const daPagina = resumos.filter((p) => !existentes.has(p.orderNumber));
      await this.gravarPedidosNovos(daPagina);
      novos.push(...daPagina);

      if (!daPagina.length || page >= (r.pagination?.pages ?? 1)) break;
    }

    const avisados = await this.avisarNovos(novos);
    if (novos.length) {
      this.logger.log(
        `Portal B2B: ${novos.length} pedido(s) novo(s), ${avisados} aviso(s).`,
      );
    }
    return { novos: novos.length, avisados };
  }

  /**
   * Aviso de pedido novo ainda aguardando: ao vendedor responsável; sem ele, à
   * gestão do atacado (que vincula a empresa ou atribui o vendedor).
   */
  private async avisarNovos(novos: PedidoResumo[]): Promise<number> {
    const corte = corteDeAviso();
    const avisar = novos.filter(
      (p) =>
        p.status === STATUS_AGUARDANDO &&
        Date.parse(p.createdAt ?? '') >= corte,
    );
    if (!avisar.length) return 0;

    for (const p of await this.comResponsaveis(avisar.map(comValorTotal))) {
      const cliente = p.user?.company || p.user?.nome || p.orderNumber;
      if (p.responsavel) {
        void this.avisos.b2bNovo({
          orderNumber: p.orderNumber,
          cliente,
          rep_codigo: p.responsavel.rep_codigo,
          itens: p.items.length,
          valor: p.valorTotal,
        });
      } else {
        void this.avisos.b2bSemResponsavel({
          orderNumber: p.orderNumber,
          empresa: cliente,
          motivo:
            p.cli_codigo == null
              ? 'Empresa sem vínculo com o Celta: vincule na tela B2B.'
              : `Cliente ${p.cli_codigo} sem vendedor na carteira: atribua na tela B2B.`,
        });
      }
    }
    return avisar.length;
  }

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

  /* ------------------------------------------- aguardando, assumir, recusar */

  /**
   * A fila "aguardando cotação" da tela do orçamento: do banco, pendentes
   * desde o corte. Com `rep`, só os do vendedor (atribuído ao pedido ou da
   * carteira do cliente); sem ele, todos (gestão).
   */
  async pedidosAguardando(rep?: number | null): Promise<PedidoAguardando[]> {
    const rows = await this.b2bPrismaRepository.listarAguardando(
      new Date(corteDeAviso()),
    );
    const resumos = await this.comResponsaveis(
      rows.map((r) => comValorTotal(this.paraResumo(r))),
    );
    const linhas = rows.map((r, i) => {
      const p = resumos[i];
      return {
        id: r.id,
        orderNumber: r.orderNumber,
        createdAt: p.createdAt,
        empresa: r.empresa,
        comprador: r.comprador,
        cli_codigo: r.cli_codigo,
        clienteViuPreco: r.clienteViuPreco,
        itens: r.itens.length,
        promocao: r.itens.some((it) => !!it.promocao),
        valorTotal: p.valorTotal,
        responsavel: p.responsavel,
      };
    });
    return rep != null
      ? linhas.filter((l) => l.responsavel?.rep_codigo === rep)
      : linhas;
  }

  /**
   * O vendedor (ou a gestão, no lugar dele) assume o pedido: vira orçamento do
   * atacado em RASCUNHO, com o vendedor responsável, e o portal passa para
   * "em atendimento". O preço é o que o cliente viu (`preco_base`: acima da
   * tabela vale como base do desconto; igual ou abaixo, vale a tabela); sem
   * preço visto, a tabela com a margem do comprador. Item que não existe mais
   * no ERP fica de fora e é anotado na observação.
   */
  async assumir(
    identificador: string,
    quem: QuemAtende,
  ): Promise<{ orcamento_id: string; numero: number; fora: number[] }> {
    const pedido =
      await this.b2bPrismaRepository.buscarParaAssumir(identificador);
    if (!pedido) {
      throw new NotFoundException(`Pedido B2B não encontrado: ${identificador}`);
    }
    if (pedido.status !== STATUS_AGUARDANDO || pedido.orcamento_id) {
      throw new ConflictException(
        `Pedido ${pedido.orderNumber} já foi atendido (${pedido.status}).`,
      );
    }
    if (pedido.cli_codigo == null) {
      throw new BadRequestException(
        `Pedido ${pedido.orderNumber} sem cliente do Celta: vincule a empresa na tela B2B.`,
      );
    }
    const [resumo] = await this.comResponsaveis([this.paraResumo(pedido)]);
    // A gestão escolhe quem fica com a venda (inclusive outro que não o da
    // carteira); o vendedor só assume o que é dele.
    const escolhido =
      quem.gestao && quem.vendedor_codigo != null
        ? await this.vendedorDoAtacado(quem.vendedor_codigo)
        : null;
    const responsavel = escolhido ?? resumo.responsavel;
    if (!responsavel) {
      throw new BadRequestException(
        `Pedido ${pedido.orderNumber} sem vendedor: escolha quem atende.`,
      );
    }
    if (!quem.gestao && quem.rep_codigo !== responsavel.rep_codigo) {
      throw new ForbiddenException(
        `Pedido ${pedido.orderNumber} é de ${responsavel.rep_nome ?? responsavel.rep_codigo}.`,
      );
    }

    const por = quem.usuario_nome?.trim() || `rep ${quem.rep_codigo ?? '?'}`;
    if (!(await this.b2bPrismaRepository.reservar(pedido.id, por))) {
      throw new ConflictException(
        `Pedido ${pedido.orderNumber} já está sendo assumido por outra pessoa.`,
      );
    }

    let criado: { id: string; numero: number };
    let fora: number[] = [];
    try {
      const cliente = await this.orcamento.cliente(pedido.cli_codigo);
      const produtos = await this.orcamento.produtosPorCodigo(
        pedido.itens.map((i) => i.pro_codigo),
        cliente.tabela_preco ?? null,
        pedido.cli_codigo,
      );
      const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
      fora = pedido.itens
        .filter((i) => !porCodigo.has(i.pro_codigo))
        .map((i) => i.pro_codigo);
      const validos = pedido.itens.filter((i) => porCodigo.has(i.pro_codigo));
      if (!validos.length) {
        throw new BadRequestException(
          `Nenhum item do pedido ${pedido.orderNumber} existe mais no ERP.`,
        );
      }

      const margem = Number(pedido.margem ?? 0);
      const comMargem = (preco: number) =>
        Math.round(preco * (1 + (margem > 0 ? margem : 0) / 100) * 100) / 100;

      // Promoção do portal: o orçamento a trata como promoção (preço fechado,
      // metade da bolsa, validade até o fim). Preço = o que o comprador viu, a
      // promoção com a margem dele — também quando ele não via preço.
      const promosPortal: PromosPortal = new Map();
      for (const i of validos) {
        if (!(Number(i.promocao_preco) > 0) || !i.promocao_fim) continue;
        promosPortal.set(i.pro_codigo, {
          preco:
            pedido.clienteViuPreco && Number(i.preco_unitario) > 0
              ? Number(i.preco_unitario)
              : comMargem(Number(i.promocao_preco)),
          fim: i.promocao_fim,
          descricao: `Promoção do portal B2B${i.promocao ? `: ${i.promocao}` : ''}`.slice(0, 200),
        });
      }

      const itens = validos.map((i) => {
        const tabela = Number(porCodigo.get(i.pro_codigo)?.preco_tabela ?? 0);
        const base =
          pedido.clienteViuPreco && i.preco_unitario != null
            ? i.preco_unitario
            : margem > 0 && tabela > 0
              ? comMargem(tabela)
              : null;
        return {
          pro_codigo: i.pro_codigo,
          quantidade: i.quantidade,
          // Em promoção o preço é o da promoção: base acima da tabela não vale.
          ...(base != null && base > 0 && !promosPortal.has(i.pro_codigo)
            ? { preco_base: base }
            : {}),
        };
      });

      criado = await this.orcamento.criar({
        cli_codigo: pedido.cli_codigo,
        rep_codigo: responsavel.rep_codigo,
        rep_nome: responsavel.rep_nome ?? undefined,
        observacao: this.observacaoDoPedido(pedido, fora),
        itens,
        usuario_id: quem.usuario_id ?? undefined,
        usuario_nome: quem.usuario_nome ?? undefined,
      } satisfies SalvarOrcamentoDto, { promosPortal });
    } catch (err) {
      await this.b2bPrismaRepository.liberarReserva(pedido.id).catch(() => undefined);
      throw err;
    }

    if (escolhido) {
      // O pedido registra o vendedor escolhido, como num "designar".
      await this.b2bPrismaRepository.atribuirVendedor(pedido.id, {
        rep_codigo: escolhido.rep_codigo,
        rep_nome: escolhido.rep_nome ?? '',
        atribuido_por: quem.usuario_nome?.trim() || null,
      });
    }
    await this.b2bPrismaRepository.concluirAssumir(pedido.id, criado.id);
    this.avisos.b2bEncerrado(pedido.orderNumber);
    // O orçamento já existe: o portal fora do ar não pode desfazê-lo. Fica no
    // log; a próxima sincronização de status corrige.
    if (pedido.pedidoId) {
      await this.b2bRepository
        .atualizarStatusPedido(pedido.pedidoId, 'PROCESSING')
        .catch((err: any) =>
          this.logger.warn(
            `Pedido ${pedido.orderNumber} assumido, mas o portal não mudou para PROCESSING: ${err?.message}`,
          ),
        );
    }
    return { orcamento_id: criado.id, numero: criado.numero, fora };
  }

  /** Recusa com motivo: o portal mostra o pedido cancelado, com o motivo. */
  async recusar(
    identificador: string,
    motivo: string,
    quem: QuemAtende,
  ): Promise<{ id: string; status: string }> {
    const texto = (motivo ?? '').trim();
    if (texto.length < 3) {
      throw new BadRequestException('Informe o motivo da recusa.');
    }
    if (texto.length > 500) {
      throw new BadRequestException('O motivo deve ter no máximo 500 caracteres.');
    }
    const pedido =
      await this.b2bPrismaRepository.buscarParaAssumir(identificador);
    if (!pedido) {
      throw new NotFoundException(`Pedido B2B não encontrado: ${identificador}`);
    }
    if (pedido.status !== STATUS_AGUARDANDO || pedido.orcamento_id || pedido.assumido_em) {
      throw new ConflictException(
        `Pedido ${pedido.orderNumber} já foi atendido (${pedido.status}).`,
      );
    }
    if (!quem.gestao) {
      const [resumo] = await this.comResponsaveis([this.paraResumo(pedido)]);
      if (resumo.responsavel?.rep_codigo !== quem.rep_codigo) {
        throw new ForbiddenException(
          `Só o vendedor responsável ou a gestão recusam o pedido ${pedido.orderNumber}.`,
        );
      }
    }

    // Portal primeiro: se ele recusar, a intranet não fica com um cancelado que lá não existe.
    if (pedido.pedidoId) {
      await this.b2bRepository.atualizarStatusPedido(pedido.pedidoId, 'CANCELLED', texto);
    }
    await this.b2bPrismaRepository.registrarRecusa(pedido.id, texto);
    this.avisos.b2bEncerrado(pedido.orderNumber);
    return { id: pedido.id, status: 'CANCELLED' };
  }

  /** Vendedor ativo do atacado (comissão); 400 se não for. */
  private async vendedorDoAtacado(
    repCodigo: number,
  ): Promise<{ rep_codigo: number; rep_nome: string; origem: 'PEDIDO' }> {
    const v = (await this.orcamento.vendedores()).find(
      (x) => x.rep_codigo === repCodigo,
    );
    if (!v) {
      throw new BadRequestException(
        `Vendedor ${repCodigo} não é um vendedor ativo do atacado.`,
      );
    }
    return { rep_codigo: v.rep_codigo, rep_nome: v.rep_nome, origem: 'PEDIDO' };
  }

  /**
   * Vínculo feito a partir do pedido (tela do orçamento da gestão). O portal
   * vincula pelo master da empresa e o pedido só conhece o comprador: o master
   * é achado pela empresa do pedido, a mesma `company` exata do portal.
   */
  async vincularClienteDoPedido(
    identificador: string,
    cliCodigo: number,
  ): Promise<{ cli_codigo: number; cli_nome: string; responsavel: ResponsavelPedido | null }> {
    const pedido =
      await this.b2bPrismaRepository.buscarParaAssumir(identificador);
    if (!pedido) {
      throw new NotFoundException(`Pedido B2B não encontrado: ${identificador}`);
    }
    if (!pedido.empresa) {
      throw new BadRequestException(
        `Pedido ${pedido.orderNumber} sem empresa gravada: vincule pela tela Portal B2B.`,
      );
    }
    const master = (await this.b2bRepository.listarEmpresas(false)).find(
      (e) => e.company === pedido.empresa,
    );
    if (!master) {
      throw new NotFoundException(
        `Empresa "${pedido.empresa}" não encontrada no portal: vincule pela tela Portal B2B.`,
      );
    }
    const r = await this.vincularCliente(master.id, cliCodigo);
    const vendedor = (
      await this.b2bPrismaRepository.vendedoresDaCarteira([cliCodigo])
    ).get(cliCodigo);
    return {
      cli_codigo: r.cli_codigo,
      cli_nome: r.cli_nome,
      responsavel: vendedor ? { ...vendedor, origem: 'CARTEIRA' } : null,
    };
  }

  private observacaoDoPedido(pedido: PedidoParaAssumir, fora: number[]): string {
    const linhas = [
      `Pedido B2B ${pedido.orderNumber}${pedido.comprador ? ` · comprador ${pedido.comprador}` : ''}`,
    ];
    if (pedido.endereco && pedido.endereco !== 'A definir') {
      linhas.push(`Entrega: ${pedido.endereco}`);
    }
    if (pedido.observacao) linhas.push(`Obs. do cliente: ${pedido.observacao}`);
    if (pedido.clienteViuPreco === false) {
      linhas.push('Preço não exibido ao cliente no portal.');
    }
    const promos = pedido.itens.filter((i) => i.promocao).map((i) => i.pro_codigo);
    if (promos.length) {
      linhas.push(`Promoção do portal B2B nos itens: ${promos.join(', ')}.`);
    }
    if (fora.length) {
      linhas.push(`Fora do orçamento (não existem mais no ERP): ${fora.join(', ')}.`);
    }
    return linhas.join('\n');
  }

  /* ------------------------------------------------ vínculo e responsável */

  /**
   * As empresas do portal; `semVinculo` deixa só as sem cliente do Celta. Com
   * o acesso aberto a quem não é cliente, essa lista cresce: cada empresa vem
   * com quantos pedidos tem esperando, e as que têm vêm primeiro — é o pedido
   * que caiu que pede o vínculo.
   */
  async listarEmpresas(
    semVinculo: boolean,
  ): Promise<Array<PortalEmpresa & { pedidos_aguardando: number }>> {
    const empresas = await this.b2bRepository.listarEmpresas(semVinculo);
    if (!semVinculo) {
      return empresas.map((e) => ({ ...e, pedidos_aguardando: 0 }));
    }

    const porEmpresa = new Map<string, number>();
    try {
      for (const p of await this.listarPedidos()) {
        const company = p.user?.company;
        if (p.status !== STATUS_AGUARDANDO || p.cli_codigo != null || !company) {
          continue;
        }
        porEmpresa.set(company, (porEmpresa.get(company) ?? 0) + 1);
      }
    } catch (err: any) {
      this.logger.warn(
        `Empresas sem vínculo sem a contagem de pedidos: ${err?.message}`,
      );
    }

    return empresas
      .map((e) => ({
        ...e,
        pedidos_aguardando: (e.company && porEmpresa.get(e.company)) || 0,
      }))
      .sort((a, b) => b.pedidos_aguardando - a.pedidos_aguardando);
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
    // O portal precisa do cliente antes do vínculo: é dele que sai a carteira
    // (o vendedor) da empresa, já na gravação do código.
    await this.carteira.enviarCliente(cliente);
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
   * A gestão escolhe o vendedor deste pedido. Vale só para o pedido — também
   * quando o cliente já tem vendedor na carteira (férias, por exemplo): a
   * carteira não muda; isso continua na tela de carteirização.
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
    const vendedor = await this.vendedorDoAtacado(repCodigo);

    await this.b2bPrismaRepository.atribuirVendedor(pedido.id, {
      rep_codigo: vendedor.rep_codigo,
      rep_nome: vendedor.rep_nome,
      atribuido_por: usuarioNome?.trim() || null,
    });
    // Sai da caixa da gestão e vai para o vendedor escolhido.
    this.avisos.b2bEncerrado(pedido.orderNumber);
    const resumo = await this.b2bPrismaRepository
      .resumoDoPedido(pedido.id)
      .catch(() => ({ itens: 0, valor: null }));
    void this.avisos.b2bNovo({
      orderNumber: pedido.orderNumber,
      cliente: `Cliente ${pedido.cli_codigo}`,
      rep_codigo: vendedor.rep_codigo,
      ...resumo,
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
      // Todas as páginas: antes só a primeira (50), e o pedido mais antigo que
      // isso sumia da tela.
      const pedidos: PortalOrder[] = [];
      for (let page = 1; page <= MAX_PAGINAS; page++) {
        const r = await this.b2bRepository.listarPedidos(page);
        pedidos.push(...r.data);
        if (!r.data.length || page >= (r.pagination?.pages ?? 1)) break;
      }
      return pedidos.map(resumoDoPortal);
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
          empresa: resumo.user?.company?.trim() || null,
          observacao: resumo.notas ?? null,
          endereco: resumo.endereco ?? null,
          createdAt:
            criadoEm && !Number.isNaN(criadoEm.getTime()) ? criadoEm : null,
          itens: resumo.items
            .map((item) => ({
              pro_codigo: Number(item.pro_codigo),
              quantidade: Number(item.quantidade),
              promocao: item.promocao ?? null,
              preco_unitario: item.preco_unitario ?? null,
              promocao_preco: item.promocao_preco ?? null,
              promocao_fim: item.promocao_fim ? new Date(`${item.promocao_fim}T00:00:00Z`) : null,
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
