import { Module } from '@nestjs/common';
import { ErpApiModule } from './common/erp-api/erp-api.module';
import { PrometheusModule } from '@willsoto/nestjs-prometheus';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { BuscaItensModule } from './busca-itens/busca-itens.module';
import { S3Module } from './storage/s3.module';
import { EncomendaPecasModule } from './venda-casada/encomenda-pecas.module';
import { B2bModule } from './b2b/b2b.module';
import { BuscaPlacasModule } from './busca-placas/busca-placas.module';
import { CarteirizacaoModule } from './carteirizacao/carteirizacao.module';
import { MaisVendidosModule } from './mais-vendidos/mais-vendidos.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ErpApiModule,
    PrismaModule,
    BuscaItensModule,
    S3Module,
    EncomendaPecasModule,
    B2bModule,
    BuscaPlacasModule,
    CarteirizacaoModule,
    MaisVendidosModule,
    WhatsappModule,

    PrometheusModule.register({
      defaultMetrics: { enabled: true }, // CPU, memória, event loop, GC
    }),
  ], 
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
