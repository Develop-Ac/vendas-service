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

  @ApiProperty({ description: 'Unitário fechado pelo vendedor (veio do total da linha digitado) — vale quando 0 < preco_unit ≤ tabela; senão o preço é tabela × (1 − desc_pct). Obrigatório para item SEM preço na tabela.', required: false })
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

  @ApiProperty({ description: 'Parte da quantidade SEM saldo que o cliente aceitou receber depois (encomenda).', required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  qtd_encomenda?: number;

  @ApiProperty({ description: 'Vender pela tabela normal do cliente mesmo com promoção/liquidação vigente: a campanha não vale na linha e entram a régua e a bolsa padrão.', required: false })
  @IsOptional()
  @IsBoolean()
  fora_promocao?: boolean;
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

  @ApiProperty({ description: 'IGNORADO: a validade é sempre hoje + ORCAMENTO_VALIDADE_DIAS, encolhida para a promoção mais próxima de vencer.', required: false })
  @IsOptional()
  @IsString()
  validade?: string;

  @ApiProperty({ description: 'Condição de pagamento (CONDICOES_PAGTO.CP_CODIGO). Opcional no rascunho, obrigatória para enviar.', required: false })
  @IsOptional()
  @IsInt()
  cp_codigo?: number;

  @ApiProperty({ description: 'Forma de pagamento (FORMAS_PAGTO.FP_CODIGO, até 3 caracteres) — vale para a entrada e as demais parcelas. Opcional no rascunho, obrigatória para enviar.', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  fp_codigo?: string;

  @ApiProperty({ type: [ItemOrcamentoDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemOrcamentoDto)
  itens: ItemOrcamentoDto[];

  @ApiProperty({ description: 'Venda presencial (cliente retira na loja). Só muda o imposto de cliente não contribuinte/isento de outro estado: presencial não gera DIFAL. Padrão: não presencial.', required: false })
  @IsOptional()
  @IsBoolean()
  presencial?: boolean;

  @ApiProperty({ description: 'Meia nota: metade do valor sai em produto e metade em serviço. ST e DIFAL estimados sobre metade de cada item; na importação ao Celta o imposto vai em Desp. Acessórias.', required: false })
  @IsOptional()
  @IsBoolean()
  meia_nota?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_id?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  usuario_nome?: string;
}

export class ItemTributacaoDto {
  @ApiProperty({ example: 49464 })
  @IsInt()
  pro_codigo: number;

  @ApiProperty({ description: 'Total líquido da linha (preço negociado × quantidade).' })
  @IsNumber()
  @Min(0)
  total: number;

  @ApiProperty({ description: 'Serviço (subtipo 09): fora do ICMS.', required: false })
  @IsOptional()
  @IsBoolean()
  servico?: boolean;
}

/** Prévia do imposto interestadual do orçamento em edição — a tela pergunta, o serviço calcula. */
export class TributacaoDto {
  @ApiProperty({ example: 1462 })
  @IsInt()
  cli_codigo: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  presencial?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  meia_nota?: boolean;

  @ApiProperty({ type: [ItemTributacaoDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ItemTributacaoDto)
  itens: ItemTributacaoDto[];
}

export class EntregueOrcamentoDto {
  @ApiProperty({ example: 'WHATSAPP', description: 'Canal por onde o cliente recebeu a proposta.' })
  @IsIn(['WHATSAPP', 'EMAIL', 'IMPRESSO'])
  canal!: 'WHATSAPP' | 'EMAIL' | 'IMPRESSO';
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

export const ACOES_SALDO = ['VENDA_PERDIDA', 'ENCOMENDA', 'RETIRAR'] as const;

export class DecisaoSaldoItemDto {
  @ApiProperty({ example: 49464 })
  @IsInt()
  pro_codigo: number;

  @ApiProperty({ enum: ACOES_SALDO, description: 'O que fazer com a parte SEM saldo do item.' })
  @IsIn(ACOES_SALDO as unknown as string[])
  acao: 'VENDA_PERDIDA' | 'ENCOMENDA' | 'RETIRAR';

  @ApiProperty({ required: false, description: 'Manter no orçamento a quantidade que existe hoje (padrão sim); a decisão vale só para a diferença.' })
  @IsOptional()
  @IsBoolean()
  manter_disponivel?: boolean;

  @ApiProperty({ required: false, description: 'Equivalente COM saldo que a tela encontrou (código · descrição · saldo). Com ele, VENDA_PERDIDA exige justificativa.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  similar_disponivel?: string;

  @ApiProperty({ required: false, description: 'Por que registrar venda perdida mesmo havendo similar com saldo.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  justificativa?: string;
}

export class DecisaoSaldoDto extends AcaoOrcamentoDto {
  @ApiProperty({ type: [DecisaoSaldoItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DecisaoSaldoItemDto)
  decisoes: DecisaoSaldoItemDto[];
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

/* ------------------------------------------------- compra de oportunidade */

export class ItemOportunidadeDto {
  @ApiProperty()
  @IsInt()
  pro_codigo: number;

  @ApiProperty({ description: 'Unidades do lote cobertas pela regra (nasce da quantidade da nota).' })
  @IsNumber()
  @Min(0)
  quantidade: number;

  @ApiProperty({ description: 'Fração da sobra que fica com o vendedor (0 a 1).' })
  @IsNumber()
  @Min(0)
  pct_vendedor: number;

  @ApiProperty({ required: false, description: 'Custo do item na nota (informação).' })
  @IsOptional()
  @IsNumber()
  custo_nota?: number | null;
}

export class RegistrarOportunidadeDto {
  @ApiProperty({ required: false, description: 'NF_ENTRADA.NFE (chave interna, empresa 1).' })
  @IsOptional()
  @IsInt()
  nfe?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  nota_fiscal?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  for_codigo?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  for_nome?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  criado_por?: string;

  @ApiProperty({ type: [ItemOportunidadeDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ItemOportunidadeDto)
  itens: ItemOportunidadeDto[];
}

export class AlterarOportunidadeDto {
  @ApiProperty({ required: false, description: 'Nova fração da sobra para o vendedor (0 a 1); recalcula o custo para a bolsa.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  pct_vendedor?: number;

  @ApiProperty({ required: false, description: 'Nova quantidade do lote.' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  quantidade?: number;

  @ApiProperty({ required: false, description: 'true encerra o registro hoje (vendas de hoje em diante voltam ao custo real).' })
  @IsOptional()
  @IsBoolean()
  encerrar?: boolean;
}
