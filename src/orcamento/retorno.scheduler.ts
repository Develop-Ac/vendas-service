import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { hojeRetorno } from './orcamento.prisma.repository';

/**
 * Orçamentos ADIADOS cuja data de retorno é HOJE (dia de Cuiabá) → aviso
 * `vendas.orcamento.retorno` ao vendedor (ou ao substituto da cobertura da fila).
 * Roda de manhã, todo dia; `ref` = id do orçamento, então rodar duas vezes não duplica.
 */
@Injectable()
export class OrcamentoRetornoScheduler {
  private readonly logger = new Logger(OrcamentoRetornoScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisosVendas: AvisosVendasService,
  ) {}

  @Cron(process.env.ORCAMENTO_RETORNO_CRON ?? '0 8 * * *', { name: 'orcamento-retorno', timeZone: 'America/Cuiaba' })
  async diario() {
    try {
      const lista = await this.prisma.ven_orcamento.findMany({
        where: { status: 'ADIADO', retorno_em: hojeRetorno() },
        select: { id: true, numero: true, cli_codigo: true, cli_nome: true, rep_codigo: true, usuario_id: true, total: true },
      });
      for (const o of lista) await this.avisosVendas.orcamentoRetorno(o);
      if (lista.length) this.logger.log(`${lista.length} orçamento(s) com retorno hoje avisados.`);
    } catch (e) {
      this.logger.error(`Aviso de retorno de orçamento falhou: ${(e as Error).message}`);
    }
  }
}
