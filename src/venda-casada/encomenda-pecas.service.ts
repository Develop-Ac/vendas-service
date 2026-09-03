import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EncomendaPecasRepository,
  VendaCasadaComItens,
} from './encomenda-pecas.repository';
import { S3Service } from '../storage/s3.service';
import { CreateVendaCasadaDto } from './dto/create-encomenda-pecas.dto';
import { AddPecasCotadasDto } from './dto/add-pecas-cotadas.dto';
import { UploadedFileData } from '../common/types/uploaded-file';
import { ven_encomenda_pecas, ven_encomenda_pecas_itens } from '@prisma/client';
import {
  EncomendaPecasErpRepository,
  ProdutoEncomenda,
  ClienteEncomenda,
} from './encomenda-pecas.erp.repository';

@Injectable()
export class EncomendaPecasService {
  private readonly BUCKET = 'venda-casada';

  constructor(
    private readonly repository: EncomendaPecasRepository,
    private readonly s3: S3Service,
    private readonly erpRepository: EncomendaPecasErpRepository,
  ) {}

  async findAll(): Promise<ven_encomenda_pecas[]> {
    return this.repository.findAll();
  }

  async findById(id: number): Promise<VendaCasadaComItens> {
    const record = await this.repository.findById(id);
    if (!record) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }
    return record;
  }

  async create(
    dto: CreateVendaCasadaDto,
    file?: UploadedFileData,
  ): Promise<ven_encomenda_pecas> {
    let imagemKey: string | null = null;

    if (file) {
      const ext = file.originalname.split('.').pop();
      const timestamp = Date.now();
      imagemKey = `${timestamp}_${file.originalname}`;
      await this.s3.putObject(imagemKey, file.buffer, file.mimetype, this.BUCKET);
    }

    // Garante que pecas seja sempre array de string
    let pecas: string[];
    if (Array.isArray(dto.pecas)) {
      pecas = dto.pecas;
    } else if (typeof dto.pecas === 'string') {
      try {
        const parsed = JSON.parse(dto.pecas);
        pecas = Array.isArray(parsed) ? parsed : [dto.pecas];
      } catch {
        pecas = [dto.pecas];
      }
    } else {
      pecas = [];
    }

    return this.repository.create({
      nome_vendedor: dto.nome_vendedor ?? null,
      carro: dto.carro ?? null,
      ano: Number(dto.ano) ?? null,
      observacao: dto.observacao ?? null,
      cliente: dto.cliente ?? null,
      numero: dto.numero ?? null,
      imagem: imagemKey,
      pecas: pecas,
      pecas_cotadas: [],
      status: 'Em aberto',
    });
  }

  async addPecasCotadas(
    id: number,
    dto: AddPecasCotadasDto,
  ): Promise<{ created: ven_encomenda_pecas_itens[]; venda: ven_encomenda_pecas }> {
    const venda = await this.repository.findById(id);
    if (!venda) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }

    const lista = Array.isArray(dto.itens) ? dto.itens : [dto.itens];

    const itens = lista.map((item) => ({
      nome: item.nome,
      valor: item.valor,
      prazo: item.prazo ?? null,
      fornecedor: item.fornecedor ?? null,
      marca: item.marca ?? null,
    }));

    return this.repository.addPecasCotadas(id, itens); 
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
