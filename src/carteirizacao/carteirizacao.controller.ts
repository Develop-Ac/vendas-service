import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CarteirizacaoService } from './carteirizacao.service';
import {
  ConfigVendedorDto,
  ConfirmarExclusaoDto,
  ListarClientesQuery,
  MetaVendedorDto,
  SincronizarDto,
  StatusCliente,
} from './dto/carteirizacao.dto';

const toBool = (v: unknown) => v === true || v === 'true' || v === '1';
const toNum = (v: unknown) =>
  v === undefined || v === null || v === '' ? undefined : Number(v);

@Controller('carteirizacao')
export class CarteirizacaoController {
  constructor(private readonly service: CarteirizacaoService) {}

  @Get('clientes')
  listarClientes(@Query() q: Record<string, string>) {
    return this.service.listarClientes(this.parseQuery(q));
  }

  @Get('clientes/export')
  async exportar(@Query() q: Record<string, string>, @Res() res: FastifyReply) {
    const csv = await this.service.exportarCsv(this.parseQuery(q));
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header(
      'Content-Disposition',
      `attachment; filename="carteirizacao_clientes.csv"`,
    );
    res.send(csv);
  }

  @Get('vendedores')
  listarVendedores() {
    return this.service.listarVendedores();
  }

  // Clientes disponíveis (pool 203) que já têm venda de outro vendedor após entrarem no
  // pool — lista de apoio à manutenção da carteira no ERP, com o vendedor sugerido.
  @Get('para-carteirizar')
  paraCarteirizar() {
    return this.service.clientesParaCarteirizar();
  }

  @Get('cliente/:cli/historico')
  historico(@Param('cli', ParseIntPipe) cli: number) {
    return this.service.historicoCliente(cli);
  }

  // Carga/reconciliação com o ERP (fonte da verdade). Usada pelo botão "Atualizar"
  // e pela carga diária automática. A manutenção manual da carteira foi desabilitada:
  // o ERP é a única origem de atribuição/movimentação.
  @Post('sincronizar')
  sincronizar(@Body() dto: SincronizarDto) {
    return this.service.sincronizar(dto ?? {});
  }

  // Única escrita manual restante: confirmar a exclusão de um cliente em revisão
  // (saiu da tabela de preço do atacado).
  @Post('cliente/:cli/confirmar-exclusao')
  confirmarExclusao(
    @Param('cli', ParseIntPipe) cli: number,
    @Body() dto: ConfirmarExclusaoDto,
  ) {
    return this.service.confirmarExclusao(cli, dto ?? {});
  }

  // Fila "orçamentos sem desfecho" (CRM do Atacado, fase 1): emitidos há mais de
  // `carenciaDias` sem nenhuma venda do cliente na carência — a população da
  // pesquisa de motivo de perda. Fonte: sempre a erp-firebird-api.
  @Get('orcamentos-sem-desfecho')
  orcamentosSemDesfecho(
    @Query('rep') rep?: string,
    @Query('carenciaDias') carenciaDias?: string,
    @Query('janelaDias') janelaDias?: string,
  ) {
    return this.service.orcamentosSemDesfecho({
      rep_codigo: toNum(rep),
      carenciaDias: toNum(carenciaDias),
      janelaDias: toNum(janelaDias),
    });
  }

  // -------------------------------------------------- Fase 2: acompanhamento
  @Get('indicadores/vendedores')
  indicadoresVendedores(@Query('janelaDias') janelaDias?: string) {
    return this.service.indicadoresVendedores(toNum(janelaDias));
  }

  @Get('indicadores/cliente/:cli')
  indicadoresCliente(
    @Param('cli', ParseIntPipe) cli: number,
    @Query('janelaDias') janelaDias?: string,
  ) {
    return this.service.indicadoresCliente(cli, toNum(janelaDias));
  }

  @Get('alertas')
  alertas(@Query('janelaDias') janelaDias?: string) {
    return this.service.alertas(toNum(janelaDias));
  }

  @Get('vendedores/:rep/config')
  getConfig(@Param('rep', ParseIntPipe) rep: number) {
    return this.service.getConfigVendedor(rep);
  }

  @Put('vendedores/:rep/config')
  salvarConfig(@Param('rep', ParseIntPipe) rep: number, @Body() dto: ConfigVendedorDto) {
    return this.service.salvarConfigVendedor(rep, dto ?? {});
  }

  // ------------------------------------------------- Fase 3: metas & perform.
  @Get('metas')
  metas(@Query('ano') ano?: string, @Query('mes') mes?: string, @Query('canal') canal?: string) {
    return this.service.metasVendedores(toNum(ano), toNum(mes), canal);
  }

  @Put('metas/:rep')
  setMeta(@Param('rep', ParseIntPipe) rep: number, @Body() dto: MetaVendedorDto) {
    return this.service.setMetaVendedor(rep, dto);
  }

  // Dados do painel de vendas (Metabase) de um vendedor: nome + período vigente.
  @Get('painel-vendas')
  painelVendas(@Query('rep', ParseIntPipe) rep: number) {
    return this.service.painelVendas(rep);
  }

  // Dados do painel de Supervisão Atacado: equipe (vendedores do canal) + período.
  // ini/fim (opcionais) = período visualizado; a equipe é resolvida pelo histórico de canal nessa data.
  @Get('painel-supervisao')
  painelSupervisao(@Query('ini') ini?: string, @Query('fim') fim?: string) {
    return this.service.painelSupervisao(ini, fim);
  }

  // Equipe do atacado no período (dropdown de vendedor do supervisor): quem vendeu no
  // canal + quem está cadastrado como "Vendedor (Atacado)" na tela de Representantes.
  @Get('equipe-atacado-periodo')
  equipeAtacadoPeriodo(@Query('ini') ini: string, @Query('fim') fim: string) {
    return this.service.equipeAtacadoPeriodo(ini, fim);
  }

  // KPIs de carteira do supervisor: equipe inteira ou 1 vendedor (?vendedor=).
  @Get('painel-carteira-supervisao')
  painelCarteiraSupervisao(
    @Query('vendedor') vendedor?: string,
    @Query('ini') ini?: string,
    @Query('fim') fim?: string,
  ) {
    return this.service.painelCarteiraSupervisao(vendedor, ini ?? '', fim ?? '');
  }

  // ------------------------------------------------- Gerência (empresa toda)
  // Painel da Gerência: todos os vendedores (filtro agregado) + período.
  @Get('painel-gerencia')
  painelGerencia(@Query('ini') ini?: string, @Query('fim') fim?: string) {
    return this.service.painelGerencia(ini, fim);
  }

  // Todos os vendedores da empresa com venda no período (dropdown da Gerência).
  @Get('vendedores-empresa-periodo')
  vendedoresEmpresaPeriodo(@Query('ini') ini: string, @Query('fim') fim: string) {
    return this.service.vendedoresEmpresaComVenda(ini, fim);
  }

  // KPIs de carteira da Gerência: empresa inteira ou 1 vendedor (?vendedor=).
  @Get('painel-carteira-gerencia')
  painelCarteiraGerencia(
    @Query('vendedor') vendedor?: string,
    @Query('ini') ini?: string,
    @Query('fim') fim?: string,
  ) {
    return this.service.painelCarteiraGerencia(vendedor, ini ?? '', fim ?? '');
  }

  // Lookup codigo_ibge -> lat/lng para o mapa de calor de vendas por município.
  @Get('municipios-geo')
  municipiosGeo() {
    return this.service.municipiosGeo();
  }

  // KPIs de carteira do painel (qtde em carteira do Postgres, com venda e positivação).
  @Get('painel-carteira')
  painelCarteira(
    @Query('rep', ParseIntPipe) rep: number,
    @Query('ini') ini: string,
    @Query('fim') fim: string,
  ) {
    return this.service.painelCarteira(rep, ini, fim);
  }

  private parseQuery(q: Record<string, string>): ListarClientesQuery {
    return {
      page: toNum(q.page),
      pageSize: toNum(q.pageSize),
      status: (q.status as StatusCliente) || undefined,
      rep_codigo: toNum(q.rep_codigo),
      semVendedor: q.semVendedor != null ? toBool(q.semVendedor) : undefined,
      uf: q.uf || undefined,
      busca: q.busca || undefined,
      faturamentoMin: toNum(q.faturamentoMin),
      faturamentoMax: toNum(q.faturamentoMax),
      altoFaturamento: q.altoFaturamento != null ? toBool(q.altoFaturamento) : undefined,
      queda: q.queda != null ? toBool(q.queda) : undefined,
      novo: q.novo != null ? toBool(q.novo) : undefined,
      risco: q.risco != null ? toBool(q.risco) : undefined,
      revisao: q.revisao != null ? toBool(q.revisao) : undefined,
      curvaAbc: (q.curvaAbc as 'A' | 'B' | 'C') || undefined,
      quadrante: (q.quadrante as ListarClientesQuery['quadrante']) || undefined,
      scoreFaixa: (q.scoreFaixa as 'A' | 'B' | 'C' | 'D') || undefined,
      ordenarPor: q.ordenarPor || undefined,
      ordem: q.ordem === 'asc' ? 'asc' : q.ordem === 'desc' ? 'desc' : undefined,
      janelaDias: toNum(q.janelaDias),
    };
  }
}
