import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MaisVendidosService } from './mais-vendidos.service';

/**
 * Carga semanal dos mais vendidos do atacado para a home do Portal B2B.
 *
 * Segunda-feira às 04:00, antes do expediente: a apuração varre 12 meses de
 * notas e é a consulta mais pesada deste serviço. Horário configurável por
 * `MAIS_VENDIDOS_CRON`.
 *
 * A falha é registrada e engolida. Se a carga não for, o portal continua
 * servindo o ranking da semana passada — velho é melhor que vazio, e uma
 * exceção solta aqui derruba o processo do serviço inteiro.
 */
@Injectable()
export class MaisVendidosScheduler {
  private readonly logger = new Logger(MaisVendidosScheduler.name);

  constructor(private readonly service: MaisVendidosService) {}

  @Cron(process.env.MAIS_VENDIDOS_CRON ?? '0 4 * * 1', {
    name: 'mais-vendidos-sync',
    timeZone: 'America/Sao_Paulo',
  })
  async cargaSemanal() {
    this.logger.log('Apurando os mais vendidos do atacado (BI → Portal B2B)...');
    try {
      const r = await this.service.sincronizar();
      this.logger.log(
        `Carga concluída: ${r.apurados} apurados por "${r.criterio}" ` +
          `(${r.meses} meses), ${r.gravados} gravados no portal.`,
      );
    } catch (e) {
      this.logger.error(
        `Falha na carga semanal dos mais vendidos: ${(e as Error).message}`,
        (e as Error).stack,
      );
    }
  }
}
