import { Controller, Post } from '@nestjs/common';
import {
  MaisVendidosService,
  ResultadoSincronizacao,
} from './mais-vendidos.service';

@Controller('mais-vendidos')
export class MaisVendidosController {
  constructor(private readonly service: MaisVendidosService) {}

  /**
   * Dispara a carga fora do horário do agendador.
   *
   * Existe para a **primeira** carga — a vitrine do portal só aparece depois
   * dela — e para refazer o ranking sem esperar a próxima segunda-feira.
   */
  @Post('sincronizar')
  sincronizar(): Promise<ResultadoSincronizacao> {
    return this.service.sincronizar();
  }
}
