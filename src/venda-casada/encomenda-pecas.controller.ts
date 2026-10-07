import {
  Controller,
  Delete,
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
import { AddPecasCotadasDto, VendaCasadaItemDto } from './dto/add-pecas-cotadas.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UpdateItemCotadoDto } from './dto/update-item-cotado.dto';
import { UpdateItemCotadoFornecedorDto } from './dto/update-item-cotado-fornecedor.dto';
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

  @Get('fornecedores/:for_codigo')
  @ApiOperation({
    summary: 'Busca um fornecedor no ERP pelo código',
    description:
      'Consulta a erp-firebird-api e devolve FOR_CODIGO, FOR_NOME e NOME_FANTASIA. A tela do ' +
      'item cotado mostra o nome fantasia (razão social só como reserva).',
  })
  @ApiParam({ name: 'for_codigo', type: Number, description: 'Código do fornecedor no ERP' })
  @ApiQuery({ name: 'empresa', type: Number, required: false, description: 'Empresa do ERP (padrão: 3)' })
  @ApiResponse({ status: 200, description: 'Fornecedor encontrado' })
  @ApiResponse({ status: 404, description: 'Fornecedor não encontrado no ERP' })
  buscarFornecedor(
    @Param('for_codigo', ParseIntPipe) forCodigo: number,
    @Query('empresa', new ParseIntPipe({ optional: true })) empresa?: number,
  ) {
    return this.service.buscarFornecedor(forCodigo, empresa);
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

  @Get('pedidos/:id')
  @ApiOperation({
    summary: 'Pedidos de compra da encomenda, com NFs e rastreio SSW',
    description:
      'Lê no compras-service os pedidos gerados ao marcar a encomenda como "Comprado" ' +
      '(um por fornecedor, número "E-100001"): fornecedor, status, número no Celta, itens, ' +
      'NFs vinculadas e, por NF, o CT-e com o rastreio SSW (status, domínio, previsão e ' +
      'eventos). Antes do "Comprado" devolve `pedidos: null`. É o mesmo bloco que o ' +
      'GET /:id já traz em `pedidos`; esta rota serve para atualizar só o rastreio.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiResponse({ status: 200, description: 'Pedidos da encomenda (ou null antes do "Comprado")' })
  @ApiResponse({ status: 404, description: 'Encomenda de peça não encontrada' })
  async pedidosDeCompra(@Param('id', ParseIntPipe) id: number) {
    const venda = await this.service.findById(id);
    return { pedidos: venda.pedidos, pedidos_erro: venda.pedidos_erro };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Busca uma encomenda de peça pelo ID',
    description:
      'Retorna a encomenda com `pecas` (ven_encomenda_pecas_itens_encomendados), ' +
      '`pecas_cotadas` (ven_encomenda_pecas_itens_cotados) e `anexos` (ven_encomenda_pecas_anexos), ' +
      'cada anexo com `tipo`: "carro" (imagens da criação) ou "comprovante" (enviados depois). ' +
      '`prazo` vem como "YYYY-MM-DD" (ou null). Depois do "Comprado" traz também `pedidos` ' +
      '(pedidos de compra do compras-service com NFs e rastreio SSW) ou `pedidos_erro` se o ' +
      'compras-service não respondeu.',
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
            required: ['pro_codigo', 'peca'],
            properties: {
              pro_codigo: {
                type: 'integer',
                example: 2321,
                description: 'Código do produto no Celta (obrigatório, precisa existir).',
              },
              peca: { type: 'string', example: 'LAN T GOL /86 LE FUME' },
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
              for_codigo: {
                type: 'integer',
                example: 250,
                description: 'Código do fornecedor no Celta; o nome vem do ERP e é gravado em `fornecedor`.',
              },
              fornecedor: { type: 'string', description: 'Preenchido pelo servidor a partir de for_codigo.' },
              pro_codigo: {
                type: 'integer',
                example: 2321,
                description: 'Produto do Celta ao qual a cotação se refere (uma das peças).',
              },
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
        ano: { type: 'integer', description: 'Obrigatório (1900–2100).' },
        observacao: { type: 'string' },
        cli_codigo: { type: 'integer', description: 'Obrigatório; precisa existir no ERP.' },
        cliente: { type: 'string' },
        numero: { type: 'string' },
        os: {
          type: 'integer',
          example: 10231,
          description:
            'Ordem de serviço no ERP. `oficina` é gravado como true se o STATUS da OS for 1; ' +
            'false em qualquer outro status ou sem OS. OS inexistente retorna 400.',
        },
        imagens: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Encomenda de peça criada com sucesso' })
  @ApiResponse({ status: 400, description: 'Sem peças, peça sem pro_codigo ou inexistente no Celta, sem ano, cliente ausente/inexistente no ERP, fornecedor cotado inexistente ou OS inválida/não encontrada' })
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
      '(encomenda_pecas_id) e devolve a encomenda atualizada com as duas listas de itens. ' +
      '`for_codigo` precisa existir no Celta (o nome vem do ERP para `fornecedor`); ' +
      '`pro_codigo`, se vier, precisa ser uma das peças da encomenda.',
  })
  @ApiResponse({ status: 400, description: 'Item sem nome/valor, fornecedor inexistente no Celta ou pro_codigo fora das peças da encomenda' })
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
      'na coluna `prazo` com a mesma regra; vazio ou null limpa. Sem `prazo`, o servidor aplica ' +
      'hoje (Cuiabá) + 7 dias ao sair de "Em cotação" ou "Aguardando Sup. Compras 2" para ' +
      '"Aguardando Sup. Compras 1"/"Aguardando Vendedor". Grava a hora de entrada na nova etapa ' +
      'e devolve a encomenda como no GET /:id (com `etapas` e `prazo_vencido`). Ao entrar em ' +
      '"Comprado", gera no compras-service um pedido de compra por fornecedor dos itens cotados ' +
      'selecionados (autorizado = true), todos com o mesmo número "E-100001", gravado em ' +
      '`pedido_compras`; cada item selecionado precisa ter `for_codigo` e produto do Celta, ' +
      'senão 400 e o status não muda. `usuario` (opcional) vai para o log do pedido.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da encomenda de peça' })
  @ApiBody({ type: UpdateStatusDto })
  @ApiResponse({ status: 200, description: 'Status atualizado com sucesso' })
  @ApiResponse({ status: 400, description: 'Status vazio, cancelamento sem motivo, prazo inválido ou "Comprado" sem item selecionado/sem fornecedor/sem produto do Celta' })
  @ApiResponse({ status: 502, description: 'compras-service não respondeu ao gerar o pedido (status não muda)' })
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

  @Put('item_cotado/:id')
  @ApiOperation({
    summary: 'Edita um item cotado',
    description:
      'Só é permitido com a encomenda em "Em cotação". `nome` e `valor` são obrigatórios; ' +
      'os demais campos, se não vierem, mantêm o valor atual (vazio limpa). `autorizado` é ignorado.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID do item cotado' })
  @ApiBody({ type: VendaCasadaItemDto })
  @ApiResponse({ status: 200, description: 'Item cotado atualizado com sucesso' })
  @ApiResponse({ status: 400, description: 'Dados inválidos ou encomenda fora de "Em cotação"' })
  @ApiResponse({ status: 404, description: 'Item cotado não encontrado' })
  editarItemCotado(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: VendaCasadaItemDto,
  ) {
    return this.service.updateItemCotado(id, dto);
  }

  @Delete('item_cotado/:id')
  @ApiOperation({
    summary: 'Exclui um item cotado',
    description: 'Só é permitido com a encomenda em "Em cotação".',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID do item cotado' })
  @ApiResponse({ status: 200, description: 'Item cotado excluído' })
  @ApiResponse({ status: 400, description: 'Encomenda fora de "Em cotação"' })
  @ApiResponse({ status: 404, description: 'Item cotado não encontrado' })
  excluirItemCotado(@Param('id', ParseIntPipe) id: number) {
    return this.service.deleteItemCotado(id);
  }

  @Patch('item_cotado/:id/fornecedor')
  @ApiOperation({
    summary: 'Troca o fornecedor (texto) de um item cotado pelo código do Celta',
    description:
      'Para cotações antigas em que `fornecedor` é texto livre (sem `for_codigo`). Grava ' +
      '`for_codigo` e o nome vindo do ERP em `fornecedor`. Permitido em qualquer etapa até ' +
      '"Liberado para comprar"; item que já tem código é recusado (edite em "Em cotação").',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID do item cotado' })
  @ApiBody({ type: UpdateItemCotadoFornecedorDto })
  @ApiResponse({ status: 200, description: 'Fornecedor atualizado' })
  @ApiResponse({ status: 400, description: 'Item já com código, etapa após "Liberado para comprar" ou fornecedor inexistente no Celta' })
  @ApiResponse({ status: 404, description: 'Item cotado não encontrado' })
  updateItemCotadoFornecedor(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateItemCotadoFornecedorDto,
  ) {
    return this.service.updateItemCotadoFornecedor(id, dto);
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
