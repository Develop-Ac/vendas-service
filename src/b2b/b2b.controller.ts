import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { B2bCarteiraService } from './b2b.carteira.service';
import { B2bService } from './b2b.service';

class PedidoItemResumoDto {
  @ApiProperty({ example: '47941' }) pro_codigo!: string;
  @ApiProperty({ example: 1 }) quantidade!: number;
  @ApiProperty({
    example: 12.5,
    nullable: true,
    description:
      'Preço unitário que o comprador viu ao cotar, SEM a margem dele (a margem é da loja cliente). `null` quando ele não viu preço.',
  })
  preco_unitario!: number | null;
}

class PedidoUsuarioResumoDto {
  @ApiProperty({ example: '35cd4939-297b-4ec8-85b6-b3351de36f73' }) id!: string;
  @ApiProperty({ example: 'João Comprador' }) nome!: string;
  @ApiProperty({ example: '(11) 98888-8888' }) phone!: string;
  @ApiProperty({ example: 'Barrada' }) carteira!: string;
  @ApiProperty({ example: 'Auto Peças Exemplo' }) company!: string;
}

class ResponsavelPedidoDto {
  @ApiProperty({ example: 123 }) rep_codigo!: number;
  @ApiProperty({ example: 'Fulano', nullable: true }) rep_nome!: string | null;
  @ApiProperty({
    enum: ['CARTEIRA', 'PEDIDO'],
    description:
      '`CARTEIRA` = vendedor do cliente na carteirização; `PEDIDO` = atribuído pela gestão só a este pedido.',
  })
  origem!: 'CARTEIRA' | 'PEDIDO';
}

class PedidoResumoDto {
  @ApiProperty({ example: 'ORD-1780402551844' }) orderNumber!: string;
  @ApiProperty({ example: '2026-06-02T12:15:51.846Z' }) createdAt!: string;
  @ApiProperty({ type: [PedidoItemResumoDto] }) items!: PedidoItemResumoDto[];
  @ApiProperty({ type: PedidoUsuarioResumoDto }) user!: PedidoUsuarioResumoDto;
  @ApiProperty({
    example: true,
    nullable: true,
    description:
      '`true` = o comprador viu preço ao fazer o pedido; `false` = não viu. `null` em pedido antigo, sem a informação.',
  })
  clienteViuPreco!: boolean | null;
  @ApiProperty({ example: 10, nullable: true, description: 'Margem (%) que o comprador via; já tirada dos preços.' })
  margem!: number | null;
  @ApiProperty({
    example: 125.0,
    nullable: true,
    description: 'Soma de preco_unitario × quantidade dos itens com preço.',
  })
  valorTotal!: number | null;
  @ApiProperty({
    example: 12345,
    nullable: true,
    description: 'Cliente do Celta da empresa. `null` = empresa sem vínculo.',
  })
  cli_codigo!: number | null;
  @ApiProperty({ type: ResponsavelPedidoDto, nullable: true })
  responsavel!: ResponsavelPedidoDto | null;
}

class EmpresaPortalDto {
  @ApiProperty({ description: 'id do usuário master no portal' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true }) company!: string | null;
  @ApiProperty({ nullable: true }) carteira!: string | null;
  @ApiProperty({ nullable: true, example: 12345 }) cliCodigo!: number | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({
    example: 2,
    description:
      'Pedidos ainda não assumidos da empresa (só em `semVinculo=1`): quem tem pedido esperando vem primeiro.',
  })
  pedidos_aguardando!: number;
}

class VincularClienteBodyDto {
  @ApiProperty({ example: 12345, description: 'CLI_CODIGO do Celta' })
  cli_codigo!: number;
}

class QuemAtendeBodyDto {
  @ApiProperty({ required: false, description: 'REP_CODIGO de quem atende (usuário logado)' })
  rep_codigo?: number;
  @ApiProperty({ required: false }) usuario_id?: string;
  @ApiProperty({ required: false }) usuario_nome?: string;
  @ApiProperty({
    required: false,
    description: 'Gestão do atacado: assume/recusa no lugar do vendedor responsável',
  })
  gestao?: boolean;
  @ApiProperty({
    required: false,
    description: 'Só com gestao: vendedor do orçamento ao assumir (padrão: o responsável)',
  })
  vendedor_codigo?: number;
}

class RecusarBodyDto extends QuemAtendeBodyDto {
  @ApiProperty({ example: 'Produto sem estoque e sem previsão' })
  motivo!: string;
}

class AtribuirVendedorBodyDto {
  @ApiProperty({ example: 123, description: 'REP_CODIGO do vendedor do atacado' })
  rep_codigo!: number;
  @ApiProperty({ required: false, description: 'Quem atribuiu (trilha)' })
  usuario_nome?: string;
}

class AtualizarStatusPedidoDto {
  @ApiProperty({ example: 'aprovado', description: 'Novo status do pedido' })
  status!: string;
}

class StatusPedidoAtualizadoDto {
  @ApiProperty({ example: 'ORD-1780402551844' }) id!: string;
  @ApiProperty({ example: 'aprovado' }) status!: string;
}

@ApiTags('B2B')
@Controller('b2b/pedidos')
export class B2bController {
  constructor(private readonly b2bService: B2bService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar pedidos do portal B2B',
    description:
      'Consulta os pedidos na API do portal B2B (PORTAL_B2B_URL/api/pedidos) e retorna um resumo com número do pedido, data, itens (código, quantidade e preço cotado), se o comprador viu preço (`clienteViuPreco`), o total cotado e dados do comprador (id, nome e telefone).',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de pedidos resumidos',
    type: [PedidoResumoDto],
  })
  async listarPedidos() {
    return this.b2bService.listarPedidos();
  }

  // Antes de `status/:id` e de qualquer `:id`: rota fixa.
  @Get('sem-responsavel')
  @ApiOperation({
    summary: 'Pedidos aguardando sem vendedor',
    description:
      'Pedidos ainda não assumidos (PENDING) de cliente já vinculado que não tem vendedor na carteira nem atribuição da gestão.',
  })
  @ApiResponse({ status: 200, type: [PedidoResumoDto] })
  async semResponsavel() {
    return this.b2bService.pedidosSemResponsavel();
  }

  @Get('aguardando')
  @ApiOperation({
    summary: 'Pedidos aguardando cotação (tela do orçamento)',
    description:
      'Pendentes desde B2B_PEDIDOS_DESDE, sem orçamento nem recusa, lidos do banco (a busca de cada minuto mantém em dia). `?rep=` deixa só os do vendedor; sem ele, todos (gestão).',
  })
  @ApiQuery({ name: 'rep', required: false, example: 7 })
  async aguardando(@Query('rep') rep?: string) {
    const n = rep != null && rep !== '' ? Number(rep) : null;
    return this.b2bService.pedidosAguardando(
      n != null && Number.isInteger(n) ? n : null,
    );
  }

  @Post(':id/assumir')
  @ApiOperation({
    summary: 'Assumir o pedido: vira orçamento do atacado em rascunho',
    description:
      'Só o vendedor responsável ou a gestão (`gestao: true`). Cria o orçamento com o vendedor responsável, o preço que o cliente viu sem a margem dele (ou a tabela) e a observação do pedido; o portal passa para PROCESSING. Item que não existe mais no ERP fica de fora (`fora`).',
  })
  @ApiParam({ name: 'id', description: 'id do registro, orderNumber ou pedidoId do portal' })
  @ApiBody({ type: QuemAtendeBodyDto })
  @ApiResponse({ status: 201, description: '{ orcamento_id, numero, fora }' })
  @ApiResponse({ status: 403, description: 'Não é o vendedor responsável' })
  @ApiResponse({ status: 409, description: 'Pedido já atendido ou sendo assumido' })
  async assumir(@Param('id') id: string, @Body() dto: QuemAtendeBodyDto) {
    return this.b2bService.assumir(id, {
      rep_codigo: dto?.rep_codigo != null ? Number(dto.rep_codigo) : null,
      usuario_id: dto?.usuario_id,
      usuario_nome: dto?.usuario_nome,
      gestao: dto?.gestao === true,
      vendedor_codigo:
        dto?.vendedor_codigo != null ? Number(dto.vendedor_codigo) : null,
    });
  }

  @Put(':id/cliente')
  @ApiOperation({
    summary: 'Vincular a empresa do pedido ao cliente do Celta (gestão)',
    description:
      'Mesmo vínculo de PUT /b2b/empresas/:masterId/cliente, achando o master pela empresa do pedido. Devolve o cliente e o vendedor da carteira, se houver.',
  })
  @ApiParam({ name: 'id', description: 'id do registro, orderNumber ou pedidoId do portal' })
  @ApiBody({ type: VincularClienteBodyDto })
  async vincularDoPedido(
    @Param('id') id: string,
    @Body() dto: VincularClienteBodyDto,
  ) {
    return this.b2bService.vincularClienteDoPedido(id, Number(dto?.cli_codigo));
  }

  @Post(':id/recusar')
  @ApiOperation({
    summary: 'Recusar o pedido, com motivo',
    description:
      'Só o vendedor responsável ou a gestão. O portal mostra o pedido cancelado com o motivo.',
  })
  @ApiParam({ name: 'id', description: 'id do registro, orderNumber ou pedidoId do portal' })
  @ApiBody({ type: RecusarBodyDto })
  async recusar(@Param('id') id: string, @Body() dto: RecusarBodyDto) {
    return this.b2bService.recusar(id, dto?.motivo, {
      rep_codigo: dto?.rep_codigo != null ? Number(dto.rep_codigo) : null,
      usuario_id: dto?.usuario_id,
      usuario_nome: dto?.usuario_nome,
      gestao: dto?.gestao === true,
    });
  }

  @Put(':id/vendedor')
  @ApiOperation({
    summary: 'Atribuir o vendedor do pedido (gestão)',
    description:
      'Vale só para este pedido (também sobre o vendedor da carteira, ex.: férias): NÃO carteiriza o cliente. Recusa pedido já assumido e vendedor fora do atacado.',
  })
  @ApiParam({ name: 'id', description: 'id do registro, orderNumber ou pedidoId do portal' })
  @ApiBody({ type: AtribuirVendedorBodyDto })
  async atribuirVendedor(
    @Param('id') id: string,
    @Body() dto: AtribuirVendedorBodyDto,
  ) {
    return this.b2bService.atribuirVendedor(
      id,
      Number(dto?.rep_codigo),
      dto?.usuario_nome,
    );
  }

  @Put('status/:id')
  @ApiOperation({
    summary: 'Atualiza o status de um pedido B2B',
    description:
      'Grava o novo status na tabela ven_orcamento_b2b. O :id pode ser o id do registro, o orderNumber ou o pedidoId do portal.',
  })
  @ApiParam({
    name: 'id',
    description: 'id do registro, orderNumber ou pedidoId do portal',
    example: 'ORD-1780402551844',
  })
  @ApiBody({ type: AtualizarStatusPedidoDto })
  @ApiResponse({
    status: 200,
    description: 'Status atualizado',
    type: StatusPedidoAtualizadoDto,
  })
  @ApiResponse({ status: 404, description: 'Pedido não encontrado' })
  async atualizarStatus(
    @Param('id') id: string,
    @Body() dto: AtualizarStatusPedidoDto,
  ) {
    return this.b2bService.atualizarStatus(id, dto?.status);
  }
}

@ApiTags('B2B')
@Controller('b2b/empresas')
export class B2bEmpresasController {
  constructor(private readonly b2bService: B2bService) {}

  @Get()
  @ApiOperation({
    summary: 'Empresas do portal B2B',
    description:
      'Uma linha por master da empresa no portal. `?semVinculo=1` deixa só as que ainda não têm cliente do Celta.',
  })
  @ApiQuery({ name: 'semVinculo', required: false, example: '1' })
  @ApiResponse({ status: 200, type: [EmpresaPortalDto] })
  async listar(@Query('semVinculo') semVinculo?: string) {
    return this.b2bService.listarEmpresas(
      semVinculo === '1' || semVinculo === 'true',
    );
  }

  @Put(':masterId/cliente')
  @ApiOperation({
    summary: 'Vincular a empresa do portal ao cliente do Celta',
    description:
      'Confere o cliente no ERP e grava o vínculo no portal (master e equipe). Os pedidos da empresa passam a ter o cliente e o vendedor da carteira.',
  })
  @ApiBody({ type: VincularClienteBodyDto })
  @ApiResponse({ status: 404, description: 'Cliente não encontrado no ERP' })
  async vincular(
    @Param('masterId') masterId: string,
    @Body() dto: VincularClienteBodyDto,
  ) {
    return this.b2bService.vincularCliente(masterId, Number(dto?.cli_codigo));
  }
}

@ApiTags('B2B')
@Controller('b2b/carteira-portal')
export class B2bCarteiraPortalController {
  constructor(private readonly carteira: B2bCarteiraService) {}

  @Post('enviar')
  @ApiOperation({
    summary: 'Enviar a carteira de clientes ao portal B2B agora',
    description:
      'O mesmo envio diário das 05:45 (B2B_CARTEIRA_PORTAL_CRON): clientes do atacado e vinculados, com o vendedor da carteirização. O portal acerta a carteira dos usuários vinculados. Use na primeira carga.',
  })
  @ApiResponse({ status: 201, description: '{ clientes, usuarios }' })
  async enviar() {
    return this.carteira.enviarTudo();
  }
}
