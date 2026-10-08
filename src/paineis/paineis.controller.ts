import { Body, Controller, Delete, Get, Headers, Put, Query } from '@nestjs/common';
import { PaineisService } from './paineis.service';

/** `vendedores` aceita "A,B" ou o parâmetro repetido; normaliza para a chave do cache. */
function listaVendedores(v: unknown): string[] {
  const brutos = (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === 'string' ? x.split(',') : []));
  return [...new Set(brutos.map((n) => n.trim()).filter(Boolean))].sort();
}

/**
 * Painéis de vendas nativos (substituem os dashboards do Metabase na intranet).
 * Interno: a rota Next resolve o vendedor pelo token assinado e chama aqui.
 *
 * Sem autenticação própria, como o resto do serviço: o PUT e o DELETE de layout
 * só devem chegar pela rota Next da intranet, que confere a permissão `editar`
 * em `/vendas` (sis_permissoes) na sessão e repassa o usuário em `x-user-id`.
 */
@Controller('paineis')
export class PaineisController {
  constructor(private readonly service: PaineisService) {}

  /** Painel do vendedor por hub; sem `vendedores` = empresa toda. Layout = catálogo + ajustes do hub. */
  @Get('vendedor')
  vendedor(
    @Query('hub') hub: string,
    @Query('vendedores') vendedores: unknown,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
  ) {
    return this.service.vendedor((hub ?? '').toUpperCase(), listaVendedores(vendedores), de, ate);
  }

  /** Grava o layout do hub: `{ itens: [{ dashcard, row, col, size_x, size_y, oculto, titulo }] }`, substitui tudo. */
  @Put('vendedor/layout')
  salvarLayout(@Query('hub') hub: string, @Body() body: unknown, @Headers('x-user-id') usuario?: string) {
    return this.service.salvarLayout((hub ?? '').toUpperCase(), body, usuario);
  }

  /** Restaurar padrão: o hub volta ao layout do catálogo. */
  @Delete('vendedor/layout')
  restaurarLayout(@Query('hub') hub: string) {
    return this.service.restaurarLayout((hub ?? '').toUpperCase());
  }
}
