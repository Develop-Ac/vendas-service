import {
  Injectable,
  BadRequestException,
  NotFoundException,
  InternalServerErrorException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { BuscaItensRepository, UpdateProdutoCarroData } from './busca-itens.repository';

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

  constructor(
    private readonly httpService: HttpService,
    private readonly buscaItensRepository: BuscaItensRepository,
  ) {}

  async buscarItens({ placa, produto, codigo }: BuscaItensParams) {
    let query: string;
    let anoModeloFiltro: string | null = null;

    codigo = codigo?.replaceAll("%", "+");  

    if (codigo) {
      query = codigo;
    } else if (placa) {
      const placaUrl = `http://placas-service.acacessorios.local/placa/${placa}`;
      try {
        const placaRes = await firstValueFrom(
          this.httpService.get<PlacaResponse>(placaUrl),
        );
        const { modelo, ano_modelo } = placaRes.data;
        const firstWordModelo = modelo.split(' ')[0];
        query = produto
          ? `${produto} ${firstWordModelo} ${ano_modelo}`
          : `${firstWordModelo} ${ano_modelo}`;
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
    } else if (produto) {
      query = produto;
    } else {
      throw new BadRequestException(
        'Informe (placa + produto) ou codigo para realizar a busca.',
      );
    }

    const searchUrl = `https://portal-b2b-smart-search-service.naayqg.easypanel.host/api/search?q=${encodeURIComponent(query.replace(/\+/g, ' '))}&limit=500`;

    try {
      const searchRes = await firstValueFrom(
        this.httpService.get<{ query: string; results: any[] }>(searchUrl),
      );

      const results = searchRes.data?.results;

      // O host da busca pode responder 200 com HTML quando o proxy aponta para
      // a aplicação errada. Sem esta checagem quebra num "filter is not a
      // function" que não diz nada sobre a causa.
      if (!Array.isArray(results)) {
        this.logger.error(
          `Resposta inesperada de ${searchUrl}: esperado { results: [] }, veio ${typeof searchRes.data}`,
        );
        throw new InternalServerErrorException(
          'A API de busca respondeu em um formato inesperado.',
        );
      }

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
      // Não reembrulha o erro de formato levantado logo acima.
      if (err instanceof HttpException) throw err;

      const e: any = err;
      const status = e?.response?.status;
      const contentType = String(e?.response?.headers?.['content-type'] ?? '');
      const respostaDaApi = contentType.includes('json');

      this.logger.error(
        `Erro ao buscar itens com query "${query}" em ${searchUrl}: ${status} (${contentType || 'sem content-type'}) - ${e?.message}`,
      );

      // 404 só significa "sem resultados" quando quem respondeu foi a própria
      // API. Um 404 em HTML é rota inexistente no proxy — tratar isso como
      // busca vazia esconde o serviço fora do ar.
      if (status === 404 && respostaDaApi) {
        throw new NotFoundException(`Nenhum resultado encontrado para a busca.`);
      }
      if (status === 404) {
        throw new InternalServerErrorException(
          'A API de busca não respondeu na rota esperada. Verifique o roteamento do smart-search-service.',
        );
      }
      throw new InternalServerErrorException(
        `Erro ao consultar a API de busca: ${e?.message}`,
      );
    }
  }

  async updateProdutoCarro(proCodigo: string, data: UpdateProdutoCarroData) {
    return this.buscaItensRepository.updateProdutoCarro(proCodigo, data);
  }
}
