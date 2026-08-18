import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface ItemCarga {
  proCodigo: string;
  quantidade: number;
  estoque: number;
}

/**
 * Empurra o ranking para o Portal B2B.
 *
 * O sentido da chamada não é escolha de estilo: o portal roda na nuvem
 * (Hostinger) e o ERP vive na rede interna. A nuvem não alcança a intranet —
 * quem tem o dado é quem vai até lá.
 */
@Injectable()
export class MaisVendidosPortalRepository {
  private readonly logger = new Logger(MaisVendidosPortalRepository.name);

  constructor(private readonly http: HttpService) {}

  async enviar(apuradoEm: Date, itens: ItemCarga[]): Promise<number> {
    /*
     * A barra final sai daqui. `PORTAL_B2B_URL` está gravado com `/` no fim, e
     * concatenar direto produz `//api/...` — caminho diferente de `/api/...`
     * para o roteador do Next, que responderia 404.
     */
    const baseUrl = (process.env.PORTAL_B2B_URL ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    const url = `${baseUrl}/api/produtos/mais-vendidos`;
    /*
     * `SERVICO_TOKEN` primeiro, `AUTH_SECRET` como reserva: o portal aceita os
     * dois (o dele cai no `AUTH_SECRET` quando o próprio não está definido),
     * mas o segredo dedicado é o caminho recomendado lá — este header trafega
     * a cada chamada, e vazá-lo não deve entregar junto a chave que assina os
     * cookies de sessão.
     */
    const token = process.env.SERVICO_TOKEN || process.env.AUTH_SECRET || '';

    try {
      const res = await firstValueFrom(
        this.http.put<{ gravados: number }>(
          url,
          { apuradoEm: apuradoEm.toISOString(), itens },
          { headers: { 'x-servico-token': token } },
        ),
      );
      return res.data?.gravados ?? 0;
    } catch (err) {
      const erro = err as { message: string; response?: { status?: number } };
      // O status e a mensagem entram no log; o token, nunca.
      this.logger.error(
        `Falha ao enviar os mais vendidos ao portal (${erro.response?.status ?? 'sem status'}): ${erro.message}`,
      );
      throw new InternalServerErrorException(
        `Erro ao enviar os mais vendidos ao Portal B2B: ${erro.message}`,
      );
    }
  }
}
