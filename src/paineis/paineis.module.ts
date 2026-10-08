import { Module } from '@nestjs/common';
import { MssqlService } from '../common/mssql/mssql.service';
import { CarteirizacaoModule } from '../carteirizacao/carteirizacao.module';
import { PaineisController } from './paineis.controller';
import { PaineisService } from './paineis.service';

@Module({
  imports: [CarteirizacaoModule],
  controllers: [PaineisController],
  // Pool próprio (max 10) para os painéis: as ~30 consultas de uma abertura não
  // disputam conexão com a Carteirização.
  providers: [PaineisService, MssqlService],
})
export class PaineisModule {}
