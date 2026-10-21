import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { B2bCarteiraService } from './b2b.carteira.service';

/**
 * Envio diário da carteira ao portal B2B, depois da carga da carteirização
 * (05:00): a troca de vendedor do dia chega ao portal na mesma manhã.
 * Horário configurável por `B2B_CARTEIRA_PORTAL_CRON` (padrão 05:45).
 */
@Injectable()
export class B2bCarteiraScheduler {
  private readonly logger = new Logger(B2bCarteiraScheduler.name);

  constructor(private readonly carteira: B2bCarteiraService) {}

  @Cron(process.env.B2B_CARTEIRA_PORTAL_CRON ?? '45 5 * * *', {
    name: 'b2b-carteira-portal',
    timeZone: 'America/Sao_Paulo',
  })
  async enviar() {
    try {
      await this.carteira.enviarTudo();
    } catch (e) {
      this.logger.error(
        `Falha no envio da carteira ao portal B2B: ${(e as Error).message}`,
      );
    }
  }
}
