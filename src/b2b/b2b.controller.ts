import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiResponse, ApiTags } from '@nestjs/swagger';
import { B2bService } from './b2b.service';

class PedidoItemResumoDto {
  @ApiProperty({ example: '47941' }) pro_codigo: string;
  @ApiProperty({ example: 1 }) quantidade: number;
}

class PedidoUsuarioResumoDto {
  @ApiProperty({ example: '35cd4939-297b-4ec8-85b6-b3351de36f73' }) id: string;
  @ApiProperty({ example: 'João Comprador' }) nome: string;
  @ApiProperty({ example: '(11) 98888-8888' }) phone: string;
  @ApiProperty({ example: 'Barada' }) carteira: string;
}

class PedidoResumoDto {
  @ApiProperty({ example: 'ORD-1780402551844' }) orderNumber: string;
  @ApiProperty({ example: '2026-06-02T12:15:51.846Z' }) createdAt: string;
  @ApiProperty({ type: [PedidoItemResumoDto] }) items: PedidoItemResumoDto[];
  @ApiProperty({ type: PedidoUsuarioResumoDto }) user: PedidoUsuarioResumoDto;
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
}
