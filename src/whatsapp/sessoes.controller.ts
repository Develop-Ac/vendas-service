import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessoesService } from './sessoes.service';

/**
 * Só aceita chamada que passou pelo proxy da intranet: header `x-app-token` igual ao
 * APP_TOKEN deste serviço (o proxy manda o VENDAS_SERVICE_TOKEN). Sem isso o
 * `x-user-id` seria de quem chamasse o serviço direto. APP_TOKEN vazio = tudo recusado.
 */
class SoPeloProxy implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const esperado = process.env.APP_TOKEN;
    const token = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>().headers['x-app-token'];
    if (!esperado || token !== esperado) throw new ForbiddenException('Sessões do WhatsApp só pela intranet.');
    return true;
  }
}

/**
 * Tela /sistema/whatsapp: sessões do WAHA por instância, eventos, QR de pareamento,
 * nova sessão, reiniciar/deslogar e troca de vendedor. Quem age vem do `x-user-id`
 * que o proxy da intranet injeta (conferido por SoPeloProxy); a permissão é a da tela
 * em sis_permissoes (visualizar para ler, editar para agir).
 */
@Controller('whatsapp/sessoes')
@UseGuards(SoPeloProxy)
export class SessoesController {
  constructor(private readonly service: SessoesService) {}

  @Get()
  listar(@Headers('x-user-id') usuario?: string) {
    return this.service.listar(usuario);
  }

  @Post()
  criar(
    @Body() dto: { apelido?: string; rep_codigo?: number | null; rep_nome?: string | null; guarda_corpo?: boolean },
    @Headers('x-user-id') usuario?: string,
  ) {
    return this.service.criar(usuario, dto ?? {});
  }

  @Get(':sessao/eventos')
  eventos(@Param('sessao') sessao: string, @Query('limite') limite?: string, @Headers('x-user-id') usuario?: string) {
    return this.service.eventos(usuario, sessao, Number(limite) || 50);
  }

  @Get(':sessao/qr')
  qr(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.qr(usuario, sessao);
  }

  @Put(':sessao')
  editar(
    @Param('sessao') sessao: string,
    @Body() dto: { apelido?: string; guarda_corpo?: boolean },
    @Headers('x-user-id') usuario?: string,
  ) {
    return this.service.editar(usuario, sessao, dto ?? {});
  }

  @Post(':sessao/reiniciar')
  reiniciar(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.acao(usuario, sessao, 'restart');
  }

  @Post(':sessao/logout')
  logout(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.acao(usuario, sessao, 'logout');
  }

  @Get(':sessao/transferiveis')
  transferiveis(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.transferiveis(usuario, sessao);
  }

  @Post(':sessao/vendedor')
  trocarVendedor(
    @Param('sessao') sessao: string,
    @Body() dto: { rep_codigo?: number | null; rep_nome?: string | null; desde?: string; transferir_tarefas?: boolean },
    @Headers('x-user-id') usuario?: string,
  ) {
    return this.service.trocarVendedor(usuario, sessao, dto ?? {});
  }
}
