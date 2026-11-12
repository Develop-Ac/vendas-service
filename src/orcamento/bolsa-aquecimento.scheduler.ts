import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrcamentoService } from './orcamento.service';

/**
 * Aquecimento da bolsa do atacado: a cada 4 minutos, das 7h às 19h de segunda a sábado (Cuiabá),
 * recalcula em segundo plano o casamento dos orçamentos FECHADOS com as NFs e os ajustes (janela
 * de 2 meses do card/extrato e de CASAMENTO_MESES da lista) de cada vendedor com orçamento
 * FECHADO na janela, um vendedor por vez. Uma rodada não começa enquanto a anterior não terminou.
 * `ORCAMENTO_BOLSA_AQUECIMENTO_CRON=off` desliga; fora do horário a primeira leitura calcula na hora.
 */
const EXPRESSAO = process.env.ORCAMENTO_BOLSA_AQUECIMENTO_CRON ?? '*/4 7-19 * * 1-6';
const DESLIGADO = EXPRESSAO.trim().toLowerCase() === 'off';

@Injectable()
export class BolsaAquecimentoScheduler {
  private readonly logger = new Logger(BolsaAquecimentoScheduler.name);
  private rodando = false;

  constructor(private readonly orcamentos: OrcamentoService) {}

  @Cron(DESLIGADO ? '0 0 1 1 *' : EXPRESSAO, { name: 'orcamento-bolsa-aquecimento', timeZone: 'America/Cuiaba', disabled: DESLIGADO })
  async aquecer() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const r = await this.orcamentos.aquecerBolsa();
      const limite = this.orcamentos.parametros().log_lento_ms;
      const lentos = limite > 0 ? r.lentos.filter((l) => l.ms > limite) : [];
      const resumo = `Aquecimento da bolsa: ${r.vendedores} vendedores, ${r.falhas} falhas, ${r.ms}ms`;
      if (lentos.length) this.logger.warn(`${resumo} · lentos: ${lentos.map((l) => `rep ${l.rep} ${l.ms}ms`).join(', ')}`);
      else this.logger.log(resumo);
    } catch (e) {
      this.logger.error(`Aquecimento da bolsa falhou: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
