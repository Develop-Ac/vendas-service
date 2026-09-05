import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';

/**
 * Orçamentos ENVIADOS que vencem AMANHÃ sem venda nem desfecho → aviso
 * `vendas.orcamento.vencendo` ao vendedor (balão na Estação, link já abre a
 * conversa com o orçamento). Roda de manhã, seg–sáb; `ref` = id do orçamento,
 * então rodar duas vezes não duplica.
 */
@Injectable()
export class OrcamentoVencendoScheduler {
  private readonly logger = new Logger(OrcamentoVencendoScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisosVendas: AvisosVendasService,
  ) {}

  @Cron(process.env.ORCAMENTO_VENCENDO_CRON ?? '0 8 * * 1-6', { name: 'orcamento-vencendo', timeZone: 'America/Cuiaba' })
  async diario() {
    try {
      // `validade` é DATE (00:00 UTC no Prisma): compara por dia em UTC.
      const hoje = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
      const amanha = new Date(`${hoje}T00:00:00Z`);
      amanha.setUTCDate(amanha.getUTCDate() + 1);
      const depois = new Date(amanha);
      depois.setUTCDate(depois.getUTCDate() + 1);
      const lista = await this.prisma.ven_orcamento.findMany({
        where: { status: 'ENVIADO', validade: { gte: amanha, lt: depois } },
        select: { id: true, numero: true, cli_codigo: true, cli_nome: true, rep_codigo: true, usuario_id: true, total: true },
      });
      for (const o of lista) await this.avisosVendas.orcamentoVencendo(o);
      if (lista.length) this.logger.log(`${lista.length} orçamento(s) vencendo amanhã avisados.`);
    } catch (e) {
      this.logger.error(`Aviso de orçamento vencendo falhou: ${(e as Error).message}`);
    }
  }
}
