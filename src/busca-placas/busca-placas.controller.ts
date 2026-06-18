import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BuscaPlacasService } from './busca-placas.service';

class PlacaResultDto {
  @ApiProperty({ example: 'HYUNDAI' }) marca: string;
  @ApiProperty({ example: 'HB20 10M SENSE' }) modelo: string;
  @ApiProperty({ example: '2022' }) ano: string;
  @ApiProperty({ example: '2023' }) ano_modelo: string;
  @ApiProperty({ example: 'Branca' }) cor: string;
}

@ApiTags('Vendas')
@Controller('vendas/busca-placas')
export class BuscaPlacasController {
  constructor(private readonly buscaPlacasService: BuscaPlacasService) {}

  @Get('/:placa')
  @ApiOperation({
    summary: 'Buscar dados do veículo por placa',
    description:
      'Consulta a API de placas e retorna os dados do veículo (marca, modelo, ano, ano_modelo e cor).',
  })
  @ApiParam({
    name: 'placa',
    description: 'Placa do veículo para consulta',
    example: 'ABC1234',
  })
  @ApiResponse({
    status: 200,
    description: 'Dados do veículo encontrados',
    type: PlacaResultDto,
  })
  @ApiResponse({ status: 404, description: 'Placa não encontrada' })
  async buscarPlaca(@Param('placa') placa: string) {
    return this.buscaPlacasService.buscarPlaca(placa);
  }
}
