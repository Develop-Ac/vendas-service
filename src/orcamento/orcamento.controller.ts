import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { OrcamentoService } from './orcamento.service';
import {
  AcaoOrcamentoDto,
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
  @ApiOperation({ summary: 'Busca de cliente (código, CNPJ/CPF ou nome). Padrão: só atacado (tabela 2/5).' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'todos', required: false, description: '1 = base inteira' })
  clientes(@Query('q') q: string, @Query('todos') todos?: string) {
    return this.service.buscarClientes(q ?? '', todos === '1' || todos === 'true');
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
