import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

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

  @ApiProperty({ description: 'Peça', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  peca?: string;

  @ApiProperty({ description: 'Lado', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lado?: string;

  @ApiProperty({ description: 'Ano', required: false })
  @IsOptional()
  @IsInt()
  ano?: number;

  @ApiProperty({ description: 'Observação', required: false })
  @IsOptional()
  @IsString()
  observacao?: string;

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
