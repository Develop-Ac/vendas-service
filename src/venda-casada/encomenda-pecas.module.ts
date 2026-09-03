import { Module } from '@nestjs/common';
import { EncomendaPecasController } from './encomenda-pecas.controller';
import { EncomendaPecasService } from './encomenda-pecas.service';
import { EncomendaPecasRepository } from './encomenda-pecas.repository';
import { EncomendaPecasFornecedoresRepository } from './encomenda-pecas.fornecedores.repository';
import { EncomendaPecasErpRepository } from './encomenda-pecas.erp.repository';
import { MssqlService } from '../common/mssql/mssql.service';
import { S3Module } from '../storage/s3.module';

@Module({
  imports: [
    S3Module,
  ],
  controllers: [EncomendaPecasController],
  providers: [
    EncomendaPecasService,
    EncomendaPecasRepository,
    EncomendaPecasFornecedoresRepository,
    EncomendaPecasErpRepository,
    MssqlService,
  ],
})
export class EncomendaPecasModule {}
