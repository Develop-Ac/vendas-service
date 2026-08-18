import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { MssqlService } from 'src/common/mssql/mssql.service';
import { MaisVendidosController } from './mais-vendidos.controller';
import { MaisVendidosService } from './mais-vendidos.service';
import { MaisVendidosScheduler } from './mais-vendidos.scheduler';
import { MaisVendidosSqlServerRepository } from './mais-vendidos.sqlserver.repository';
import { MaisVendidosPortalRepository } from './mais-vendidos.portal.repository';

@Module({
  imports: [HttpModule, ScheduleModule.forRoot()],
  controllers: [MaisVendidosController],
  providers: [
    MaisVendidosService,
    MaisVendidosSqlServerRepository,
    MaisVendidosPortalRepository,
    MaisVendidosScheduler,
    MssqlService,
  ],
})
export class MaisVendidosModule {}
