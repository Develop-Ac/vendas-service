import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BuscaPlacasController } from './busca-placas.controller';
import { BuscaPlacasService } from './busca-placas.service';

@Module({
  imports: [HttpModule],
  controllers: [BuscaPlacasController],
  providers: [BuscaPlacasService],
})
export class BuscaPlacasModule {}
