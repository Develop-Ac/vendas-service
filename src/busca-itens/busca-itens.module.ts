import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BuscaItensController } from './busca-itens.controller';
import { BuscaItensService } from './busca-itens.service';
import { BuscaItensRepository } from './busca-itens.repository';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [HttpModule, PrismaModule],
  controllers: [BuscaItensController],
  providers: [BuscaItensService, BuscaItensRepository],
})
export class BuscaItensModule {}
