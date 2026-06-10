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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CarteirizacaoService } from './carteirizacao.service';
import {
  AtribuirDto,
  AtribuirLoteDto,
  ConfigVendedorDto,
  ListarClientesQuery,
  MetaVendedorDto,
  RedistribuirDto,
  RemoverDto,
  SeedDto,
  StatusCliente,
  TransferirDto,
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
  async exportar(@Query() q: Record<string, string>, @Res() res: Response) {
    const csv = await this.service.exportarCsv(this.parseQuery(q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="carteirizacao_clientes.csv"`,
    );
    res.send(csv);
  }

  @Get('vendedores')
  listarVendedores() {
    return this.service.listarVendedores();
  }

  @Get('cliente/:cli/historico')
  historico(@Param('cli', ParseIntPipe) cli: number) {
    return this.service.historicoCliente(cli);
  }

  @Post('atribuir')
  atribuir(@Body() dto: AtribuirDto) {
    return this.service.atribuir(dto);
  }

  @Post('atribuir-lote')
  atribuirLote(@Body() dto: AtribuirLoteDto) {
    return this.service.atribuirLote(dto);
  }

  @Post('transferir')
  transferir(@Body() dto: TransferirDto) {
    return this.service.transferir(dto);
  }

  @Delete('cliente/:cli')
  remover(@Param('cli', ParseIntPipe) cli: number, @Body() dto: RemoverDto) {
    return this.service.remover(cli, dto ?? {});
  }

  @Post('seed')
  seed(@Body() dto: SeedDto) {
    return this.service.seed(dto ?? {});
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

  @Post('redistribuir')
  redistribuir(@Body() dto: RedistribuirDto) {
    return this.service.redistribuir(dto);
  }

  // ------------------------------------------------- Fase 3: metas & perform.
  @Get('metas')
  metas(@Query('ano') ano?: string, @Query('mes') mes?: string) {
    return this.service.metasVendedores(toNum(ano), toNum(mes));
  }

  @Put('metas/:rep')
  setMeta(@Param('rep', ParseIntPipe) rep: number, @Body() dto: MetaVendedorDto) {
    return this.service.setMetaVendedor(rep, dto);
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
      curvaAbc: (q.curvaAbc as 'A' | 'B' | 'C') || undefined,
      scoreFaixa: (q.scoreFaixa as 'A' | 'B' | 'C' | 'D') || undefined,
      ordenarPor: q.ordenarPor || undefined,
      ordem: q.ordem === 'asc' ? 'asc' : q.ordem === 'desc' ? 'desc' : undefined,
      janelaDias: toNum(q.janelaDias),
    };
  }
}
