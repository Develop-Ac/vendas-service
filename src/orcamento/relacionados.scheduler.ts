import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrcamentoService } from './orcamento.service';

/**
 * Apuração semanal dos pares "vendem juntos" do atacado (BI → Postgres).
 *
 * Segunda 04:30, depois dos mais vendidos (04:00): as duas varrem os mesmos
 * 12 meses de notas e não precisam disputar o BI. Falha é registrada e
 * engolida — a tela segue sugerindo os pares da semana passada.
 */
@Injectable()
export class RelacionadosScheduler {
  private readonly logger = new Logger(RelacionadosScheduler.name);

  constructor(private readonly service: OrcamentoService) {}

  @Cron(process.env.ORCAMENTO_RELACIONADOS_CRON ?? '30 4 * * 1', {
    name: 'orcamento-relacionados',
    timeZone: 'America/Sao_Paulo',
  })
  async semanal() {
    const meses = Number(process.env.ORCAMENTO_RELACIONADOS_MESES) || 12;
    this.logger.log(`Apurando pares "vendem juntos" do atacado (${meses} meses)...`);
    try {
      const r = await this.service.recalcularRelacionados(meses);
      this.logger.log(`Concluído: ${r.pares_apurados} pares, ${r.produtos} produtos, ${r.gravados} gravados em ${r.ms}ms.`);
    } catch (e) {
      this.logger.error(`Falha na apuração semanal: ${(e as Error).message}`, (e as Error).stack);
    }
  }
}
