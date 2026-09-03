import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { CarteirizacaoController } from './carteirizacao.controller';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { CarteirizacaoSyncScheduler } from './carteirizacao.sync.scheduler';
import { FilaService } from './fila.service';
import { ResgateService } from './resgate.service';
import { MssqlService } from 'src/common/mssql/mssql.service';
 
@Module({
  imports: [ScheduleModule.forRoot(), WhatsappModule],
  controllers: [CarteirizacaoController],
  providers: [
    CarteirizacaoService,
    CarteirizacaoSqlServerRepository,
    CarteirizacaoErpRepository,
    CarteirizacaoPrismaRepository,
    CarteirizacaoSyncScheduler,
    FilaService,
    ResgateService,
    MssqlService
  ],
})
export class CarteirizacaoModule {}
