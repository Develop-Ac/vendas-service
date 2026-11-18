import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min,ValidateNested } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Fonte da promoção do orçamento do atacado: true = só as ofertas da intranet; false = promoções do Celta. */
export class FonteOfertaDto {
  @ApiProperty({ example: false })
  @IsBoolean()
  intranet!: boolean;
}

/** Item a incluir: só o código (nasce com o mínimo de cada tabela) ou a linha da sugestão (preço da tabela 2 e quantidade a vender). */
export class ItemOfertaDto {
  @ApiProperty({ example: 49464 })
  @IsInt()
  pro_codigo!: number;

  @ApiProperty({ required: false, description: 'Preço proposto na tabela 2; a tabela 5 sai com o mesmo percentual de desconto.' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  preco_t2?: number;

  @ApiProperty({ required: false, description: 'Preço proposto na tabela 5; ausente = sugerido pelo desconto da tabela 2 (ou o mínimo).' })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  preco_t5?: number;

  @ApiProperty({ required: false, description: 'Quantidade a vender; vira o limite do item.' })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  qtd?: number;

  @ApiProperty({ required: false, enum: ['PROMOCAO', 'LIQUIDACAO'], description: 'Tipo do item; ausente = o do grupo. Grupo de campanha ignora (sempre CAMPANHA).' })
  @IsOptional()
  @IsIn(['PROMOCAO', 'LIQUIDACAO'])
  tipo?: 'PROMOCAO' | 'LIQUIDACAO';
}

/** Faixa do prêmio da campanha: a partir dessa quantidade total do vendedor, vale este valor (pct ou R$/un). */
export class FaixaPremioDto {
  @ApiProperty({ example: 50 })
  @IsNumber()
  a_partir_de!: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  valor!: number;
}

/** Nível adicional do preço progressivo: a partir dessa quantidade, o preço de cada tabela (null = sem preço nela). */
export class NivelOfertaDto {
  @ApiProperty({ example: 6 })
  @IsNumber()
  a_partir_de!: number;

  @ApiProperty({ required: false, nullable: true, example: 85 })
  @IsOptional()
  @IsNumber()
  preco_t2?: number | null;

  @ApiProperty({ required: false, nullable: true, example: 88 })
  @IsOptional()
  @IsNumber()
  preco_t5?: number | null;
}

export class CriarOfertaDto {
  @ApiProperty({ example: 'Liquidação palhetas novembro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;

  @ApiProperty({ enum: ['PROMOCAO', 'LIQUIDACAO', 'CAMPANHA'] })
  @IsIn(['PROMOCAO', 'LIQUIDACAO', 'CAMPANHA'])
  tipo!: 'PROMOCAO' | 'LIQUIDACAO' | 'CAMPANHA';

  @ApiProperty({ required: false, enum: ['EMPRESA', 'FORNECEDOR'], description: 'Só campanha.' })
  @IsOptional()
  @IsIn(['EMPRESA', 'FORNECEDOR'])
  origem?: 'EMPRESA' | 'FORNECEDOR';

  @ApiProperty({ required: false, description: 'Código do fornecedor no ERP; obrigatório na campanha de fornecedor.' })
  @IsOptional()
  @IsInt()
  fornecedor_codigo?: number;

  @ApiProperty({ required: false, enum: ['PCT_VENDA', 'VALOR_UNIDADE'], description: 'Só campanha.' })
  @IsOptional()
  @IsIn(['PCT_VENDA', 'VALOR_UNIDADE'])
  premio_tipo?: 'PCT_VENDA' | 'VALOR_UNIDADE';

  @ApiProperty({ required: false, description: 'Fração (0,02 = 2%) em PCT_VENDA; R$ por unidade em VALOR_UNIDADE.' })
  @IsOptional()
  @IsNumber()
  premio_valor?: number;

  @ApiProperty({ type: [FaixaPremioDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => FaixaPremioDto)
  premio_faixas?: FaixaPremioDto[];

  @ApiProperty({ type: [ItemOfertaDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemOfertaDto)
  itens?: ItemOfertaDto[];
}

/** Novo prêmio do grupo (liquidação ou campanha). Tipo ausente = mantém; faixas ausentes = mantém. */
export class AlterarPremioDto {
  @ApiProperty({ required: false, enum: ['PCT_CUSTO', 'PCT_VENDA', 'VALOR_UNIDADE'], description: 'Liquidação é sempre PCT_CUSTO.' })
  @IsOptional()
  @IsIn(['PCT_CUSTO', 'PCT_VENDA', 'VALOR_UNIDADE'])
  premio_tipo?: 'PCT_CUSTO' | 'PCT_VENDA' | 'VALOR_UNIDADE';

  @ApiProperty({ example: 0.08, description: 'Fração (0,08 = 8%) em PCT_CUSTO/PCT_VENDA; R$ por unidade em VALOR_UNIDADE.' })
  @IsNumber()
  premio_valor!: number;

  @ApiProperty({ type: [FaixaPremioDto], required: false, description: 'Só campanha.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => FaixaPremioDto)
  premio_faixas?: FaixaPremioDto[];
}

export class RenomearOfertaDto {
  @ApiProperty({ example: 'Promoção faróis dezembro' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nome!: string;
}

export class PreviaMarcaOfertaDto {
  @ApiProperty({ example: 'BOSCH' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  marca!: string;

  @ApiProperty({ example: 0.1, description: 'Desconto sobre as tabelas, em fração (0 < pct < 1).' })
  @IsNumber()
  @Min(0.0001)
  @Max(0.9999)
  pct!: number;
}

export class IncluirItensOfertaDto {
  @ApiProperty({ type: [ItemOfertaDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemOfertaDto)
  itens!: ItemOfertaDto[];
}

/** Campo ausente = não muda; null em preço = a oferta deixa de valer naquela tabela; null no limite = sem limite. */
export class AlterarItemOfertaDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  preco_t2?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  preco_t5?: number | null;

  @ApiProperty({ required: false, example: '2026-11-17' })
  @IsOptional()
  @Matches(YMD)
  inicio?: string;

  @ApiProperty({ required: false, example: '2026-12-16' })
  @IsOptional()
  @Matches(YMD)
  fim?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  limite_qtd?: number | null;

  @ApiProperty({ required: false, nullable: true, description: 'Máximo por cliente (soma dos orçamentos fechados do cliente); null = sem teto.' })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  limite_cliente?: number | null;

  @ApiProperty({ required: false, enum: ['PROMOCAO', 'LIQUIDACAO'], description: 'Fora do grupo de campanha; virar liquidação sem bônus = 5%.' })
  @IsOptional()
  @IsIn(['PROMOCAO', 'LIQUIDACAO'])
  tipo?: 'PROMOCAO' | 'LIQUIDACAO';

  @ApiProperty({ required: false, example: 0.05, description: 'Bônus da liquidação, fração do custo (0 = sem bônus); só item LIQUIDACAO.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.9999)
  premio_valor?: number;

  @ApiProperty({ required: false, example: 1, description: 'Quantidade do primeiro nível do preço progressivo (preço = o da tabela).' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  qtd_minima?: number;

  @ApiProperty({ type: [NivelOfertaDto], required: false, description: 'Até 2 níveis adicionais; [] remove.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => NivelOfertaDto)
  niveis?: NivelOfertaDto[];

  @ApiProperty({ required: false, nullable: true, description: 'Agarradinho: produto que precisa ir junto no orçamento; null remove o par.' })
  @IsOptional()
  @IsInt()
  par_pro_codigo?: number | null;

  @ApiProperty({ required: false, example: 1, description: 'Unidades da oferta liberadas por unidade do par (padrão 1).' })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  par_proporcao?: number;
}

export class ReplicarDatasOfertaDto {
  @ApiProperty({ description: 'Item de onde saem início e fim.' })
  @IsInt()
  item_id!: number;
}

export class ItensDoFluxoDto {
  @ApiProperty({ required: false, type: [Number], description: 'Itens do grupo; ausente ou vazio = o grupo todo.' })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  itens?: number[];
}
