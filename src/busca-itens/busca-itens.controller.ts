import { Body, Controller, Param, Post, Put } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BuscaItensService } from './busca-itens.service';

class BuscaItensDto {
  @ApiProperty({
    description: 'Placa do veículo para consulta (use junto com "produto")',
    example: 'ABC1234',
    required: false,
  })
  placa?: string;

  @ApiProperty({
    description: 'Descrição do produto a buscar (use junto com "placa")',
    example: 'filtro de ar',
    required: false,
  })
  produto?: string;

  @ApiProperty({
    description: 'Código do produto para busca direta (substitui placa + produto)',
    example: '35953',
    required: false,
  })
  codigo?: string;
}

class BuscaItemResultDto {
  @ApiProperty({ example: '35953' }) pro_codigo: string;
  @ApiProperty({ example: 'FILTRO DE AR MOTOR' }) pro_descricao: string;
  @ApiProperty({ example: '' }) referencia: string;
  @ApiProperty({ example: null, nullable: true }) carro_1: string | null;
  @ApiProperty({ example: null, nullable: true }) ano_1: string | null;
}

class UpdateProdutoCarroDto {
  @ApiProperty({ example: 'Volkswagen Gol', nullable: true, required: false }) carro_1?: string | null;
  @ApiProperty({ example: 'Volkswagen Voyage', nullable: true, required: false }) carro_2?: string | null;
  @ApiProperty({ example: 'Volkswagen Parati', nullable: true, required: false }) carro_3?: string | null;
  @ApiProperty({ example: 'Volkswagen Saveiro', nullable: true, required: false }) carro_4?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_5?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_6?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_7?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_8?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_9?: string | null;
  @ApiProperty({ nullable: true, required: false }) carro_10?: string | null;

  @ApiProperty({ example: '1980, 1981, 1982', nullable: true, required: false }) ano_1?: string | null;
  @ApiProperty({ example: '1980, 1981, 1982', nullable: true, required: false }) ano_2?: string | null;
  @ApiProperty({ example: '1980, 1981, 1982', nullable: true, required: false }) ano_3?: string | null;
  @ApiProperty({ example: '1980, 1981, 1982', nullable: true, required: false }) ano_4?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_5?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_6?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_7?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_8?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_9?: string | null;
  @ApiProperty({ nullable: true, required: false }) ano_10?: string | null;
}

@ApiTags('Vendas')
@Controller('vendas/busca-itens')
export class BuscaItensController {
  constructor(private readonly buscaItensService: BuscaItensService) {}

  @Post()
  @ApiOperation({
    summary: 'Buscar itens por placa/produto ou código',
    description: `Busca produtos no catálogo de duas formas:

                **Por placa + produto:** Consulta a API de placas para obter o modelo e ano do veículo, depois pesquisa o produto compatível.

                **Por código:** Pesquisa diretamente pelo código do produto.`,
  })
  @ApiBody({
    type: BuscaItensDto,
    examples: {
      porPlaca: {
        summary: 'Busca por placa + produto',
        value: { placa: 'ABC1234', produto: 'filtro de ar' },
      },
      porCodigo: {
        summary: 'Busca por código',
        value: { codigo: '35953' },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de produtos encontrados',
    type: [BuscaItemResultDto],
  })
  @ApiResponse({
    status: 400,
    description: 'Parâmetros inválidos — informe (placa + produto) ou codigo',
  })
  async buscarItens(@Body() body: BuscaItensDto) {
    return this.buscaItensService.buscarItens(body);
  }

  @Put(':pro_codigo')
  @ApiOperation({
    summary: 'Atualizar carros e anos de um produto',
    description: 'Atualiza as colunas carro_1..10 e ano_1..10 na tabela eco_produtos_carros e define o status como "Verificado".',
  })
  @ApiBody({ type: UpdateProdutoCarroDto })
  @ApiResponse({ status: 200, description: 'Registro atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Produto não encontrado' })
  async updateProdutoCarro(
    @Param('pro_codigo') proCodigo: string,
    @Body() body: UpdateProdutoCarroDto,
  ) {
    return this.buscaItensService.updateProdutoCarro(proCodigo, body);
  }
}
