import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CarteirizacaoController } from './carteirizacao.controller';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSyncScheduler } from './carteirizacao.sync.scheduler';
import { MssqlService } from 'src/common/mssql/mssql.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [CarteirizacaoController],
  providers: [
    CarteirizacaoService,
    CarteirizacaoSqlServerRepository,
    CarteirizacaoPrismaRepository,
    CarteirizacaoSyncScheduler,
    MssqlService
  ],
})
export class CarteirizacaoModule {}
