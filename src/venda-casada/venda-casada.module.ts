import { Module } from '@nestjs/common';
import { VendaCasadaController } from './venda-casada.controller';
import { VendaCasadaService } from './venda-casada.service';
import { VendaCasadaRepository } from './venda-casada.repository';
import { VendaCasadaFornecedoresRepository } from './venda-casada.fornecedores.repository';
import { MssqlService } from '../common/mssql/mssql.service';
import { S3Module } from '../storage/s3.module';

@Module({
  imports: [
    S3Module,
  ],
  controllers: [VendaCasadaController],
  providers: [
    VendaCasadaService,
    VendaCasadaRepository,
    VendaCasadaFornecedoresRepository,
    MssqlService,
  ],
})
export class VendaCasadaModule {}
