import { Module } from '@nestjs/common';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';

@Module({
  controllers: [WhatsappController],
  providers: [WhatsappService, WhatsappRepository],
  exports: [WhatsappRepository, WhatsappService],
})
export class WhatsappModule {}
