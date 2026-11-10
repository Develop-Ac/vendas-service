import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GestaoService } from './gestao.service';
import { mesComissionalDe } from './supervisao.indicadores';

/**
 * Fechamento mensal da gestão do atacado: no dia 26, 00:40 (Cuiabá), grava a foto do mês
 * comissional que terminou ontem (25) em ven_atacado_fechamento. Roda depois do fechamento
 * da bolsa (00:30). `GESTAO_ATACADO_FECHAMENTO_CRON=off` desliga; a gerência reapura por
 * POST /carteirizacao/gestao/fechamento.
 */
const EXPRESSAO = process.env.GESTAO_ATACADO_FECHAMENTO_CRON ?? '40 0 26 * *';
const DESLIGADO = EXPRESSAO.trim().toLowerCase() === 'off';

@Injectable()
export class GestaoFechamentoScheduler {
  private readonly logger = new Logger(GestaoFechamentoScheduler.name);

  constructor(private readonly gestao: GestaoService) {}

  @Cron(DESLIGADO ? '0 0 1 1 *' : EXPRESSAO, { name: 'gestao-atacado-fechamento', timeZone: 'America/Cuiaba', disabled: DESLIGADO })
  async mensal() {
    // ontem em Cuiabá (UTC−4, sem horário de verão)
    const ontem = new Date(Date.now() - 28 * 3_600_000).toISOString().slice(0, 10);
    const { ano, mes } = mesComissionalDe(ontem);
    try {
      await this.gestao.fechar(ano, mes, 'agendamento');
      this.logger.log(`Fechamento da gestão do atacado ${mes}/${ano} gravado.`);
    } catch (e) {
      this.logger.error(`Fechamento da gestão do atacado ${mes}/${ano} falhou: ${(e as Error).message}`);
    }
  }
}
