import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsInt,
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

  @ApiProperty({
    description:
      'Código do fornecedor no Celta (FOR_CODIGO), obrigatório ao cadastrar o item. Precisa ' +
      'existir no ERP: o nome é buscado na API e gravado em `fornecedor`. Na edição, se não ' +
      'vier (nem `fornecedor`), mantém o gravado.',
    required: false,
    example: 250,
  })
  @IsOptional()
  @IsInt()
  for_codigo?: number;

  @ApiProperty({
    description:
      'Nome do fornecedor. Preenchido pelo servidor a partir de `for_codigo`; se vier só um ' +
      'número aqui (sem `for_codigo`), é tratado como o código. Texto livre é recusado (400).',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fornecedor?: string;

  @ApiProperty({
    description:
      'Produto do Celta ao qual a cotação se refere: precisa ser uma das peças da encomenda. ' +
      'Opcional quando a encomenda tem uma peça só.',
    required: false,
    example: 2321,
  })
  @IsOptional()
  @IsInt()
  pro_codigo?: number;

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

  @ApiProperty({ description: 'Custo da peça', required: false, example: 120.5 })
  @IsOptional()
  @IsNumber()
  custo?: number;

  @ApiProperty({ description: 'Margem', required: false, example: 35 })
  @IsOptional()
  @IsNumber()
  margem?: number;

  @ApiProperty({ description: 'Frete', required: false, example: 25 })
  @IsOptional()
  @IsNumber()
  frete?: number;

  @ApiProperty({ description: 'Imposto', required: false, example: 18 })
  @IsOptional()
  @IsNumber()
  imposto?: number;

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
