import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { B2bService } from './b2b.service';

class PedidoItemResumoDto {
  @ApiProperty({ example: '47941' }) pro_codigo!: string;
  @ApiProperty({ example: 1 }) quantidade!: number;
}

class PedidoUsuarioResumoDto {
  @ApiProperty({ example: '35cd4939-297b-4ec8-85b6-b3351de36f73' }) id!: string;
  @ApiProperty({ example: 'João Comprador' }) nome!: string;
  @ApiProperty({ example: '(11) 98888-8888' }) phone!: string;
  @ApiProperty({ example: 'Barada' }) carteira!: string;
}

class PedidoResumoDto {
  @ApiProperty({ example: 'ORD-1780402551844' }) orderNumber!: string;
  @ApiProperty({ example: '2026-06-02T12:15:51.846Z' }) createdAt!: string;
  @ApiProperty({ type: [PedidoItemResumoDto] }) items!: PedidoItemResumoDto[];
  @ApiProperty({ type: PedidoUsuarioResumoDto }) user!: PedidoUsuarioResumoDto;
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
      'Consulta os pedidos na API do portal B2B (PORTAL_B2B_URL/api/pedidos) e retorna um resumo com número do pedido, data, itens (código e quantidade) e dados do comprador (id, nome e telefone).',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de pedidos resumidos',
    type: [PedidoResumoDto],
  })
  async listarPedidos() {
    return this.b2bService.listarPedidos();
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
