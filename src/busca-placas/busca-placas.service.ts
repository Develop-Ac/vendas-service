import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface PlacaResponse {
  marca: string;
  modelo: string;
  ano: string;
  ano_modelo: string;
  cor: string;
}

@Injectable()
export class BuscaPlacasService {
  private readonly logger = new Logger(BuscaPlacasService.name);

  constructor(private readonly httpService: HttpService) {}

  async buscarPlaca(placa: string): Promise<PlacaResponse> {
    const placaUrl = `http://placas-service.acacessorios.local/placa/${placa}`;

    try {
      const placaRes = await firstValueFrom(
        this.httpService.get<PlacaResponse>(placaUrl),
      );
      return placaRes.data;
    } catch (err) {
      const status = err?.response?.status;
      this.logger.error(
        `Erro ao consultar placa "${placa}": ${status} - ${err.message}`,
      );
      if (status === 404) { 
        throw new NotFoundException(`Placa "${placa}" não encontrada.`);
      }
      throw new InternalServerErrorException(
        `Erro ao consultar a API de placas: ${err.message}`,
      );
    }
  }
}
