import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ItemOrcamentoDto {
  @ApiProperty({ example: 49464 })
  @IsInt()
  pro_codigo: number;

  @ApiProperty({ example: 2 })
  @IsNumber()
  @Min(0.001)
  quantidade: number;

  @ApiProperty({ description: 'Só para item SEM preço na tabela do cliente. Com tabela, o preço é sempre tabela × (1 − desc_pct).', required: false })
  @IsOptional()
  @IsNumber()
  preco_unit?: number;

  @ApiProperty({ description: 'Desconto em fração (0.03 = 3%) sobre o preço de tabela do cliente.', required: false })
  @IsOptional()
  @IsNumber()
  desc_pct?: number;

  @ApiProperty({ description: 'Código do item SEM saldo que este substitui (equivalente).', required: false })
  @IsOptional()
  @IsInt()
  substituto_de?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  observacao?: string;
}

export class SalvarOrcamentoDto {
  @ApiProperty({ example: 1462 })
  @IsInt()
  cli_codigo: number;

  @ApiProperty({ description: 'Vendedor (REP_CODIGO). Vem do usuário logado (vendas_rep_codigo).' })
  @IsInt()
  rep_codigo: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  rep_nome?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observacao?: string;

  @ApiProperty({ description: 'YYYY-MM-DD. Ausente = hoje + ORCAMENTO_VALIDADE_DIAS.', required: false })
  @IsOptional()
  @IsString()
  validade?: string;

  @ApiProperty({ type: [ItemOrcamentoDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemOrcamentoDto)
  itens: ItemOrcamentoDto[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_nome?: string;
}

export class AcaoOrcamentoDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_nome?: string;
}

export const MOTIVOS_PERDA = [
  'PRECO',
  'PRAZO_FRETE',
  'SEM_ESTOQUE',
  'CONCORRENTE',
  'CLIENTE_ADIOU',
  'CREDITO_BLOQUEADO',
] as const;

export class DesfechoOrcamentoDto extends AcaoOrcamentoDto {
  @ApiProperty({ enum: ['FECHADO', 'PERDIDO'] })
  @IsIn(['FECHADO', 'PERDIDO'])
  resultado: 'FECHADO' | 'PERDIDO';

  @ApiProperty({ enum: MOTIVOS_PERDA, required: false, description: 'Obrigatório quando PERDIDO.' })
  @IsOptional()
  @IsIn(MOTIVOS_PERDA as unknown as string[])
  motivo?: string;

  @ApiProperty({ required: false, description: 'FECHADO: nº do pedido/NF/orçamento no Celta.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referencia?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  observacao?: string;
}

export class ExcecaoReguaDto {
  @ApiProperty({ enum: ['EXCLUSIVO', 'OPORTUNIDADE'] })
  @IsIn(['EXCLUSIVO', 'OPORTUNIDADE'])
  classe: 'EXCLUSIVO' | 'OPORTUNIDADE';

  @ApiProperty({ required: false, description: 'Fração; nulo = desc. máx. da faixa.' })
  @IsOptional()
  @IsNumber()
  desc_max?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  motivo?: string;

  @ApiProperty({ required: false, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  vigente_ate?: string | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  criado_por?: string;

  @ApiProperty({ required: false, description: 'true remove a exceção (item volta à régua).' })
  @IsOptional()
  @IsBoolean()
  remover?: boolean;
}
