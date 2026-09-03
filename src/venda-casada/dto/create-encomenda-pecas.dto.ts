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
  IsString as IsStringValidator,
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

  @ApiProperty({
    description: 'Lista de peças',
    required: true,
    type: [String],
    example: ['Porta dianteira esquerda', 'Retrovisor direito'],
  })
  @IsDefined()
  @IsArray()
  @ArrayNotEmpty()
  @IsStringValidator({ each: true })
  pecas!: string[];

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
