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
      status: 'Em aberto',
    });
  }
}
