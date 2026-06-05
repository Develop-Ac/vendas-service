import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { B2bController } from './b2b.controller';
import { B2bService } from './b2b.service';
import { B2bRepository } from './b2b.repository';

@Module({
  imports: [HttpModule],
  controllers: [B2bController],
  providers: [B2bService, B2bRepository],
})
export class B2bModule {}
