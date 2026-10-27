import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrcamentoService } from './orcamento.service';
import { mesComissionalDe } from '../carteirizacao/supervisao.indicadores';

/**
 * Fechamento mensal da bolsa do atacado: no dia 26, 00:30 (Cuiabá), fecha o mês comissional que
 * terminou ontem (25) para todos os vendedores — grava o fechamento em ven_bolsa_mes e a reserva
 * como saldo inicial do mês seguinte. Mês anterior a ORCAMENTO_BOLSA_FECHAMENTO_DESDE não roda.
 * `ORCAMENTO_BOLSA_FECHAMENTO_CRON=off` desliga; a gestão reexecuta por POST /orcamento/bolsa/fechamento.
 */
const EXPRESSAO = process.env.ORCAMENTO_BOLSA_FECHAMENTO_CRON ?? '30 0 26 * *';
const DESLIGADO = EXPRESSAO.trim().toLowerCase() === 'off';

@Injectable()
export class BolsaFechamentoScheduler {
  private readonly logger = new Logger(BolsaFechamentoScheduler.name);

  constructor(private readonly orcamentos: OrcamentoService) {}

  @Cron(DESLIGADO ? '0 0 1 1 *' : EXPRESSAO, { name: 'orcamento-bolsa-fechamento', timeZone: 'America/Cuiaba', disabled: DESLIGADO })
  async mensal() {
    // ontem em Cuiabá (UTC−4, sem horário de verão)
    const ontem = new Date(Date.now() - 28 * 3_600_000).toISOString().slice(0, 10);
    const { ano, mes } = mesComissionalDe(ontem);
    const desde = this.orcamentos.fechamentoDesde();
    if (ano * 12 + mes < desde.ano * 12 + desde.mes) {
      this.logger.log(`Fechamento da bolsa ${mes}/${ano} não roda: começa em ${desde.mes}/${desde.ano}.`);
      return;
    }
    try {
      await this.orcamentos.fecharMes(ano, mes, 'agendamento');
    } catch (e) {
      this.logger.error(`Fechamento da bolsa ${mes}/${ano} falhou: ${(e as Error).message}`);
    }
  }
}
