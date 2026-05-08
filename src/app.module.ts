import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { BuscaItensModule } from './busca-itens/busca-itens.module';

@Module({
  imports: [
    PrismaModule,
    BuscaItensModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
