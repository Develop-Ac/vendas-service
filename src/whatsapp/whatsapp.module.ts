import { Module } from '@nestjs/common';
import { S3Module } from '../storage/s3.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';

@Module({
  imports: [S3Module],
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappRepository],
  exports: [WhatsappRepository, WhatsappService],
})
export class WhatsappModule {}
