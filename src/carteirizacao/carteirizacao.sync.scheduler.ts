import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CarteirizacaoService } from './carteirizacao.service';

/**
 * Carga diária automática da carteirização: reconcilia o overlay com o ERP
 * (fonte da verdade), aplicando trocas de vendedor, novos clientes e marcando
 * para revisão quem saiu do atacado. Horário configurável por
 * `CARTEIRIZACAO_SYNC_CRON` (padrão: 05:00 todos os dias).
 */
@Injectable()
export class CarteirizacaoSyncScheduler {
  private readonly logger = new Logger(CarteirizacaoSyncScheduler.name);

  constructor(private readonly service: CarteirizacaoService) {}

  @Cron(process.env.CARTEIRIZACAO_SYNC_CRON ?? '0 5 * * *', {
    name: 'carteirizacao-sync',
    timeZone: 'America/Sao_Paulo',
  })
  async cargaDiaria() {
    this.logger.log('Iniciando carga diária da carteirização (ERP → overlay)...');
    try {
      const r = await this.service.sincronizar({
        usuario_nome: 'SISTEMA (carga diária)',
      });
      this.logger.log(
        `Carga concluída (lote ${('lote_id' in r && r.lote_id) || '-'}): ` +
          `${r.novos} novos, ${r.alterados} alterados, ${r.sem_vendedor} sem vendedor, ` +
          `${r.revisao} p/ revisão.`,
      );
    } catch (e) {
      this.logger.error(
        `Falha na carga diária da carteirização: ${(e as Error).message}`,
        (e as Error).stack,
      );
    }
  }
}
