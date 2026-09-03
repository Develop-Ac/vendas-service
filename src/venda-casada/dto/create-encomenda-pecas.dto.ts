import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  IsArray,
  ArrayNotEmpty,
  IsDefined,
  IsNotEmpty,
  IsPositive,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EncomendaPecaItemDto {
  @ApiProperty({ description: 'Descrição da peça', example: 'LAN T GOL /86 LE FUME' })
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  peca!: string;

  @ApiProperty({
    description: 'Código do produto no ERP. Se não informado, o backend usa 99999.',
    required: false,
    example: 2321,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  pro_codigo?: number;

  @ApiProperty({ description: 'Referência do produto', required: false, example: '2204' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referencia?: string;

  @ApiProperty({ description: 'Quantidade encomendada', example: 12, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  quantidade?: number;
}

export class CreateVendaCasadaDto {
  @ApiProperty({ description: 'Nome do vendedor', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  nome_vendedor?: string;

  @ApiProperty({ description: 'Carro', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  carro?: string;

  @ApiProperty({
    description: 'Lista de peças encomendadas',
    required: true,
    type: [EncomendaPecaItemDto],
  })
  @IsDefined()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => EncomendaPecaItemDto)
  pecas!: EncomendaPecaItemDto[];

  @ApiProperty({ description: 'Ano', required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  ano?: number;

  @ApiProperty({ description: 'Observação', required: false })
  @IsOptional()
  @IsString()
  observacao?: string;

  @ApiProperty({ description: 'Código do cliente no ERP', required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cli_codigo?: number;

  @ApiProperty({ description: 'Cliente', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  cliente?: string;

  @ApiProperty({ description: 'Número', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  numero?: string;
}
