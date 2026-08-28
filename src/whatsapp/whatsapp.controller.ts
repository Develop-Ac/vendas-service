import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';

/**
 * Rotas do sensor WhatsApp (piloto WAHA). O webhook aceita o token compartilhado
 * em `x-webhook-token` quando WA_WEBHOOK_TOKEN está definido — configure o mesmo
 * valor nos customHeaders do webhook no WAHA. Sem a variável, o endpoint aceita
 * qualquer chamada (rede interna) — defina o token antes de generalizar.
 */
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly service: WhatsappService) {}

  @Post('webhook')
  webhook(@Body() body: any, @Headers('x-webhook-token') token?: string) {
    const esperado = process.env.WA_WEBHOOK_TOKEN;
    if (esperado && token !== esperado) {
      throw new UnauthorizedException('Token do webhook inválido.');
    }
    return this.service.processarWebhook(body ?? {});
  }

  // Semente do vínculo telefone->cliente a partir do cadastro do ERP (idempotente).
  @Post('contatos/seed')
  seed() {
    return this.service.seedContatos();
  }

  // Fila de vínculo: números que conversaram e ainda não têm cliente.
  @Get('contatos/pendentes')
  pendentes(@Query('limite') limite?: string) {
    const n = Number(limite);
    return this.service.pendentes(Number.isFinite(n) && n > 0 ? n : undefined);
  }

  // 1 toque que aprende para sempre (corrige o histórico da chave junto).
  @Post('contatos/vincular')
  vincular(
    @Body()
    dto: { telefone: string; cli_codigo: number; cli_nome?: string; usuario_nome?: string },
  ) {
    return this.service.vincular(dto ?? ({} as any));
  }

  // As medições que o piloto valida: taxa de casamento e atividade por sessão.
  @Get('medicoes')
  medicoes() {
    return this.service.medicoes();
  }

  // A conversa em pauta da sessão do vendedor — o cabeçalho da estação segue
  // o WhatsApp por aqui (polling leve; nulo sem sensor/mensagens).
  @Get('conversa-ativa')
  conversaAtiva(@Query('rep') rep?: string) {
    const n = Number(rep);
    if (!Number.isInteger(n)) return null;
    return this.service.conversaAtiva(n);
  }
}
