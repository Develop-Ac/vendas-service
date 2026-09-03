import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CreateItemEncomendadoInput,
  EncomendaPecasRepository,
  VendaCasadaComItens,
} from './encomenda-pecas.repository';
import { S3Service } from '../storage/s3.service';
import {
  CreateVendaCasadaDto,
  EncomendaPecaItemDto,
} from './dto/create-encomenda-pecas.dto';
import { AddPecasCotadasDto } from './dto/add-pecas-cotadas.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateItemCotadoDto } from './dto/update-item-cotado.dto';
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

/** Em multipart os valores chegam como string; nos GETs/POST JSON já vêm tipados. */
function toNumberOrNull(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(valor: unknown): string | null {
  if (valor === null || valor === undefined || valor === '') return null;
  return String(valor);
}

export type AnexoEnviado = {
  originalname: string;
  mimetype: string;
  size: number;
  key: string;
  url: string;
};

export type AnexoComUrl = ven_encomenda_pecas_anexos & { url: string | null };

export type VendaCasadaComUrls = Omit<VendaCasadaComItens, 'anexos'> & {
  anexos: AnexoComUrl[];
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

  /** Troca a chave salva de cada anexo por uma URL pré-assinada de GET, pra exibir na tela. */
  private async comUrlDeAnexos(venda: VendaCasadaComItens): Promise<VendaCasadaComUrls> {
    const anexos = await Promise.all(
      venda.anexos.map(async (anexo) => ({
        ...anexo,
        url: await this.gerarUrlAnexo(anexo.anexo),
      })),
    );
    return { ...venda, anexos };
  }

  /** Se o objeto não existir mais no bucket, devolve null em vez de quebrar o GET. */
  private async gerarUrlAnexo(key: string): Promise<string | null> {
    try {
      return await this.s3.getPresignedGetUrl(key, undefined, this.ANEXOS_BUCKET);
    } catch {
      return null;
    }
  }

  async create(
    dto: CreateVendaCasadaDto,
    file?: UploadedFileData,
  ): Promise<VendaCasadaComItens> {
    const itens = this.normalizarPecas(dto.pecas);
    if (itens.length === 0) {
      throw new BadRequestException('Informe ao menos uma peça em "pecas".');
    }

    let imagemKey: string | null = null;

    if (file) {
      const timestamp = Date.now();
      imagemKey = `${timestamp}_${file.originalname}`;
      await this.s3.putObject(imagemKey, file.buffer, file.mimetype, this.BUCKET);
    }

    return this.repository.create(
      {
        nome_vendedor: dto.nome_vendedor ?? null,
        carro: dto.carro ?? null,
        ano: toNumberOrNull(dto.ano),
        observacao: dto.observacao ?? null,
        cliente: dto.cliente ?? null,
        numero: dto.numero ?? null,
        imagem: imagemKey,
        status: 'Aguardando cotação',
      },
      itens,
    );
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

    const itens = lista.map((item) => ({
      nome: item.nome,
      valor: Number(item.valor),
      prazo: item.prazo ?? null,
      fornecedor: item.fornecedor ?? null,
      marca: item.marca ?? null,
      transpostadora: item.transpostadora ?? null,
      autorizado: item.autorizado ?? null,
    }));

    return this.repository.addPecasCotadas(id, itens);
  }

  async updateStatus(id: number, dto: UpdateStatusDto): Promise<VendaCasadaComItens> {
    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }
    return this.repository.updateStatus(id, dto.status);
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
      });
    }

    await this.repository.addAnexos(
      id,
      enviados.map((anexo) => anexo.key),
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
