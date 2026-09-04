import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { MssqlService } from '../common/mssql/mssql.service';
import { OrcamentoController } from './orcamento.controller';
import { OrcamentoService } from './orcamento.service';
import { OrcamentoErpRepository } from './orcamento.erp.repository';
import { OrcamentoBiRepository } from './orcamento.bi.repository';
import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';
import { RelacionadosScheduler } from './relacionados.scheduler';
import { OrcamentoVencendoScheduler } from './vencendo.scheduler';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';

/**
 * Orçamento do Atacado — a tela de proposta do vendedor com a régua v3 embutida.
 * ErpApiService e PrismaService chegam dos módulos globais; o MssqlService é
 * provido aqui como nos demais módulos que leem o BI.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [OrcamentoController],
  providers: [
    OrcamentoVencendoScheduler,
    AvisosVendasService,
    OrcamentoService,
    OrcamentoErpRepository,
    OrcamentoBiRepository,
    OrcamentoPrismaRepository,
    RelacionadosScheduler,
    MssqlService,
  ],
  exports: [OrcamentoService],
})
export class OrcamentoModule {}
