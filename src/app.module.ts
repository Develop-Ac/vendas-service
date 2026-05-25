import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { BuscaItensModule } from './busca-itens/busca-itens.module';
import { S3Module } from './storage/s3.module';
import { VendaCasadaModule } from './venda-casada/venda-casada.module';

@Module({
  imports: [
    PrismaModule,
    BuscaItensModule,
    S3Module,
    VendaCasadaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
