import { Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ReconexaoService } from './reconexao.service';
import { SoPeloProxy } from '../common/so-pelo-proxy.guard';

/**
 * Aviso de reconexão do WhatsApp para o usuário da intranet dono da sessão
 * (ven_wa_sessao.usuario_codigo). Sem permissão de tela: o dono é conferido pelo
 * `x-user-id` que o proxy da intranet injeta (SoPeloProxy); sessão alheia = 404.
 */
@Controller('whatsapp/minha-sessao')
@UseGuards(SoPeloProxy)
export class MinhaSessaoController {
  constructor(private readonly service: ReconexaoService) {}

  @Get('pendentes')
  pendentes(@Headers('x-user-id') usuario?: string) {
    return this.service.pendentes(usuario);
  }

  @Post(':sessao/reconectar')
  reconectar(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.reconectar(usuario, sessao);
  }

  @Get(':sessao/qr')
  qr(@Param('sessao') sessao: string, @Headers('x-user-id') usuario?: string) {
    return this.service.qr(usuario, sessao);
  }
}
