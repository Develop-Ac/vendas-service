import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface BuscaItensParams {
  placa?: string;
  produto?: string;
  codigo?: string;
}

interface PlacaResponse {
  marca: string;
  modelo: string;
  ano: string;
  ano_modelo: string;
  cor: string;
  chassi: string;
  motor: string;
  uf: string;
  município: string;
}

@Injectable()
export class BuscaItensService {
  private readonly logger = new Logger(BuscaItensService.name);

  constructor(private readonly httpService: HttpService) {}

  async buscarItens({ placa, produto, codigo }: BuscaItensParams) {
    let query: string;
    let anoModeloFiltro: string | null = null;

    if (codigo) {
      query = codigo;
    } else if (placa && produto) {
      const placaUrl = `http://placas-service.acacessorios.local/placa/${placa}`;
      try {
        const placaRes = await firstValueFrom(
          this.httpService.get<PlacaResponse>(placaUrl),
        );
        const { modelo, ano_modelo } = placaRes.data;
        const firstWordModelo = modelo.split(' ')[0];
        query = `${produto} ${firstWordModelo} ${ano_modelo}`;
        anoModeloFiltro = ano_modelo;
      } catch (err) {
        const status = err?.response?.status;
        this.logger.error(`Erro ao consultar placa "${placa}": ${status} - ${err.message}`);
        if (status === 404) {
          throw new NotFoundException(`Placa "${placa}" não encontrada.`);
        }
        throw new InternalServerErrorException(
          `Erro ao consultar a API de placas: ${err.message}`,
        );
      }
    } else {
      throw new BadRequestException(
        'Informe (placa + produto) ou codigo para realizar a busca.',
      );
    }

    const searchUrl = `http://smart-search-service.acacessorios.local/api/search?q=${encodeURIComponent(query)}&limit=500`;
    try {
      const searchRes = await firstValueFrom(
        this.httpService.get<{ query: string; results: any[] }>(searchUrl),
      );

      const results = searchRes.data.results;

      if (!anoModeloFiltro) {
        return results;
      }

      return results.filter((item) => {
        for (let i = 1; i <= 10; i++) {
          const anos: string | null = item[`ano_${i}`];
          if (anos && anos.split(',').map((a) => a.trim()).includes(anoModeloFiltro!)) {
            return true;
          }
        }
        return false;
      });
    } catch (err) {
      const status = err?.response?.status;
      this.logger.error(`Erro ao buscar itens com query "${query}": ${status} - ${err.message}`);
      if (status === 404) {
        throw new NotFoundException(`Nenhum resultado encontrado para a busca.`);
      }
      throw new InternalServerErrorException(
        `Erro ao consultar a API de busca: ${err.message}`,
      );
    }
  }
}
