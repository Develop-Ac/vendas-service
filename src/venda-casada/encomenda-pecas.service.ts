import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ANEXO_TIPO_CARRO,
  ANEXO_TIPO_COMPROVANTE,
  AnexoTipo,
  ColunaEtapa,
  CreateItemEncomendadoInput,
  CreateVendaCasadaItemInput,
  EncomendaPecasRepository,
  VendaCasadaComItens,
} from './encomenda-pecas.repository';
import { S3Service } from '../storage/s3.service';
import {
  CreateVendaCasadaDto,
  EncomendaPecaItemDto,
} from './dto/create-encomenda-pecas.dto';
import { AddPecasCotadasDto, VendaCasadaItemDto } from './dto/add-pecas-cotadas.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateItemCotadoDto } from './dto/update-item-cotado.dto';
import { UpdateItemCotadoFornecedorDto } from './dto/update-item-cotado-fornecedor.dto';
import { UpdateNfeDto } from './dto/update-nfe.dto';
import { UploadedFileData } from '../common/types/uploaded-file';
import {
  ven_encomenda_pecas_anexos,
  ven_encomenda_pecas_itens_cotados,
} from '@prisma/client';
import {
  EncomendaPecasErpRepository,
  ProdutoEncomenda,
  ClienteEncomenda,
  FornecedorEncomenda,
} from './encomenda-pecas.erp.repository';
import { ComprasApiService, PedidosDaEncomenda } from '../common/compras-api/compras-api.service';
import { formatarPedidoCompras, montarItensPedidoCompras } from './encomenda-pecas.pedido';

/** Status que exige `motivo` (gravado em motivoCancelamento). */
const STATUS_CANCELADO = 'Cancelado';

/** Ao entrar neste status o pedido de compra é gerado no compras-service. */
const STATUS_COMPRADO = 'Comprado';

/**
 * Etapas em que compras ainda pode trocar o fornecedor de um item cotado antigo (texto,
 * sem código): do início até "Liberado para comprar", inclusive. Depois do "Comprado" o
 * pedido já foi gerado e o fornecedor não muda mais por aqui.
 */
const STATUS_ATE_LIBERADO = [
  'aguardando cotação',
  'em aberto',
  'em cotação',
  'em andamento',
  'aguardando sup. compras 1',
  'aguardando vendedor',
  'aguardando sup. compras 2',
  'aguardando sup. compras',
  'liberado para comprar',
];

/** Único status em que compras pode editar os itens cotados. */
const STATUS_EM_COTACAO = 'Em cotação';

/** Cuiabá é UTC-4 o ano todo (sem horário de verão). */
const FUSO_CUIABA_MS = 4 * 3_600_000;

/**
 * Agora no horário de Cuiabá, para gravar em coluna TIMESTAMP sem fuso: o Prisma
 * grava os campos UTC do Date, então deslocamos 4h para o valor gravado ser a
 * hora local (é o que a tela mostra, sem converter).
 */
function agoraCuiaba(): Date {
  return new Date(Date.now() - FUSO_CUIABA_MS);
}

/** Dias que o vendedor tem para concluir a escolha dos itens. */
const PRAZO_PADRAO_DIAS = 7;

/** Hoje em Cuiabá + PRAZO_PADRAO_DIAS, à meia-noite UTC (como o Prisma grava @db.Date). */
function prazoPadrao(): Date {
  const hoje = agoraCuiaba();
  return new Date(
    Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() + PRAZO_PADRAO_DIAS),
  );
}

/**
 * O prazo padrão começa a contar quando a encomenda vai para o vendedor (direto
 * ou passando pelo Sup. Compras 1) saindo da cotação, ou quando o Sup. Compras 2
 * devolve para ele. Liberar do Sup. Compras 1 para o vendedor mantém o prazo.
 */
const ORIGENS_QUE_DEFINEM_PRAZO = ['em cotação', 'aguardando sup. compras 2'];
const DESTINOS_QUE_DEFINEM_PRAZO = ['aguardando sup. compras 1', 'aguardando vendedor'];

/** Vencido o prazo nessas etapas, a encomenda conta como cancelada (ver intranet). */
const STATUS_SUJEITOS_AO_PRAZO = [
  'aguardando cotação',
  'em aberto',
  'em cotação',
  'em andamento',
  'aguardando sup. compras 1',
  'aguardando vendedor',
];

/** Etapas em que o relógio para: não contam "até agora". */
const ETAPAS_FINAIS: ColunaEtapa[] = ['chegou', 'cancelado'];

export type TempoEtapa = {
  coluna: ColunaEtapa;
  /** Hora de entrada, como gravada (hora de Cuiabá). */
  entrada: Date;
  /** Minutos na etapa: até a próxima entrada ou, na etapa atual, até agora. */
  duracao_min: number | null;
  atual: boolean;
};

/**
 * Próximas etapas que o fluxo realmente faz a partir de cada uma. Só com essas
 * transições o tempo entre duas horas gravadas é o tempo real na etapa. Outra
 * combinação é buraco no registro (ex.: encomenda antiga, com só
 * `aguardando_cotacao` preenchido pelo SQL, que andou antes de as horas serem
 * gravadas) e a duração fica desconhecida.
 */
const TRANSICOES: Record<ColunaEtapa, ColunaEtapa[]> = {
  aguardando_cotacao: ['em_cotacao', 'cancelado'],
  em_cotacao: ['aguardando_sup_compras_1', 'aguardando_vendedor', 'cancelado'],
  aguardando_sup_compras_1: ['aguardando_vendedor', 'em_cotacao', 'cancelado'],
  aguardando_vendedor: ['aguardando_sup_compras_2', 'cancelado'],
  aguardando_sup_compras_2: ['liberado_para_comprar', 'aguardando_vendedor', 'cancelado'],
  liberado_para_comprar: ['comprado', 'cancelado'],
  comprado: ['chegou', 'cancelado'],
  chegou: [],
  cancelado: [],
};

/**
 * Início do registro das horas por etapa (hora de Cuiabá, "YYYY-MM-DDTHH:mm").
 * Entradas anteriores não foram gravadas ao vivo: nas encomendas antigas,
 * `aguardando_cotacao` é cópia do `created_at` feita pelo SQL. O tempo de uma
 * etapa só conta se a entrada nela for a partir daqui.
 */
const INICIO_REGISTRO_ETAPAS_PADRAO = '2026-09-28T12:00';

function inicioRegistroEtapas(): Date {
  // As horas gravadas são hora de Cuiabá nos campos UTC do Date: lê do mesmo jeito
  const ler = (valor: string) => new Date(`${valor.trim()}Z`);
  const doEnv = ler(process.env.ENCOMENDA_ETAPAS_DESDE || INICIO_REGISTRO_ETAPAS_PADRAO);
  return Number.isNaN(doEnv.getTime()) ? ler(INICIO_REGISTRO_ETAPAS_PADRAO) : doEnv;
}

const INICIO_REGISTRO_ETAPAS = inicioRegistroEtapas();

/** Status legados que equivalem a uma etapa atual (não gravam hora, só leitura). */
const STATUS_LEGADO_COLUNA: Record<string, ColunaEtapa> = {
  'em aberto': 'aguardando_cotacao',
  'em andamento': 'em_cotacao',
  'aguardando sup. compras': 'aguardando_sup_compras_2',
};

/**
 * Etapas pelas quais a encomenda passou, em ordem de entrada. Se voltou para
 * uma etapa, vale a entrada mais recente. "Agora" é o relógio do servidor.
 * `duracao_min` fica null quando não dá para confiar no tempo (entrada antes de
 * INICIO_REGISTRO_ETAPAS ou transição fora de TRANSICOES);
 * a etapa só é `atual` se for a do status atual da encomenda.
 */
function tempoPorEtapa(venda: VendaCasadaComItens, agora: Date): TempoEtapa[] {
  const passadas = Object.values(ETAPA_COLUNA)
    .map((coluna) => ({ coluna, entrada: venda[coluna] }))
    .filter((e): e is { coluna: ColunaEtapa; entrada: Date } => e.entrada instanceof Date)
    .sort((a, b) => a.entrada.getTime() - b.entrada.getTime());

  const status = (venda.status ?? '').trim().toLowerCase();
  const colunaAtual = ETAPA_COLUNA[status] ?? STATUS_LEGADO_COLUNA[status] ?? null;

  return passadas.map((e, i) => {
    const proxima = passadas[i + 1];
    const registrada = e.entrada.getTime() >= INICIO_REGISTRO_ETAPAS.getTime();
    const atual = !proxima && e.coluna === colunaAtual && !ETAPAS_FINAIS.includes(e.coluna);
    const fim = !registrada
      ? null
      : proxima
      ? TRANSICOES[e.coluna].includes(proxima.coluna)
        ? proxima.entrada
        : null
      : atual
        ? agora
        : null;
    return {
      ...e,
      atual,
      duracao_min:
        fim === null ? null : Math.max(0, Math.floor((fim.getTime() - e.entrada.getTime()) / 60_000)),
    };
  });
}

/** O prazo vale até o fim do dia (em Cuiabá): vence a partir do dia seguinte. */
function prazoVencido(venda: VendaCasadaComItens, agora: Date): boolean {
  if (!venda.prazo) return false;
  if (!STATUS_SUJEITOS_AO_PRAZO.includes((venda.status ?? '').trim().toLowerCase())) return false;
  return formatDateOnly(venda.prazo)! < agora.toISOString().slice(0, 10);
}

/**
 * Status -> coluna que guarda quando a encomenda entrou nele. A comparação é sem
 * caixa ("cancelado" e "Cancelado" coexistem). Status fora da lista não grava hora.
 */
const ETAPA_COLUNA: Record<string, ColunaEtapa> = {
  'aguardando cotação': 'aguardando_cotacao',
  'em cotação': 'em_cotacao',
  'aguardando sup. compras 1': 'aguardando_sup_compras_1',
  'aguardando vendedor': 'aguardando_vendedor',
  'aguardando sup. compras 2': 'aguardando_sup_compras_2',
  'liberado para comprar': 'liberado_para_comprar',
  comprado: 'comprado',
  chegou: 'chegou',
  cancelado: 'cancelado',
};

const ANO_MINIMO = 1900;
const ANO_MAXIMO = 2100;

/** Em multipart os valores chegam como string; nos GETs/POST JSON já vêm tipados. */
function toNumberOrNull(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Converte "YYYY-MM-DD" (ou ISO com hora, usando só a parte da data) em Date à meia-noite UTC,
 * que é como o Prisma grava uma coluna @db.Date sem deslocar o dia. Vazio/null vira null.
 */
function toDateOnlyOrNull(valor: unknown, campo: string): Date | null {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(valor).trim());
  if (match) {
    const [ano, mes, dia] = match.slice(1).map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia));
    if (data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia) {
      return data;
    }
  }
  throw new BadRequestException(`"${campo}" deve ser uma data válida no formato YYYY-MM-DD.`);
}

/** Date de coluna @db.Date (meia-noite UTC) -> "YYYY-MM-DD". */
function formatDateOnly(data: Date | null): string | null {
  return data ? data.toISOString().slice(0, 10) : null;
}

function toStringOrNull(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  return String(valor);
}

/** Aceita boolean ou "true"/"false" (multipart); qualquer outra coisa vira null. */
function toBooleanOrNull(valor: unknown): boolean | null {
  if (typeof valor === 'boolean') return valor;
  if (valor === 'true') return true;
  if (valor === 'false') return false;
  return null;
}

/**
 * Achata a lista recebida: aceita array de objetos (JSON) ou string/array de strings
 * com JSON dentro — que é como o multipart entrega campos repetidos.
 */
function achatarListaJson(lista: unknown, campo: string): unknown[] {
  const bruto: unknown[] = Array.isArray(lista)
    ? lista
    : lista === null || lista === undefined || lista === ''
      ? []
      : [lista];

  const saida: unknown[] = [];
  for (const entrada of bruto) {
    let item: unknown = entrada;
    if (typeof item === 'string') {
      try {
        item = JSON.parse(item);
      } catch {
        throw new BadRequestException(`Item inválido em "${campo}": "${entrada}".`);
      }
    }
    if (Array.isArray(item)) {
      saida.push(...achatarListaJson(item, campo));
      continue;
    }
    if (!item || typeof item !== 'object') {
      throw new BadRequestException(`Cada item de "${campo}" deve ser um objeto.`);
    }
    saida.push(item);
  }
  return saida;
}

export type AnexoEnviado = {
  originalname: string;
  mimetype: string;
  size: number;
  key: string;
  url: string;
  tipo: AnexoTipo;
};

export type AnexoComUrl = ven_encomenda_pecas_anexos & { url: string | null };

/** `prazo` sai como "YYYY-MM-DD" para o front não deslocar o dia pelo fuso. */
export type VendaCasadaComUrls = Omit<VendaCasadaComItens, 'anexos' | 'prazo'> & {
  anexos: AnexoComUrl[];
  prazo: string | null;
  /** Calculado no servidor para não depender do relógio do cliente. */
  prazo_vencido: boolean;
  etapas: TempoEtapa[];
  /** "E-100001" quando o pedido de compra já foi gerado; null antes do "Comprado". */
  pedido_compras_formatado: string | null;
};

/**
 * GET /:id traz também os pedidos de compra da encomenda (com NFs e rastreio SSW),
 * lidos do compras-service. Se o compras-service não responder, `pedidos` vem null e
 * `pedidos_erro` diz o motivo — a encomenda em si continua abrindo.
 */
export type VendaCasadaComPedidos = VendaCasadaComUrls & {
  pedidos: PedidosDaEncomenda | null;
  pedidos_erro: string | null;
};

@Injectable()
export class EncomendaPecasService {
  private readonly BUCKET = 'venda-casada';
  private readonly ANEXOS_BUCKET = process.env.S3_BUCKET_AVARIAS || 'encomenda-pecas';

  constructor(
    private readonly repository: EncomendaPecasRepository,
    private readonly s3: S3Service,
    private readonly erpRepository: EncomendaPecasErpRepository,
    private readonly comprasApi: ComprasApiService,
  ) {}

  async findAll(): Promise<VendaCasadaComUrls[]> {
    const vendas = await this.repository.findAll();
    return Promise.all(vendas.map((venda) => this.comUrlDeAnexos(venda)));
  }

  async findById(id: number): Promise<VendaCasadaComPedidos> {
    const record = await this.repository.findById(id);
    if (!record) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }
    const [venda, pedidos] = await Promise.all([
      this.comUrlDeAnexos(record),
      this.pedidosDeCompra(record),
    ]);
    return { ...venda, ...pedidos };
  }

  /**
   * Pedidos de compra da encomenda no compras-service (um por fornecedor), com as NFs
   * vinculadas e o rastreio SSW de cada uma. Só consulta depois do "Comprado"
   * (pedido_compras preenchido); antes disso não há o que mostrar.
   */
  async pedidosDeCompra(
    venda: Pick<VendaCasadaComItens, 'id' | 'pedido_compras'>,
  ): Promise<Pick<VendaCasadaComPedidos, 'pedidos' | 'pedidos_erro'>> {
    if (venda.pedido_compras == null) return { pedidos: null, pedidos_erro: null };
    try {
      return { pedidos: await this.comprasApi.pedidosDaEncomenda(venda.id), pedidos_erro: null };
    } catch (e) {
      return {
        pedidos: null,
        pedidos_erro: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Troca as chaves salvas por URLs pré-assinadas de GET, pra exibir na tela:
   * cada item de `anexos` e também a `imagem` enviada na criação (que vive em
   * outro bucket).
   */
  private async comUrlDeAnexos(venda: VendaCasadaComItens): Promise<VendaCasadaComUrls> {
    const [anexos, imagem] = await Promise.all([
      Promise.all(
        venda.anexos.map(async (anexo) => ({
          ...anexo,
          url: await this.gerarUrlAnexo(anexo.anexo),
        })),
      ),
      venda.imagem ? this.gerarUrlAnexo(venda.imagem, this.BUCKET) : null,
    ]);

    const agora = agoraCuiaba();
    return {
      ...venda,
      anexos,
      imagem,
      prazo: formatDateOnly(venda.prazo),
      prazo_vencido: prazoVencido(venda, agora),
      etapas: tempoPorEtapa(venda, agora),
      pedido_compras_formatado: formatarPedidoCompras(venda.pedido_compras),
    };
  }

  /** Se o objeto não existir mais no bucket, devolve null em vez de quebrar o GET. */
  private async gerarUrlAnexo(
    key: string,
    bucket = this.ANEXOS_BUCKET,
  ): Promise<string | null> {
    try {
      return await this.s3.getPresignedGetUrl(key, undefined, bucket);
    } catch {
      return null;
    }
  }

  /**
   * Cria a encomenda com os itens encomendados e grava as imagens recebidas em
   * `imagens` como anexos do tipo `carro` (as fotos do veículo/peça). Os arquivos
   * enviados depois, em POST /encomenda-pecas/anexo/:id, entram como `comprovante`.
   */
  async create(
    dto: CreateVendaCasadaDto,
    files?: UploadedFileData[],
  ): Promise<VendaCasadaComUrls> {
    const itens = await this.normalizarPecas(dto.pecas);
    if (itens.length === 0) {
      throw new BadRequestException('Informe ao menos uma peça em "pecas".');
    }
    const ano = this.anoObrigatorio(dto.ano);
    const cliente = await this.clienteObrigatorio(dto.cli_codigo);
    const itensCotados = await this.normalizarPecasCotadas(
      dto.pecas_cotadas,
      itens.map((i) => i.pro_codigo),
    );
    const oficina = await this.oficinaPelaOs(dto.os);

    const agora = agoraCuiaba();
    const encomenda = await this.repository.create(
      {
        created_at: agora,
        aguardando_cotacao: agora,
        nome_vendedor: dto.nome_vendedor ?? null,
        carro: dto.carro ?? null,
        ano,
        observacao: dto.observacao ?? null,
        cliente: toStringOrNull(dto.cliente?.trim()) ?? cliente.CLI_NOME,
        numero: dto.numero ?? null,
        oficina,
        os: toStringOrNull(dto.os),
        imagem: null,
        status: 'Aguardando cotação', 
        motivoCancelamento: null,
        motivoDenaoCotar: null,
        prazo: null,
        nfe: null,
        pedido_compras: null,
      },
      itens,
      itensCotados,
    );

    if (files?.length) {
      await this.subirAnexos(encomenda.id, files, ANEXO_TIPO_CARRO);
    }

    return this.findById(encomenda.id);
  }

  private anoObrigatorio(valor: unknown): number {
    const ano = toNumberOrNull(valor);
    if (ano === null || !Number.isInteger(ano) || ano < ANO_MINIMO || ano > ANO_MAXIMO) {
      throw new BadRequestException(
        `Informe o "ano" do carro (inteiro entre ${ANO_MINIMO} e ${ANO_MAXIMO}).`,
      );
    }
    return ano;
  }

  /** O código do cliente é obrigatório e precisa existir no ERP. */
  private async clienteObrigatorio(valor: unknown): Promise<ClienteEncomenda> {
    const codigo = toNumberOrNull(valor);
    if (codigo === null || !Number.isInteger(codigo) || codigo <= 0) {
      throw new BadRequestException('Informe o código do cliente em "cli_codigo".');
    }
    const cliente = await this.erpRepository.clientePorCodigo(codigo);
    if (!cliente) {
      throw new BadRequestException(`Cliente ${codigo} não encontrado no ERP.`);
    }
    return cliente;
  }

  /** Encomenda é de oficina quando a OS informada está com STATUS 1 no ERP; sem OS, false. */
  private async oficinaPelaOs(os: unknown): Promise<boolean> {
    if (os === null || os === undefined || os === '') return false;

    const numero = toNumberOrNull(os);
    if (numero === null || !Number.isInteger(numero) || numero <= 0) {
      throw new BadRequestException('"os" deve ser um número inteiro positivo.');
    }

    const ordem = await this.erpRepository.ordemServicoPorNumero(numero);
    if (!ordem) {
      throw new BadRequestException(`OS ${numero} não encontrada no ERP.`);
    }
    return ordem.STATUS === 1;
  }

  /**
   * Peças encomendadas. O `pro_codigo` é obrigatório e precisa existir no Celta (a
   * tela só deixa digitar o código; descrição e referência ela preenche pela busca e
   * manda em `peca`/`referencia`, que são gravados como vieram). Aceita `pecas` como
   * array de objetos (JSON) ou como string/array de strings com JSON dentro — que é
   * como o multipart entrega campos repetidos.
   */
  private async normalizarPecas(pecas: unknown): Promise<CreateItemEncomendadoInput[]> {
    const itens: CreateItemEncomendadoInput[] = [];
    const existentes = new Set<number>();

    for (const [i, entrada] of achatarListaJson(pecas, 'pecas').entries()) {
      const peca = entrada as Partial<EncomendaPecaItemDto>;

      const proCodigo = toNumberOrNull(peca.pro_codigo);
      if (proCodigo === null || !Number.isInteger(proCodigo) || proCodigo <= 0) {
        throw new BadRequestException(
          `Peça ${i + 1}: informe o "pro_codigo" (código do produto no Celta).`,
        );
      }

      const descricao = toStringOrNull(peca.peca?.trim());
      if (descricao === null) {
        throw new BadRequestException(
          `Peça ${proCodigo}: o campo "peca" (descrição) é obrigatório.`,
        );
      }

      const quantidade = toNumberOrNull(peca.quantidade) ?? 1;
      if (!Number.isInteger(quantidade) || quantidade <= 0) {
        throw new BadRequestException(
          `Peça ${proCodigo}: "quantidade" deve ser um inteiro maior que zero.`,
        );
      }

      if (!existentes.has(proCodigo)) {
        if (!(await this.erpRepository.produtoPorCodigo(proCodigo))) {
          throw new BadRequestException(`Produto ${proCodigo} não encontrado no Celta.`);
        }
        existentes.add(proCodigo);
      }

      itens.push({
        pro_codigo: proCodigo,
        pro_descricao: descricao.slice(0, 255),
        referencia: toStringOrNull(peca.referencia?.trim())?.slice(0, 60) ?? null,
        quantidade,
      });
    }

    return itens;
  }

  /**
   * Fornecedor do item cotado: obrigatoriamente o CÓDIGO do Celta, em `for_codigo` (ou
   * em `fornecedor` só com dígitos). O código precisa existir no ERP; o nome vem da API
   * e é gravado em `fornecedor` — texto livre não é aceito. Na edição, sem nenhum dos
   * dois campos o fornecedor gravado é mantido (`exigir` = false).
   */
  private async fornecedorDoItemCotado(
    item: Partial<VendaCasadaItemDto>,
    indice: number,
    cache: Map<number, FornecedorEncomenda>,
    exigir: boolean,
  ): Promise<{ for_codigo: number | null; fornecedor: string | null }> {
    const texto = toStringOrNull(item.fornecedor)?.trim() ?? null;
    const temCodigo =
      item.for_codigo !== undefined && item.for_codigo !== null && String(item.for_codigo) !== '';
    const codigoBruto = temCodigo ? item.for_codigo : texto && /^\d+$/.test(texto) ? texto : null;

    if (codigoBruto === null) {
      if (!exigir && texto === null) return { for_codigo: null, fornecedor: null };
      throw new BadRequestException(
        `Peça cotada ${indice + 1}: informe o código do fornecedor no Celta em "for_codigo".`,
      );
    }

    const codigo = toNumberOrNull(codigoBruto);
    if (codigo === null || !Number.isInteger(codigo) || codigo <= 0) {
      throw new BadRequestException(
        `Peça cotada ${indice + 1}: "for_codigo" deve ser o código do fornecedor no Celta.`,
      );
    }

    let fornecedor = cache.get(codigo);
    if (!fornecedor) {
      const encontrado = await this.erpRepository.fornecedorPorCodigo(codigo);
      if (!encontrado) {
        throw new BadRequestException(
          `Peça cotada ${indice + 1}: fornecedor ${codigo} não encontrado no Celta.`,
        );
      }
      fornecedor = encontrado;
      cache.set(codigo, fornecedor);
    }
    // Na tela vai o nome fantasia; sem ele, a razão social
    return {
      for_codigo: codigo,
      fornecedor: fornecedor.NOME_FANTASIA ?? fornecedor.FOR_NOME ?? String(codigo),
    };
  }

  /** Campo numérico opcional do item cotado: vazio vira null; texto não numérico é 400. */
  private numeroOpcional(valor: unknown, campo: string, indice: number): number | null {
    const n = toNumberOrNull(valor);
    if (n === null && valor !== null && valor !== undefined && valor !== '') {
      throw new BadRequestException(
        `Peça cotada ${indice + 1}: "${campo}" deve ser um número.`,
      );
    }
    return n;
  }

  /**
   * `pecas_cotadas` é opcional na criação: ausente ou vazia não cria nada.
   * `pro_codigo` (produto do Celta ao qual a cotação se refere) é opcional, mas quando
   * vem precisa ser uma das peças da encomenda (`pecasDaEncomenda`); é ele que vira o
   * item do pedido de compra.
   */
  private async normalizarPecasCotadas(
    pecasCotadas: unknown,
    pecasDaEncomenda: number[] | null = null,
    { exigirFornecedor = true }: { exigirFornecedor?: boolean } = {},
  ): Promise<CreateVendaCasadaItemInput[]> {
    const fornecedores = new Map<number, FornecedorEncomenda>();
    const saida: CreateVendaCasadaItemInput[] = [];

    for (const [i, entrada] of achatarListaJson(pecasCotadas, 'pecas_cotadas').entries()) {
      const item = entrada as Partial<VendaCasadaItemDto>;

      const nome = toStringOrNull(item.nome);
      if (nome === null) {
        throw new BadRequestException(`Peça cotada ${i + 1}: o campo "nome" é obrigatório.`);
      }

      const valor = toNumberOrNull(item.valor);
      if (valor === null) {
        throw new BadRequestException(`Peça cotada ${i + 1}: "valor" deve ser um número.`);
      }

      const proCodigo = this.numeroOpcional(item.pro_codigo, 'pro_codigo', i);
      if (proCodigo !== null) {
        if (!Number.isInteger(proCodigo) || proCodigo <= 0) {
          throw new BadRequestException(
            `Peça cotada ${i + 1}: "pro_codigo" deve ser o código do produto no Celta.`,
          );
        }
        if (pecasDaEncomenda?.length && !pecasDaEncomenda.includes(proCodigo)) {
          throw new BadRequestException(
            `Peça cotada ${i + 1}: o produto ${proCodigo} não está entre as peças da encomenda.`,
          );
        }
      }

      const { for_codigo, fornecedor } = await this.fornecedorDoItemCotado(
        item,
        i,
        fornecedores,
        exigirFornecedor,
      );

      saida.push({
        nome,
        valor,
        prazo: toStringOrNull(item.prazo),
        fornecedor,
        for_codigo,
        pro_codigo: proCodigo,
        marca: toStringOrNull(item.marca),
        transpostadora: toStringOrNull(item.transpostadora),
        custo: this.numeroOpcional(item.custo, 'custo', i),
        margem: this.numeroOpcional(item.margem, 'margem', i),
        frete: this.numeroOpcional(item.frete, 'frete', i),
        imposto: this.numeroOpcional(item.imposto, 'imposto', i),
        autorizado: toBooleanOrNull(item.autorizado),
      });
    }
    return saida;
  }

  async addPecasCotadas(
    id: number,
    dto: AddPecasCotadasDto,
  ): Promise<{
    created: ven_encomenda_pecas_itens_cotados[];
    venda: VendaCasadaComItens;
  }> {
    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }

    const itens = await this.normalizarPecasCotadas(
      dto.itens,
      venda.pecas.map((p) => p.pro_codigo),
    );
    if (itens.length === 0) {
      throw new BadRequestException('Informe ao menos um item em "itens".');
    }

    return this.repository.addPecasCotadas(id, itens);
  }

  async updateStatus(id: number, dto: UpdateStatusDto): Promise<VendaCasadaComUrls> {
    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }

    const status = toStringOrNull(dto.status?.trim());
    if (status === null) {
      throw new BadRequestException('Informe o "status".');
    }

    // O motivo só faz sentido no cancelamento; em qualquer outro status ele é limpo.
    const cancelado = status.toLowerCase() === STATUS_CANCELADO.toLowerCase();
    const motivo = toStringOrNull(dto.motivo?.trim());
    if (cancelado && motivo === null) {
      throw new BadRequestException('Informe o "motivo" do cancelamento.');
    }

    // Opcional: ausente mantém o que já está gravado; string vazia limpa.
    const motivoDenaoCotar =
      dto.motivoDenaoCotar === undefined
        ? undefined
        : toStringOrNull(String(dto.motivoDenaoCotar ?? '').trim());

    // Hora de entrada na etapa; repetir o mesmo status não reinicia o relógio
    const statusAnterior = (venda.status ?? '').trim().toLowerCase();
    const coluna = ETAPA_COLUNA[status.toLowerCase()];
    const mudouDeEtapa = statusAnterior !== status.toLowerCase();

    // Entrar em "Comprado" gera o pedido de compra no compras-service (um por
    // fornecedor dos itens selecionados) ANTES de mudar o status: se o pedido não
    // sair, a encomenda não fica marcada como comprada sem pedido.
    let pedidoCompras: number | undefined;
    if (mudouDeEtapa && status.toLowerCase() === STATUS_COMPRADO.toLowerCase()) {
      const itens = montarItensPedidoCompras(venda.pecas, venda.pecas_cotadas);
      const criado = await this.comprasApi.criarPedidoEncomenda({
        encomenda_id: id,
        usuario: toStringOrNull(dto.usuario?.trim()) ?? venda.nome_vendedor ?? null,
        itens,
      });
      pedidoCompras = criado.numero;
    }

    // Prazo explícito continua aceito (ausente mantém; vazio/null limpa). Sem ele,
    // o servidor aplica o prazo padrão nas transições que o reiniciam.
    const prazo =
      dto.prazo !== undefined
        ? toDateOnlyOrNull(dto.prazo, 'prazo')
        : ORIGENS_QUE_DEFINEM_PRAZO.includes(statusAnterior) &&
            DESTINOS_QUE_DEFINEM_PRAZO.includes(status.toLowerCase())
          ? prazoPadrao()
          : undefined;

    await this.repository.updateStatus(id, {
      status,
      motivoCancelamento: cancelado ? motivo : null,
      motivoDenaoCotar,
      prazo,
      pedido_compras: pedidoCompras,
      ...(coluna && mudouDeEtapa ? { [coluna]: agoraCuiaba() } : {}),
    });
    return this.findById(id);
  }

  /** Grava a NF-e da encomenda; vazio ou null limpa a coluna. */
  async updateNfe(id: number, dto: UpdateNfeDto): Promise<VendaCasadaComUrls> {
    if (!dto || dto.nfe === undefined) {
      throw new BadRequestException('Informe o campo "nfe".');
    }
    if (dto.nfe !== null && typeof dto.nfe !== 'string') {
      throw new BadRequestException('"nfe" deve ser uma string.');
    }

    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }

    await this.repository.updateNfe(id, toStringOrNull(dto.nfe?.trim()));
    return this.findById(id);
  }

  /**
   * Edita um item cotado. Só vale enquanto a encomenda está "Em cotação": depois
   * disso o vendedor já está escolhendo em cima desses valores.
   */
  async updateItemCotado(
    id: number,
    dto: VendaCasadaItemDto,
  ): Promise<ven_encomenda_pecas_itens_cotados> {
    const item = await this.repository.findItemCotadoById(id);
    if (!item) {
      throw new NotFoundException(`Item cotado com id ${id} não encontrado`);
    }

    const encomenda = item.encomenda_pecas_id
      ? await this.repository.findById(item.encomenda_pecas_id)
      : null;
    if (encomenda?.status !== STATUS_EM_COTACAO) {
      throw new BadRequestException(
        `Itens cotados só podem ser editados com a encomenda em "${STATUS_EM_COTACAO}".`,
      );
    }

    const [normalizado] = await this.normalizarPecasCotadas(
      [dto],
      encomenda.pecas.map((p) => p.pro_codigo),
      { exigirFornecedor: false },
    );
    // Campos que não vieram mantêm o valor gravado (o Prisma ignora undefined);
    // `autorizado` é da escolha do vendedor e não muda por aqui.
    const opcional = <T>(campo: keyof VendaCasadaItemDto, valor: T): T | undefined =>
      dto[campo] === undefined ? undefined : valor;
    // Código e nome do fornecedor andam juntos: qualquer um dos dois na requisição
    // regrava os dois (o nome sempre vem do ERP quando há código).
    const mudouFornecedor = dto.for_codigo !== undefined || dto.fornecedor !== undefined;

    return this.repository.updateItemCotado(id, {
      nome: normalizado.nome,
      valor: normalizado.valor,
      prazo: opcional('prazo', normalizado.prazo),
      fornecedor: mudouFornecedor ? normalizado.fornecedor : undefined,
      for_codigo: mudouFornecedor ? normalizado.for_codigo : undefined,
      pro_codigo: opcional('pro_codigo', normalizado.pro_codigo),
      marca: opcional('marca', normalizado.marca),
      transpostadora: opcional('transpostadora', normalizado.transpostadora),
      custo: opcional('custo', normalizado.custo),
      margem: opcional('margem', normalizado.margem),
      frete: opcional('frete', normalizado.frete),
      imposto: opcional('imposto', normalizado.imposto),
    });
  }

  /**
   * Troca o fornecedor de um item cotado que ainda está como TEXTO (cotação antiga, sem
   * `for_codigo`) pelo código do Celta, para o item poder ir ao pedido de compra. Vale em
   * qualquer etapa até "Liberado para comprar". Item que já tem código é editado pelo
   * fluxo normal (PUT item_cotado/:id, só em "Em cotação").
   */
  async updateItemCotadoFornecedor(
    id: number,
    dto: UpdateItemCotadoFornecedorDto,
  ): Promise<ven_encomenda_pecas_itens_cotados> {
    const item = await this.repository.findItemCotadoById(id);
    if (!item) {
      throw new NotFoundException(`Item cotado com id ${id} não encontrado`);
    }
    if (item.for_codigo != null) {
      throw new BadRequestException(
        `O item já tem fornecedor com código (${item.for_codigo}); para trocar, edite o item com a encomenda em "${STATUS_EM_COTACAO}".`,
      );
    }

    const encomenda = item.encomenda_pecas_id
      ? await this.repository.findById(item.encomenda_pecas_id)
      : null;
    const status = (encomenda?.status ?? '').trim().toLowerCase();
    if (!STATUS_ATE_LIBERADO.includes(status)) {
      throw new BadRequestException(
        'O fornecedor só pode ser trocado até a encomenda estar em "Liberado para comprar".',
      );
    }

    const { for_codigo, fornecedor } = await this.fornecedorDoItemCotado(
      { for_codigo: dto?.for_codigo },
      0,
      new Map(),
      true,
    );
    return this.repository.updateItemCotado(id, { for_codigo, fornecedor });
  }

  /** Exclui um item cotado. Como a edição, só com a encomenda em "Em cotação". */
  async deleteItemCotado(id: number): Promise<{ ok: true; id: number }> {
    const item = await this.repository.findItemCotadoById(id);
    if (!item) {
      throw new NotFoundException(`Item cotado com id ${id} não encontrado`);
    }
    const encomenda = item.encomenda_pecas_id
      ? await this.repository.findById(item.encomenda_pecas_id)
      : null;
    if (encomenda?.status !== STATUS_EM_COTACAO) {
      throw new BadRequestException(
        `Itens cotados só podem ser excluídos com a encomenda em "${STATUS_EM_COTACAO}".`,
      );
    }
    await this.repository.deleteItemCotado(id);
    return { ok: true, id };
  }

  async updateItemCotadoAutorizado(
    id: number,
    dto: UpdateItemCotadoDto,
  ): Promise<ven_encomenda_pecas_itens_cotados> {
    const item = await this.repository.findItemCotadoById(id);
    if (!item) {
      throw new NotFoundException(`Item cotado com id ${id} não encontrado`);
    }
    return this.repository.updateItemCotadoAutorizado(id, dto.autorizado);
  }

  /**
   * Sobe todos os anexos (imagem, pdf, vídeo, áudio) de uma encomenda para o MinIO, no
   * bucket configurado em S3_BUCKET_AVARIAS. Não há restrição de mimetype: aceita
   * qualquer tipo de arquivo enviado no campo `anexos`.
   */
  async enviarAnexos(id: number, files: UploadedFileData[]): Promise<AnexoEnviado[]> {
    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }

    if (!files || files.length === 0) {
      throw new BadRequestException('Envie ao menos um anexo no campo "anexos".');
    }

    return this.subirAnexos(id, files, ANEXO_TIPO_COMPROVANTE);
  }

  /**
   * Sobe os arquivos para o bucket de anexos e grava as chaves em
   * ven_encomenda_pecas_anexos com o tipo informado.
   */
  private async subirAnexos(
    id: number,
    files: UploadedFileData[],
    tipo: AnexoTipo,
  ): Promise<AnexoEnviado[]> {
    const enviados: AnexoEnviado[] = [];
    for (const file of files) {
      const key = `${id}/${Date.now()}_${file.originalname}`;
      await this.s3.putObject(key, file.buffer, file.mimetype, this.ANEXOS_BUCKET);
      const url = await this.s3.getPresignedGetUrl(key, undefined, this.ANEXOS_BUCKET);
      enviados.push({
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        key,
        url,
        tipo,
      });
    }

    await this.repository.addAnexos(
      id,
      enviados.map((anexo) => anexo.key),
      tipo,
    );

    return enviados;
  }

  /** Produto do ERP por código, já recortado nos campos usados na encomenda. */
  async buscarProduto(proCodigo: number, empresa?: number): Promise<ProdutoEncomenda> {
    const produto = await this.erpRepository.produtoPorCodigo(proCodigo, empresa);
    if (!produto) {
      throw new NotFoundException(
        `Produto ${proCodigo} não encontrado no ERP`,
      );
    }
    return produto;
  }

  /** Fornecedor do Celta por código (FOR_CODIGO, FOR_NOME, NOME_FANTASIA), para a tela do item cotado. */
  async buscarFornecedor(forCodigo: number, empresa?: number): Promise<FornecedorEncomenda> {
    const fornecedor = await this.erpRepository.fornecedorPorCodigo(forCodigo, empresa);
    if (!fornecedor) {
      throw new NotFoundException(`Fornecedor ${forCodigo} não encontrado no ERP`);
    }
    return fornecedor;
  }

  /** Cliente do ERP por código, só com nome e contato. */
  async buscarCliente(cliCodigo: number, empresa?: number): Promise<ClienteEncomenda> {
    const cliente = await this.erpRepository.clientePorCodigo(cliCodigo, empresa);
    if (!cliente) {
      throw new NotFoundException(
        `Cliente ${cliCodigo} não encontrado no ERP`,
      );
    }
    return cliente;
  }
}
