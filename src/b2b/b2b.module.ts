import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { OrcamentoModule } from '../orcamento/orcamento.module';
import { B2bController, B2bEmpresasController } from './b2b.controller';
import { B2bService } from './b2b.service';
import { B2bRepository } from './b2b.repository';
import { B2bPrismaRepository } from './b2b.prisma.repository';

@Module({
  imports: [HttpModule, OrcamentoModule],
  controllers: [B2bController, B2bEmpresasController],
  providers: [B2bService, B2bRepository, B2bPrismaRepository],
})
export class B2bModule {}
