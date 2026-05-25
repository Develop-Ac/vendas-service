import { Injectable, NotFoundException } from '@nestjs/common';
import { VendaCasadaRepository } from './venda-casada.repository';
import { S3Service } from '../storage/s3.service';
import { CreateVendaCasadaDto } from './dto/create-venda-casada.dto';
import { ven_venda_casada } from '@prisma/client';

@Injectable()
export class VendaCasadaService {
  private readonly BUCKET = 'venda-casada';

  constructor(
    private readonly repository: VendaCasadaRepository,
    private readonly s3: S3Service,
  ) {}

  async findAll(): Promise<ven_venda_casada[]> {
    return this.repository.findAll();
  }

  async findById(id: number): Promise<ven_venda_casada> {
    const record = await this.repository.findById(id);
    if (!record) {
      throw new NotFoundException(`Venda casada com id ${id} não encontrada`);
    }
    return record;
  }

  async create(
    dto: CreateVendaCasadaDto,
    file?: Express.Multer.File,
  ): Promise<ven_venda_casada> {
    let imagemKey: string | null = null;

    if (file) {
      const ext = file.originalname.split('.').pop();
      const timestamp = Date.now();
      imagemKey = `venda-casada/${timestamp}_${file.originalname}`;
      await this.s3.putObject(imagemKey, file.buffer, file.mimetype, this.BUCKET);
    }

    return this.repository.create({
      ...dto,
      nome_vendedor: dto.nome_vendedor ?? null,
      carro: dto.carro ?? null,
      peca: dto.peca ?? null,
      lado: dto.lado ?? null,
      ano: dto.ano ?? null,
      observacao: dto.observacao ?? null,
      cliente: dto.cliente ?? null,
      numero: dto.numero ?? null,
      imagem: imagemKey,
      status: 'Em aberto',
    });
  }
}
