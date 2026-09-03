import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  ArrayNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VendaCasadaItemDto {
  @ApiProperty({ description: 'Nome da peça', example: 'Pastilha de freio' })
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nome: string;

  @ApiProperty({ description: 'Valor da peça', example: 199.9 })
  @IsDefined()
  @IsNumber()
  valor: number;

  @ApiProperty({ description: 'Prazo', required: false, example: '15 dias' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  prazo?: string;

  @ApiProperty({ description: 'Fornecedor', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fornecedor?: string;

  @ApiProperty({ description: 'Marca', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  marca?: string;

  @ApiProperty({
    description: 'Transportadora (coluna `transpostadora` no banco)',
    required: false,
  })
  @IsOptional()
  @IsString()
  transpostadora?: string;

  @ApiProperty({ description: 'Se o item cotado foi autorizado', required: false })
  @IsOptional()
  @IsBoolean()
  autorizado?: boolean;
}

export class AddPecasCotadasDto {
  @ApiProperty({
    description: 'Lista de peças cotadas',
    type: [VendaCasadaItemDto],
  })
  @IsDefined()
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => VendaCasadaItemDto)
  itens: VendaCasadaItemDto[];
}
