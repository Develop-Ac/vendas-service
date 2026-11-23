import { Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import { AssistenteService } from './assistente.service';
import { SoPeloProxy } from '../common/so-pelo-proxy.guard';

/**
 * Bloco Assistente da tela /sistema/whatsapp: estado do runner lido pelo monitor,
 * reiniciar e buscar mensagens perdidas. Permissão da tela de sessões (visualizar
 * para ler, editar para agir); quem age vem do `x-user-id` do proxy.
 */
@Controller('whatsapp/assistente')
@UseGuards(SoPeloProxy)
export class AssistenteController {
  constructor(private readonly service: AssistenteService) {}

  @Get()
  ler(@Headers('x-user-id') usuario?: string) {
    return this.service.ler(usuario);
  }

  @Post('reiniciar')
  reiniciar(@Headers('x-user-id') usuario?: string) {
    return this.service.reiniciar(usuario);
  }

  @Post('resgatar')
  resgatar(@Headers('x-user-id') usuario?: string) {
    return this.service.resgatar(usuario);
  }
}
