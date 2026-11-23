import { Module } from '@nestjs/common';
import { S3Module } from '../storage/s3.module';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';
import { SessoesService } from './sessoes.service';
import { SessoesController } from './sessoes.controller';
import { ReconexaoService } from './reconexao.service';
import { MinhaSessaoController } from './minha-sessao.controller';
import { AssistenteService } from './assistente.service';
import { AssistenteController } from './assistente.controller';

@Module({
  imports: [S3Module],
  controllers: [WhatsappController, SessoesController, MinhaSessaoController, AssistenteController],
  providers: [WhatsappService, WhatsappRepository, SessoesService, ReconexaoService, AssistenteService],
  exports: [WhatsappRepository, WhatsappService, SessoesService],
})
export class WhatsappModule {}
