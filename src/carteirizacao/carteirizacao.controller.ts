import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CarteirizacaoService } from './carteirizacao.service';
import {
  AtribuirDto,
  AtribuirLoteDto,
  ListarClientesQuery,
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
      ordenarPor: q.ordenarPor || undefined,
      ordem: q.ordem === 'asc' ? 'asc' : q.ordem === 'desc' ? 'desc' : undefined,
      janelaDias: toNum(q.janelaDias),
    };
  }
}
