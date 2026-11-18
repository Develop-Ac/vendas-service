import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, Post, Put, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { SoPeloProxy } from '../common/so-pelo-proxy.guard';
import { OfertaService } from './oferta.service';
import { AlterarItemOfertaDto, AlterarPremioDto, CriarOfertaDto, FonteOfertaDto, IncluirItensOfertaDto, ItensDoFluxoDto, PreviaMarcaOfertaDto, RenomearOfertaDto, ReplicarDatasOfertaDto } from './dto/oferta.dto';

/* =============================================================================
   OFERTAS DO ATACADO — rotas. Quem age vem do `x-user-id` que o proxy da intranet repassa
   (conferido por SoPeloProxy: chamada direta ao serviço é recusada).
   ============================================================================= */

@ApiTags('Ofertas do Atacado')
@Controller('oferta')
@UseGuards(SoPeloProxy)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class OfertaController {
  constructor(private readonly service: OfertaService) {}

  @Get()
  @ApiOperation({ summary: 'Grupos de oferta com itens por situação, período e vendido.' })
  @ApiQuery({ name: 'situacao', required: false, enum: ['ativos', 'encerrados'] })
  listar(@Query('situacao') situacao?: string, @Headers('x-user-id') usuario?: string) {
    return this.service.listar(usuario, situacao === 'encerrados' ? 'encerrados' : 'ativos');
  }

  @Post()
  @ApiOperation({ summary: 'Cria um grupo (promoção, liquidação ou campanha com origem e prêmio), já com itens se vierem.' })
  criar(@Body() dto: CriarOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.criar(usuario, dto);
  }

  // 'fonte' e 'ganhos' antes das rotas :id (ParseIntPipe recusaria)
  @Get('fonte')
  @ApiOperation({ summary: 'De onde o orçamento do atacado lê a promoção: Celta (padrão) ou só as ofertas da intranet.' })
  fonte(@Headers('x-user-id') usuario?: string) {
    return this.service.fonte(usuario);
  }

  @Put('fonte')
  @ApiOperation({ summary: 'Troca a fonte da promoção do atacado (vale na hora, para todos); exige /estoque/promocoes/aprovar.' })
  definirFonte(@Body() dto: FonteOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.definirFonte(usuario, dto.intranet);
  }

  @Get('ganhos')
  @ApiOperation({ summary: 'Ganhos do mês comissional: bônus de liquidação e prêmios de campanha por vendedor e o que cobrar dos fornecedores; exige /estoque/promocoes/ganhos.' })
  @ApiQuery({ name: 'mes', required: false, description: 'AAAA-MM do mês comissional (26 a 25); ausente = o corrente.' })
  ganhos(@Query('mes') mes?: string, @Headers('x-user-id') usuario?: string) {
    return this.service.ganhos(usuario, mes);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Grupo com os itens: custo, saldo, tabelas, mínimos, vendidas, restam e conferências.' })
  detalhe(@Param('id', ParseIntPipe) id: number, @Headers('x-user-id') usuario?: string) {
    return this.service.detalhe(usuario, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Renomeia o grupo.' })
  renomear(@Param('id', ParseIntPipe) id: number, @Body() dto: RenomearOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.renomear(usuario, id, dto.nome);
  }

  @Get(':id/resultado')
  @ApiOperation({ summary: 'Faturado por item e, com /estoque/promocoes/ganhos, o ganho de cada vendedor no grupo (promoção: vendedores null).' })
  resultado(@Param('id', ParseIntPipe) id: number, @Headers('x-user-id') usuario?: string) {
    return this.service.resultado(usuario, id);
  }

  @Put(':id/premio')
  @ApiOperation({ summary: 'Troca o prêmio da campanha (liquidação e promoção recebem 400; o bônus da liquidação é do item); exige /estoque/promocoes/aprovar; recusa se já há venda faturada.' })
  alterarPremio(@Param('id', ParseIntPipe) id: number, @Body() dto: AlterarPremioDto, @Headers('x-user-id') usuario?: string) {
    return this.service.alterarPremio(usuario, id, dto);
  }

  @Post(':id/itens')
  @ApiOperation({ summary: 'Inclui itens por código ou pela lista da sugestão; devolve o grupo e os recusados com o motivo.' })
  incluirItens(@Param('id', ParseIntPipe) id: number, @Body() dto: IncluirItensOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.incluirItens(usuario, id, dto.itens);
  }

  @Post(':id/marca')
  @ApiOperation({ summary: 'Prévia da campanha por marca (desconto nas tabelas 2 e 5, limitado ao mínimo); não grava — confirmar por POST :id/itens.' })
  previaMarca(@Param('id', ParseIntPipe) id: number, @Body() dto: PreviaMarcaOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.previaMarca(usuario, id, dto);
  }

  @Put('item/:itemId')
  @ApiOperation({ summary: 'Altera preço, datas ou limite do item; aprovado que muda volta a pendente.' })
  alterarItem(@Param('itemId', ParseIntPipe) itemId: number, @Body() dto: AlterarItemOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.alterarItem(usuario, itemId, dto);
  }

  @Delete('item/:itemId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove o item (só em rascunho).' })
  async removerItem(@Param('itemId', ParseIntPipe) itemId: number, @Headers('x-user-id') usuario?: string) {
    await this.service.removerItem(usuario, itemId);
  }

  @Post(':id/replicar-datas')
  @ApiOperation({ summary: 'Copia início e fim de um item para todos os não encerrados do grupo.' })
  replicarDatas(@Param('id', ParseIntPipe) id: number, @Body() dto: ReplicarDatasOfertaDto, @Headers('x-user-id') usuario?: string) {
    return this.service.replicarDatas(usuario, id, dto.item_id);
  }

  @Post(':id/enviar')
  @ApiOperation({ summary: 'Envia para aprovação (rascunho → pendente) os itens informados ou o grupo todo; devolve os recusados.' })
  enviar(@Param('id', ParseIntPipe) id: number, @Body() dto: ItensDoFluxoDto, @Headers('x-user-id') usuario?: string) {
    return this.service.enviar(usuario, id, dto.itens);
  }

  @Post(':id/aprovar')
  @ApiOperation({ summary: 'Aprova (pendente → aprovado) os itens informados ou o grupo todo; exige /estoque/promocoes/aprovar.' })
  aprovar(@Param('id', ParseIntPipe) id: number, @Body() dto: ItensDoFluxoDto, @Headers('x-user-id') usuario?: string) {
    return this.service.aprovar(usuario, id, dto.itens);
  }

  @Post(':id/encerrar')
  @ApiOperation({ summary: 'Encerra (motivo MANUAL) os itens informados ou o grupo todo; exige /estoque/promocoes/aprovar.' })
  encerrar(@Param('id', ParseIntPipe) id: number, @Body() dto: ItensDoFluxoDto, @Headers('x-user-id') usuario?: string) {
    return this.service.encerrar(usuario, id, dto.itens);
  }
}
