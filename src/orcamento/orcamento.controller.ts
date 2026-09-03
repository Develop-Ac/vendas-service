import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrcamentoService } from './orcamento.service';
import {
  AcaoOrcamentoDto,
  EntregueOrcamentoDto,
  DesfechoOrcamentoDto,
  ExcecaoReguaDto,
  SalvarOrcamentoDto,
} from './dto/orcamento.dto';

const toNum = (v?: string) => (v == null || v === '' ? undefined : Number(v));

/* =============================================================================
   ORÇAMENTO DO ATACADO — rotas.
   -----------------------------------------------------------------------------
   As rotas fixas (regua, clientes, produtos, vendedor, relacionados) vêm ANTES
   de `:id`, senão o Nest casa "produtos" como id de orçamento.
   ============================================================================= */

@ApiTags('Orçamento do Atacado')
@Controller('orcamento')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class OrcamentoController {
  constructor(private readonly service: OrcamentoService) {}

  /* ------------------------------------------------------------- régua */

  @Get('regua')
  @ApiOperation({ summary: 'Régua v3 vigente (classe × faixa), limites de faixa e parâmetros da bolsa.' })
  regua() {
    return this.service.regua();
  }

  @Get('regua/excecoes')
  @ApiOperation({ summary: 'Itens fora da régua (lançamento/exclusivo e oportunidade).' })
  excecoes() {
    return this.service.listarExcecoes();
  }

  @Put('regua/excecoes/:pro_codigo')
  @ApiOperation({ summary: 'Cria/atualiza/remove a exceção de um item.' })
  salvarExcecao(@Param('pro_codigo', ParseIntPipe) pro: number, @Body() dto: ExcecaoReguaDto) {
    return this.service.salvarExcecao(pro, dto);
  }

  /* ----------------------------------------------------------- clientes */

  @Get('clientes')
  @ApiOperation({ summary: 'Busca de cliente (código, CNPJ/CPF ou nome) na base inteira; o preço segue a tabela de cada um.' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'todos', required: false, description: '0 = só atacado (tabela 2/5). Padrão: base inteira.' })
  clientes(@Query('q') q: string, @Query('todos') todos?: string) {
    return this.service.buscarClientes(q ?? '', !(todos === '0' || todos === 'false'));
  }

  @Get('clientes/:cli')
  @ApiOperation({ summary: 'Cabeçalho do cliente: cadastro ao vivo + crédito em aberto + histórico.' })
  cliente(@Param('cli', ParseIntPipe) cli: number) {
    return this.service.cliente(cli);
  }

  /* ----------------------------------------------------------- vendedor */

  @Get('vendedor/:rep/bolsa')
  @ApiOperation({ summary: 'Bolsa de desconto do vendedor no mês comissional (+ projeção com o orçamento).' })
  @ApiQuery({ name: 'bruto', required: false, description: 'Subtotal (a preço de tabela) do orçamento em edição' })
  @ApiQuery({ name: 'desconto', required: false, description: 'Desconto total do orçamento em edição' })
  bolsa(
    @Param('rep', ParseIntPipe) rep: number,
    @Query('bruto') bruto?: string,
    @Query('desconto') desconto?: string,
  ) {
    const b = toNum(bruto), d = toNum(desconto);
    return this.service.bolsa(rep, b != null ? { bruto: b, desconto: d ?? 0 } : undefined);
  }

  /* -------------------------------------------------- orçamentos do Celta */

  @Get('celta/pendentes')
  @ApiOperation({ summary: 'Orçamentos lançados no Celta nos últimos N dias (padrão 7) ainda sem venda do cliente e sem motivo de perda.' })
  @ApiQuery({ name: 'rep', required: false })
  @ApiQuery({ name: 'dias', required: false, example: 7 })
  celtaPendentes(@Query('rep') rep?: string, @Query('dias') dias?: string) {
    return this.service.celtaPendentes(toNum(rep), toNum(dias) ?? 7);
  }

  @Get('ativos')
  @ApiOperation({ summary: 'Orçamentos ativos do cliente: intranet em aberto + Celta dentro da validade (o "Orçar" da Estação).' })
  @ApiQuery({ name: 'cli', required: true })
  ativos(@Query('cli') cli: string) {
    const n = toNum(cli);
    if (!n) throw new BadRequestException('Informe o cliente (cli).');
    return this.service.ativos(n);
  }

  @Get('celta/:orcamento/itens')
  @ApiOperation({ summary: 'Itens de um orçamento do Celta avaliados na régua para a tabela do cliente — o "importar itens".' })
  @ApiQuery({ name: 'tabela', required: false })
  @ApiQuery({ name: 'cli', required: false })
  celtaItens(@Param('orcamento', ParseIntPipe) orcamento: number, @Query('tabela') tabela?: string, @Query('cli') cli?: string) {
    return this.service.celtaItens(orcamento, tabela ?? null, toNum(cli));
  }

  /* ----------------------------------------------------------- produtos */

  @Get('produtos')
  @ApiOperation({ summary: 'Busca de produto (código, descrição ou referência) já avaliado na régua para a tabela do cliente.' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'tabela', required: false, description: 'TABELA_PRECO do cliente (2/5). Ausente = PRECO_VENDA.' })
  @ApiQuery({ name: 'cli', required: false, description: 'Cliente, para trazer o último preço pago.' })
  @ApiQuery({ name: 'limite', required: false })
  produtos(
    @Query('q') q: string,
    @Query('tabela') tabela?: string,
    @Query('cli') cli?: string,
    @Query('limite') limite?: string,
  ) {
    return this.service.buscarProdutos(q ?? '', tabela ?? null, toNum(cli), Math.min(100, toNum(limite) ?? 30));
  }

  @Get('produtos/pesquisa')
  @ApiOperation({
    summary: 'Pesquisa no padrão da EST012 do Celta: campo, modo, filtros e os similares encadeados (principal + grupo).',
  })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'campo', required: false, enum: ['descricao', 'codigo', 'so_descricao', 'referencia', 'ref_fabricante', 'ref_fornecedor', 'codigo_barras', 'aplicacao', 'subgrupo', 'localizacao', 'todas_referencias', 'marca', 'generica'] })
  @ApiQuery({ name: 'modo', required: false, enum: ['comeca', 'contem'] })
  @ApiQuery({ name: 'estoque', required: false, description: '1 = só com saldo disponível' })
  @ApiQuery({ name: 'inativos', required: false, description: '1 = listar inativos' })
  @ApiQuery({ name: 'comercializavel', required: false, description: '1 = só comercializável' })
  @ApiQuery({ name: 'equivalentes', required: false, description: '0 = não encadear similares' })
  @ApiQuery({ name: 'tabela', required: false })
  @ApiQuery({ name: 'cli', required: false })
  pesquisa(
    @Query('q') q: string,
    @Query('campo') campo?: string,
    @Query('modo') modo?: string,
    @Query('estoque') estoque?: string,
    @Query('inativos') inativos?: string,
    @Query('comercializavel') comercializavel?: string,
    @Query('equivalentes') equivalentes?: string,
    @Query('tabela') tabela?: string,
    @Query('cli') cli?: string,
    @Query('limite') limite?: string,
  ) {
    const on = (v?: string, padrao = false) => (v == null || v === '' ? padrao : v === '1' || v === 'true');
    return this.service.pesquisar(q ?? '', tabela ?? null, toNum(cli), {
      campo: (['descricao', 'codigo', 'so_descricao', 'referencia', 'ref_fabricante', 'ref_fornecedor', 'codigo_barras', 'aplicacao', 'subgrupo', 'localizacao', 'todas_referencias', 'marca', 'generica'] as const).find((c) => c === campo) ?? 'descricao',
      modo: modo === 'contem' ? 'contem' : 'comeca',
      comEstoque: on(estoque, true),
      inativos: on(inativos, false),
      comercializavel: on(comercializavel, true),
      equivalentes: on(equivalentes, true),
      limite: Math.min(200, toNum(limite) ?? 60),
    });
  }

  @Get('produtos/:codigo/imagens')
  @ApiOperation({ summary: 'IDs das fotos do produto (0 = produto, 1 = veículo).' })
  imagens(@Param('codigo', ParseIntPipe) codigo: number) {
    return this.service.imagensDoProduto(codigo);
  }

  @Get('imagens/:id')
  @ApiOperation({ summary: 'Binário da foto (repasse da erp-firebird-api → CELTAAUXILIAR.FDB).' })
  async imagem(@Param('id', ParseIntPipe) id: number, @Res() res: FastifyReply) {
    const img = await this.service.imagem(id);
    res.header('Content-Type', img.contentType);
    res.header('Cache-Control', 'public, max-age=86400');
    // O helmet marca toda resposta como Cross-Origin-Resource-Policy: same-origin;
    // a intranet (outro host) carrega a foto num <img> e o navegador bloqueia
    // (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin). Foto de produto pode ser pública na rede.
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (img.etag) res.header('ETag', img.etag);
    return res.send(img.dados);
  }

  @Get('produtos/:codigo')
  @ApiOperation({ summary: 'Produto + equivalentes (grupo de similares) + vendem juntos.' })
  produto(@Param('codigo', ParseIntPipe) codigo: number, @Query('tabela') tabela?: string, @Query('cli') cli?: string) {
    return this.service.produto(codigo, tabela ?? null, toNum(cli));
  }

  @Get('produtos/:codigo/equivalentes')
  equivalentes(@Param('codigo', ParseIntPipe) codigo: number, @Query('tabela') tabela?: string, @Query('cli') cli?: string) {
    return this.service.equivalentes(codigo, tabela ?? null, toNum(cli));
  }

  @Get('produtos/:codigo/relacionados')
  relacionados(@Param('codigo', ParseIntPipe) codigo: number, @Query('tabela') tabela?: string, @Query('cli') cli?: string) {
    return this.service.relacionados(codigo, tabela ?? null, toNum(cli));
  }

  @Post('relacionados/recalcular')
  @ApiOperation({ summary: 'Reapura os pares "vendem juntos" no BI (o cron semanal faz o mesmo).' })
  recalcular(@Query('meses') meses?: string) {
    return this.service.recalcularRelacionados(toNum(meses) ?? 12);
  }

  /* ---------------------------------------------------------- orçamento */

  @Get()
  @ApiOperation({ summary: 'Lista de orçamentos (filtros: rep, cli, status, page, pageSize).' })
  listar(
    @Query('rep') rep?: string,
    @Query('cli') cli?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listar({
      rep_codigo: toNum(rep),
      cli_codigo: toNum(cli),
      status: status || undefined,
      page: toNum(page),
      pageSize: toNum(pageSize),
    });
  }

  @Post()
  @ApiOperation({ summary: 'Cria o orçamento (rascunho). Preço de tabela, custo e saldo são lidos do ERP na hora.' })
  criar(@Body() dto: SalvarOrcamentoDto) {
    return this.service.criar(dto);
  }

  @Get(':id')
  obter(@Param('id') id: string) {
    return this.service.obter(id);
  }

  @Get(':id/conferir')
  @ApiOperation({ summary: 'Re-avalia o orçamento contra o ERP de agora (saldo, tabela) sem gravar.' })
  conferir(@Param('id') id: string) {
    return this.service.conferir(id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Regrava cabeçalho e itens; orçamento volta a RASCUNHO.' })
  atualizar(@Param('id') id: string, @Body() dto: SalvarOrcamentoDto) {
    return this.service.atualizar(id, dto);
  }

  @Post(':id/enviar')
  @ApiOperation({ summary: 'Fecha a proposta: ENVIADO, ou APROVACAO se algum item está abaixo do mínimo.' })
  enviar(@Param('id') id: string, @Body() dto: AcaoOrcamentoDto) {
    return this.service.enviar(id, dto);
  }

  @Get(':id/mensagem')
  @ApiOperation({ summary: 'Texto para o WhatsApp + PDF (base64) do orçamento — o que a Estação envia no chat ativo.' })
  mensagem(@Param('id') id: string) {
    return this.service.mensagem(id);
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'PDF do orçamento no leiaute que o cliente conhece (logo da AC).' })
  async pdf(@Param('id') id: string, @Res() res: FastifyReply) {
    const { nome, dados } = await this.service.pdf(id);
    res.header('Content-Type', 'application/pdf');
    res.header('Content-Disposition', `inline; filename="${nome}"`);
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return res.send(dados);
  }

  @Post(':id/entregue')
  @ApiOperation({ summary: 'Marca que o cliente RECEBEU a proposta (canal e hora).' })
  entregue(@Param('id') id: string, @Body() dto: EntregueOrcamentoDto) {
    return this.service.entregue(id, dto.canal);
  }

  @Post(':id/aprovar')
  @ApiOperation({ summary: 'Supervisor libera item abaixo do mínimo (APROVACAO → ENVIADO).' })
  aprovar(@Param('id') id: string, @Body() dto: AcaoOrcamentoDto) {
    return this.service.aprovar(id, dto);
  }

  @Post(':id/desfecho')
  @ApiOperation({ summary: 'FECHADO (com referência no Celta) ou PERDIDO (com motivo).' })
  desfecho(@Param('id') id: string, @Body() dto: DesfechoOrcamentoDto) {
    return this.service.desfecho(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Cancela o orçamento (não apaga).' })
  cancelar(@Param('id') id: string) {
    return this.service.cancelar(id);
  }
}
