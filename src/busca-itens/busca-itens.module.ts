import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import * as https from 'https';
import { BuscaItensController } from './busca-itens.controller';
import { BuscaItensService } from './busca-itens.service';
import { BuscaItensRepository } from './busca-itens.repository';
import { PrismaModule } from '../prisma/prisma.module';

// Os serviços internos (*.acacessorios.local) ficam atrás de um proxy que
// devolve 308 de http para https com certificado auto-assinado. Sem este agent
// o axios segue o redirect e aborta com "self-signed certificate".
const tlsInsecure = !['0', 'false', 'no'].includes(
  String(process.env.INTERNAL_TLS_INSECURE ?? '').toLowerCase(),
);

@Module({
  imports: [
    HttpModule.register({
      httpsAgent: new https.Agent({ rejectUnauthorized: !tlsInsecure }),
    }),
    PrismaModule,
  ],
  controllers: [BuscaItensController],
  providers: [BuscaItensService, BuscaItensRepository],
})
export class BuscaItensModule {}