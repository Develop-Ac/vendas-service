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
} from './encomenda-pecas.erp.repository';

/** Sentinela usado quando a peça não tem código de produto no ERP. */
const PRO_CODIGO_SEM_ERP = 99999;

/** Status que exige `motivo` (gravado em motivoCancelamento). */
const STATUS_CANCELADO = 'Cancelado';

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
};

@Injectable()
export class EncomendaPecasService {
  private readonly BUCKET = 'venda-casada';
  private readonly ANEXOS_BUCKET = process.env.S3_BUCKET_AVARIAS || 'encomenda-pecas';

  constructor(
    private readonly repository: EncomendaPecasRepository,
    private readonly s3: S3Service,
    private readonly erpRepository: EncomendaPecasErpRepository,
  ) {}

  async findAll(): Promise<VendaCasadaComUrls[]> {
    const vendas = await this.repository.findAll();
    return Promise.all(vendas.map((venda) => this.comUrlDeAnexos(venda)));
  }

  async findById(id: number): Promise<VendaCasadaComUrls> {
    const record = await this.repository.findById(id);
    if (!record) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }
    return this.comUrlDeAnexos(record);
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
    const itens = this.normalizarPecas(dto.pecas);
    if (itens.length === 0) {
      throw new BadRequestException('Informe ao menos uma peça em "pecas".');
    }
    const ano = this.anoObrigatorio(dto.ano);
    const cliente = await this.clienteObrigatorio(dto.cli_codigo);
    const itensCotados = this.normalizarPecasCotadas(dto.pecas_cotadas);
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
   * Aceita `pecas` como array de objetos (JSON) ou como string/array de strings
   * com JSON dentro — que é como o multipart entrega campos repetidos.
   */
  private normalizarPecas(pecas: unknown): CreateItemEncomendadoInput[] {
    const bruto: unknown[] = Array.isArray(pecas)
      ? pecas
      : pecas === null || pecas === undefined
        ? []
        : [pecas];

    const itens: CreateItemEncomendadoInput[] = [];

    for (const entrada of bruto) {
      let item: unknown = entrada;

      if (typeof item === 'string') {
        try {
          item = JSON.parse(item);
        } catch {
          throw new BadRequestException(
            `Peça inválida: "${entrada}". Envie um objeto com peca, pro_codigo, referencia e quantidade.`,
          );
        }
      }

      if (Array.isArray(item)) {
        itens.push(...this.normalizarPecas(item));
        continue;
      }

      if (!item || typeof item !== 'object') {
        throw new BadRequestException('Cada item de "pecas" deve ser um objeto.');
      }

      const peca = item as Partial<EncomendaPecaItemDto>;

      // Sem código de produto no ERP (peça avulsa/genérica): usa o sentinela 99999.
      const proCodigo = toNumberOrNull(peca.pro_codigo) ?? PRO_CODIGO_SEM_ERP;

      const descricao = toStringOrNull(peca.peca);
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

      itens.push({
        pro_codigo: proCodigo,
        pro_descricao: descricao,
        referencia: toStringOrNull(peca.referencia),
        quantidade,
      });
    }

    return itens;
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

  /** `pecas_cotadas` é opcional na criação: ausente ou vazia não cria nada. */
  private normalizarPecasCotadas(pecasCotadas: unknown): CreateVendaCasadaItemInput[] {
    return achatarListaJson(pecasCotadas, 'pecas_cotadas').map((entrada, i) => {
      const item = entrada as Partial<VendaCasadaItemDto>;

      const nome = toStringOrNull(item.nome);
      if (nome === null) {
        throw new BadRequestException(`Peça cotada ${i + 1}: o campo "nome" é obrigatório.`);
      }

      const valor = toNumberOrNull(item.valor);
      if (valor === null) {
        throw new BadRequestException(`Peça cotada ${i + 1}: "valor" deve ser um número.`);
      }

      return {
        nome,
        valor,
        prazo: toStringOrNull(item.prazo),
        fornecedor: toStringOrNull(item.fornecedor),
        marca: toStringOrNull(item.marca),
        transpostadora: toStringOrNull(item.transpostadora),
        custo: this.numeroOpcional(item.custo, 'custo', i),
        margem: this.numeroOpcional(item.margem, 'margem', i),
        frete: this.numeroOpcional(item.frete, 'frete', i),
        imposto: this.numeroOpcional(item.imposto, 'imposto', i),
        autorizado: toBooleanOrNull(item.autorizado),
      };
    });
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

    const lista = Array.isArray(dto.itens) ? dto.itens : [dto.itens];

    const itens = lista.map((item, i) => ({
      nome: item.nome,
      valor: Number(item.valor),
      prazo: item.prazo ?? null,
      fornecedor: item.fornecedor ?? null,
      marca: item.marca ?? null,
      transpostadora: item.transpostadora ?? null,
      custo: this.numeroOpcional(item.custo, 'custo', i),
      margem: this.numeroOpcional(item.margem, 'margem', i),
      frete: this.numeroOpcional(item.frete, 'frete', i),
      imposto: this.numeroOpcional(item.imposto, 'imposto', i),
      autorizado: item.autorizado ?? null,
    }));

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

    const [normalizado] = this.normalizarPecasCotadas([dto]);
    // Campos que não vieram mantêm o valor gravado (o Prisma ignora undefined);
    // `autorizado` é da escolha do vendedor e não muda por aqui.
    const opcional = <T>(campo: keyof VendaCasadaItemDto, valor: T): T | undefined =>
      dto[campo] === undefined ? undefined : valor;

    return this.repository.updateItemCotado(id, {
      nome: normalizado.nome,
      valor: normalizado.valor,
      prazo: opcional('prazo', normalizado.prazo),
      fornecedor: opcional('fornecedor', normalizado.fornecedor),
      marca: opcional('marca', normalizado.marca),
      transpostadora: opcional('transpostadora', normalizado.transpostadora),
      custo: opcional('custo', normalizado.custo),
      margem: opcional('margem', normalizado.margem),
      frete: opcional('frete', normalizado.frete),
      imposto: opcional('imposto', normalizado.imposto),
    });
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
