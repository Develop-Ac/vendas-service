import {
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  UploadedFile,
  UseInterceptors,
  Body,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { VendaCasadaService } from './venda-casada.service';
import { CreateVendaCasadaDto } from './dto/create-venda-casada.dto';
import { AddPecasCotadasDto } from './dto/add-pecas-cotadas.dto';

@ApiTags('Venda Casada')
@Controller('venda-casada')
export class VendaCasadaController {
  constructor(
    private readonly service: VendaCasadaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Lista todas as vendas casadas' })
  @ApiResponse({ status: 200, description: 'Lista retornada com sucesso' })
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Busca uma venda casada pelo ID' })
  @ApiParam({ name: 'id', type: Number, description: 'ID da venda casada' })
  @ApiResponse({ status: 200, description: 'Registro encontrado' })
  @ApiResponse({ status: 404, description: 'Registro não encontrado' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.service.findById(id);
  }

  @Post()
  @UseInterceptors(FileInterceptor('imagem'))
  @ApiOperation({ summary: 'Cria uma nova venda casada (com imagem opcional)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Dados da venda casada e imagem opcional',
    schema: {
      type: 'object',
      properties: {
        nome_vendedor: { type: 'string' },
        carro: { type: 'string' },
        pecas: { type: 'array', items: { type: 'string' } },
        ano: { type: 'integer' },
        observacao: { type: 'string' },
        cliente: { type: 'string' },
        numero: { type: 'string' },
        imagem: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Venda casada criada com sucesso' })
  create(
    @Body() dto: CreateVendaCasadaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.service.create(dto, file);
  }

  @Post(':id')
  @ApiOperation({
    summary: 'Adiciona peças cotadas a uma venda casada',
    description:
      'Cria registros em ven_venda_casada_itens e salva os IDs gerados na lista pecas_cotadas da venda casada.',
  })
  @ApiParam({ name: 'id', type: Number, description: 'ID da venda casada' })
  @ApiBody({ type: AddPecasCotadasDto })
  @ApiResponse({ status: 201, description: 'Peças cotadas adicionadas com sucesso' })
  @ApiResponse({ status: 404, description: 'Venda casada não encontrada' })
  addPecasCotadas(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddPecasCotadasDto,
  ) {
    return this.service.addPecasCotadas(id, dto);
  }
}
