import { Module } from '@nestjs/common';
import { CarteirizacaoController } from './carteirizacao.controller';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';

@Module({
  controllers: [CarteirizacaoController],
  providers: [
    CarteirizacaoService,
    CarteirizacaoSqlServerRepository,
    CarteirizacaoPrismaRepository,
  ],
})
export class CarteirizacaoModule {}
