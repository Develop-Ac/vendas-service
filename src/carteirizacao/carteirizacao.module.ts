import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CarteirizacaoController } from './carteirizacao.controller';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { CarteirizacaoSyncScheduler } from './carteirizacao.sync.scheduler';
import { FilaService } from './fila.service';
import { MssqlService } from 'src/common/mssql/mssql.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [CarteirizacaoController],
  providers: [
    CarteirizacaoService,
    CarteirizacaoSqlServerRepository,
    CarteirizacaoErpRepository,
    CarteirizacaoPrismaRepository,
    CarteirizacaoSyncScheduler,
    FilaService,
    MssqlService
  ],
})
export class CarteirizacaoModule {}
