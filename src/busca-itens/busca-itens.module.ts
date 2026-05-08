import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BuscaItensController } from './busca-itens.controller';
import { BuscaItensService } from './busca-itens.service';

@Module({
  imports: [HttpModule],
  controllers: [BuscaItensController],
  providers: [BuscaItensService],
})
export class BuscaItensModule {}
