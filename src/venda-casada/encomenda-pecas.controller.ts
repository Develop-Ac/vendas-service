import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  UploadedFile,
  UseInterceptors,
  Body,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyFileInterceptor } from '../common/interceptors/fastify-file.interceptor';
import type { UploadedFileData } from '../common/types/uploaded-file';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { EncomendaPecasService } from './encomenda-pecas.service';
import { CreateVendaCasadaDto } from './dto/create-encomenda-pecas.dto';
import { AddPecasCotadasDto } from './dto/add-pecas-cotadas.dto';

@ApiTags('Encomenda de Peças')
@Controller('encomenda-pecas')
export class EncomendaPecasController {
  constructor(
    private readonly service: EncomendaPecasService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista todas as vendas casadas' })
  @ApiResponse({ status: 200, description: 'Lista retornada com sucesso' })
  findAll() {
    return this.service.findAll();
  }

  @Get('produtos/:pro_codigo')
  @ApiOperation({
    summary: 'Busca um produto no ERP pelo código',
    description:
      'Consulta a erp-firebird-api e devolve apenas código, descrição e referências do produto.',
  })
  @ApiParam({ name: 'pro_codigo', type: Number, description: 'Código do produto no ERP' })
  @ApiQuery({
    name: 'empresa',
    type: Number,
    required: false,
    description: 'Empresa do ERP (padrão: 3)',
  })
  @ApiResponse({ status: 200, description: 'Produto encontrado' })
  @ApiResponse({ status: 404, description: 'Produto não encontrado no ERP' })
  buscarProduto(
    @Param('pro_codigo', ParseIntPipe) proCodigo: number,
    @Query('empresa', new ParseIntPipe({ optional: true })) empresa?: number,
  ) {
    return this.service.buscarProduto(proCodigo, empresa);
  }

  @Get('clientes/:cli_codigo')
  @ApiOperation({
    summary: 'Busca um cliente no ERP pelo código',
    description:
      'Consulta a erp-firebird-api e devolve apenas código, nome e contatos do cliente.',
  })
  @ApiParam({ name: 'cli_codigo', type: Number, description: 'Código do cliente no ERP' })
  @ApiQuery({
    name: 'empresa',
    type: Number,
    required: false,
    description: 'Empresa do ERP (padrão: 3)',
  })
  @ApiResponse({ status: 200, description: 'Cliente encontrado' })
  @ApiResponse({ status: 404, description: 'Cliente não encontrado no ERP' })
  buscarCliente(
    @Param('cli_codigo', ParseIntPipe) cliCodigo: number,
    @Query('empresa', new ParseIntPipe({ optional: true })) empresa?: number,
  ) {
    return this.service.buscarCliente(cliCodigo, empresa);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Busca uma encomenda de peça pelo ID' })
  @ApiParam({ name: 'id', type: Number, description: 'ID da venda casada' })
  @ApiResponse({ status: 200, description: 'Registro encontrado' })
  @ApiResponse({ status: 404, description: 'Registro não encontrado' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.service.findById(id);
  }

  @Post()
  @UseInterceptors(FastifyFileInterceptor('imagem'))
  @ApiOperation({ summary: 'Cria uma nova encomenda de peça (com imagem opcional)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Dados da venda casada e imagem opcional',
    schema: {
      type: 'object',
      properties: {
        nome_vendedor: { type: 'string' },
        carro: { type: 'string' },
        pecas: { type: 'array', items: { type: 'string' } },
        ano: { type: 'integer' },
        observacao: { type: 'string' },
        cliente: { type: 'string' },
        numero: { type: 'string' },
        imagem: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Encomenda de peça criada com sucesso' })
  create(
    @Body() dto: CreateVendaCasadaDto,
    @UploadedFile() file?: UploadedFileData,
  ) {
    return this.service.create(dto, file);
  }

  @Post(':id')
  @ApiOperation({
    summary: 'Adiciona peças cotadas a uma encomenda de peça',
    description:
      'Cria registros em ven_encomenda_pecas_itens e salva os IDs gerados na lista pecas_cotadas da encomenda de peça correspondente.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiBody({ type: AddPecasCotadasDto })
  @ApiResponse({ status: 201, description: 'Peças cotadas adicionadas com sucesso' })
  @ApiResponse({ status: 404, description: 'Encomenda de peça não encontrada' })
  addPecasCotadas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddPecasCotadasDto,
  ) {
    return this.service.addPecasCotadas(id, dto);
  }
}
