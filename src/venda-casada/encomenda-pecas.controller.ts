import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Param,
  Query,
  ParseIntPipe,
  UploadedFiles,
  UseInterceptors,
  Body,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FastifyFilesInterceptor } from '../common/interceptors/fastify-files.interceptor';
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
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateItemCotadoDto } from './dto/update-item-cotado.dto';
import { UpdateNfeDto } from './dto/update-nfe.dto';

@ApiTags('Encomenda de Peças')
@Controller('encomenda-pecas')
export class EncomendaPecasController {
  constructor(
    private readonly service: EncomendaPecasService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Lista todas as encomendas de peças',
    description:
      'Cada encomenda vem com `pecas` (ven_encomenda_pecas_itens_encomendados), ' +
      '`pecas_cotadas` (ven_encomenda_pecas_itens_cotados) e `anexos` (ven_encomenda_pecas_anexos), ' +
      'cada anexo com `tipo`: "carro" (imagens da criação) ou "comprovante" (enviados depois). ' +
      '`prazo` vem como "YYYY-MM-DD" (ou null).',
  })
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
  @ApiOperation({
    summary: 'Busca uma encomenda de peça pelo ID',
    description:
      'Retorna a encomenda com `pecas` (ven_encomenda_pecas_itens_encomendados), ' +
      '`pecas_cotadas` (ven_encomenda_pecas_itens_cotados) e `anexos` (ven_encomenda_pecas_anexos), ' +
      'cada anexo com `tipo`: "carro" (imagens da criação) ou "comprovante" (enviados depois). ' +
      '`prazo` vem como "YYYY-MM-DD" (ou null).',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da venda casada' })
  @ApiResponse({ status: 200, description: 'Registro encontrado' })
  @ApiResponse({ status: 404, description: 'Registro não encontrado' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.service.findById(id);
  }

  @Post()
  @UseInterceptors(FastifyFilesInterceptor(['imagens', 'imagem']))
  @ApiOperation({ summary: 'Cria uma nova encomenda de peça (com imagens opcionais)' })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    description:
      'Dados da encomenda e imagens opcionais. Cada item de `pecas` vira uma linha em ' +
      'ven_encomenda_pecas_itens_encomendados e cada item de `pecas_cotadas` (opcional, pode ser ' +
      'vazia) vira uma linha em ven_encomenda_pecas_itens_cotados. Em multipart, envie cada item como JSON string ' +
      'e repita o campo `imagens` para mandar várias fotos — cada uma vira uma linha em ' +
      'ven_encomenda_pecas_anexos com `tipo: "carro"`. O campo antigo `imagem` continua aceito.',
    schema: {
      type: 'object',
      properties: {
        nome_vendedor: { type: 'string' },
        carro: { type: 'string' },
        pecas: {
          type: 'array',
          items: {
            type: 'object',
            required: ['peca'],
            properties: {
              peca: { type: 'string', example: 'LAN T GOL /86 LE FUME' },
              pro_codigo: {
                type: 'integer',
                example: 2321,
                description: 'Se não informado, o backend usa 99999.',
              },
              referencia: { type: 'string', example: '2204' },
              quantidade: { type: 'integer', example: 12, default: 1 },
            },
          },
        },
        pecas_cotadas: {
          type: 'array',
          description:
            'Opcional e pode vir vazia. Cada item vira uma linha em ven_encomenda_pecas_itens_cotados. ' +
            'Em multipart, envie cada item (ou a lista inteira) como JSON string.',
          items: {
            type: 'object',
            required: ['nome', 'valor'],
            properties: {
              nome: { type: 'string', example: 'Pastilha de freio' },
              valor: { type: 'number', example: 199.9 },
              prazo: { type: 'string', example: '15 dias' },
              fornecedor: { type: 'string' },
              marca: { type: 'string' },
              transpostadora: { type: 'string' },
              custo: { type: 'number', example: 120.5 },
              margem: { type: 'number', example: 35 },
              frete: { type: 'number', example: 25 },
              imposto: { type: 'number', example: 18 },
              autorizado: { type: 'boolean' },
            },
          },
        },
        ano: { type: 'integer' },
        observacao: { type: 'string' },
        cli_codigo: { type: 'integer' },
        cliente: { type: 'string' },
        numero: { type: 'string' },
        imagens: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Encomenda de peça criada com sucesso' })
  create(
    @Body() dto: CreateVendaCasadaDto,
    @UploadedFiles() files?: UploadedFileData[],
  ) {
    return this.service.create(dto, files);
  }

  @Post(':id')
  @ApiOperation({
    summary: 'Adiciona peças cotadas a uma encomenda de peça',
    description:
      'Cria registros em ven_encomenda_pecas_itens_cotados já vinculados à encomenda ' +
      '(encomenda_pecas_id) e devolve a encomenda atualizada com as duas listas de itens.',
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

  @Put('status/:id')
  @ApiOperation({
    summary: 'Atualiza o status de uma encomenda de peça',
    description:
      'Recebe `status` e `motivo`. Quando o status é "Cancelado", `motivo` é obrigatório e é ' +
      'gravado em `motivoCancelamento` (retornado no GET e GET /:id). Em qualquer outro status ' +
      'o `motivoCancelamento` é limpo. `motivoDenaoCotar` é opcional e grava na coluna de mesmo ' +
      'nome (se não vier, mantém o valor atual). `prazo` (YYYY-MM-DD) também é opcional e grava ' +
      'na coluna `prazo` com a mesma regra; vazio ou null limpa.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiBody({ type: UpdateStatusDto })
  @ApiResponse({ status: 200, description: 'Status atualizado com sucesso' })
  @ApiResponse({ status: 400, description: 'Status vazio, cancelamento sem motivo ou prazo inválido' })
  @ApiResponse({ status: 404, description: 'Encomenda de peça não encontrada' })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateStatusDto,
  ) {
    return this.service.updateStatus(id, dto);
  }

  @Put('nfe/:id')
  @ApiOperation({
    summary: 'Salva a NF-e de uma encomenda de peça',
    description:
      'Grava `nfe` na coluna de mesmo nome em ven_encomenda_pecas e devolve a encomenda ' +
      'atualizada. Enviar vazio ou null limpa o valor.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiBody({ type: UpdateNfeDto })
  @ApiResponse({ status: 200, description: 'NF-e salva com sucesso' })
  @ApiResponse({ status: 400, description: 'Campo "nfe" ausente ou inválido' })
  @ApiResponse({ status: 404, description: 'Encomenda de peça não encontrada' })
  updateNfe(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateNfeDto,
  ) {
    return this.service.updateNfe(id, dto);
  }

  @Patch('item_cotado/:id')
  @ApiOperation({ summary: 'Autoriza ou desautoriza um item cotado' })
  @ApiParam({ name: 'id', type: Number, description: 'ID do item cotado' })
  @ApiBody({ type: UpdateItemCotadoDto })
  @ApiResponse({ status: 200, description: 'Item cotado atualizado com sucesso' })
  @ApiResponse({ status: 404, description: 'Item cotado não encontrado' })
  updateItemCotado(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateItemCotadoDto,
  ) {
    return this.service.updateItemCotadoAutorizado(id, dto);
  }

  @Post('anexo/:id')
  @UseInterceptors(FastifyFilesInterceptor('anexos'))
  @ApiOperation({
    summary: 'Envia anexos de uma encomenda de peça para o MinIO',
    description:
      'Aceita qualquer tipo de arquivo (imagem, PDF, vídeo, áudio) no campo `anexos` ' +
      '(pode repetir o campo para enviar vários), sobe cada um para o bucket configurado ' +
      'em S3_BUCKET_AVARIAS e grava a chave de cada arquivo em ven_encomenda_pecas_anexos ' +
      'com `tipo: "comprovante"`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        anexos: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Anexos enviados com sucesso' })
  @ApiResponse({ status: 404, description: 'Encomenda de peça não encontrada' })
  enviarAnexos(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: UploadedFileData[],
  ) {
    return this.service.enviarAnexos(id, files);
  }
}
