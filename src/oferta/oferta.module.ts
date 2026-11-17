import { Module } from '@nestjs/common';
import { OrcamentoModule } from '../orcamento/orcamento.module';
import { EncomendaPecasErpRepository } from '../venda-casada/encomenda-pecas.erp.repository';
import { OfertaController } from './oferta.controller';
import { OfertaService } from './oferta.service';
import { OfertaRepository } from './oferta.repository';

/**
 * Ofertas do atacado (promoção e liquidação cadastradas na intranet).
 * Usa o OrcamentoService para custo, tabelas e mínimo da régua; PrismaService é global.
 * EncomendaPecasErpRepository (fornecedor da campanha) só depende do ErpApiService, também global.
 */
@Module({
  imports: [OrcamentoModule],
  controllers: [OfertaController],
  providers: [OfertaService, OfertaRepository, EncomendaPecasErpRepository],
})
export class OfertaModule {}
