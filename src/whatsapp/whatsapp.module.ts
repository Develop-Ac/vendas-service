import { Module } from '@nestjs/common';
import { S3Module } from '../storage/s3.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';
import { SessoesService } from './sessoes.service';
import { SessoesController } from './sessoes.controller';

@Module({
  imports: [S3Module],
  controllers: [WhatsappController, SessoesController],
  providers: [WhatsappService, WhatsappRepository, SessoesService],
  exports: [WhatsappRepository, WhatsappService, SessoesService],
})
export class WhatsappModule {}
