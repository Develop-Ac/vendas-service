import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrcamentoService } from './orcamento.service';

/**
 * Comparativo intranet × Celta de 30 em 30 segundos.
 *
 * Para cada orçamento já importado no Celta (tem `orcamentoCelta`) e ainda com
 * `comparado = false`, consulta `API_VENDAS_URL/comparativo/:orcamentoCelta`:
 *  - `condicional: null` → não faz nada (o condicional ainda não existe);
 *  - quantidade_sku, quantidade_unitaria, valor e ok todos true → `comparado = true`;
 *  - algum false → `sis_usuarios.orcamentoBloqueado = true` para o `vendas_rep_codigo`
 *    do orçamento (+ aviso modal à gestão quando o bloqueio muda de estado).
 *
 * Um ciclo só começa quando o anterior terminou (o Celta pode demorar mais de
 * 30 s com a fila cheia). `ORCAMENTO_COMPARATIVO_CRON=off` desliga.
 */
const EXPRESSAO = process.env.ORCAMENTO_COMPARATIVO_CRON ?? '*/30 * * * * *';
const DESLIGADO = EXPRESSAO.trim().toLowerCase() === 'off';

@Injectable()
export class OrcamentoComparativoScheduler {
  private readonly logger = new Logger(OrcamentoComparativoScheduler.name);
  private rodando = false;

  constructor(private readonly orcamentos: OrcamentoService) {}

  @Cron(DESLIGADO ? '0 0 1 1 *' : EXPRESSAO, { name: 'orcamento-comparativo', disabled: DESLIGADO })
  async ciclo() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      const r = await this.orcamentos.compararPendentes();
      // Só loga quando algo aconteceu: a cada 30 s, "nada a fazer" viraria ruído.
      if (r.comparados || r.bloqueios || r.falhas) {
        this.logger.log(
          `Comparativo: ${r.avaliados} avaliado(s) · ${r.comparados} bateram · ${r.divergentes} divergente(s) (${r.bloqueios} bloqueio(s) novo(s)) · ${r.sem_condicional} sem condicional · ${r.falhas} falha(s).`,
        );
      }
    } catch (e) {
      this.logger.error(`Ciclo do comparativo falhou: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }
}
