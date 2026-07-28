import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { VendaCasadaController } from './venda-casada.controller';
import { VendaCasadaService } from './venda-casada.service';
import { VendaCasadaRepository } from './venda-casada.repository';
import { VendaCasadaFornecedoresRepository } from './venda-casada.fornecedores.repository';
import { MssqlService } from '../common/mssql/mssql.service';
import { S3Module } from '../storage/s3.module';

@Module({
  imports: [
    S3Module,
    MulterModule.register({ storage: memoryStorage() }),
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
