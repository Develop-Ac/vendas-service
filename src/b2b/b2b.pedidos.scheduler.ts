import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { B2bService } from './b2b.service';

/**
 * Busca dos pedidos do portal B2B a cada minuto. O portal não alcança a
 * intranet, então sem esta leitura o pedido só entrava quando alguém abria a
 * tela B2B. Horário por `B2B_PEDIDOS_CRON` (padrão: todo minuto).
 *
 * Uma rodada por vez: se a anterior ainda não terminou (portal lento), esta
 * é pulada em vez de empilhar leituras.
 */
@Injectable()
export class B2bPedidosScheduler {
  private readonly logger = new Logger(B2bPedidosScheduler.name);
  private rodando = false;

  constructor(private readonly b2b: B2bService) {}

  @Cron(process.env.B2B_PEDIDOS_CRON ?? '* * * * *', {
    name: 'b2b-pedidos-portal',
    timeZone: 'America/Sao_Paulo',
  })
  async buscar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      await this.b2b.sincronizarComPortal();
    } catch (e) {
      this.logger.error(
        `Falha na busca de pedidos do portal B2B: ${(e as Error).message}`,
      );
    } finally {
      this.rodando = false;
    }
  }
}
