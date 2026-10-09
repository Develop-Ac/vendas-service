import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/**
 * Escrita da carteira no Celta pela api-vendas-service: troca o representante
 * no cadastro do cliente (`PUT /clientes/:empresa/:cli/representante`). O ERP é
 * a fonte da verdade da carteira — a intranet grava lá e espelha aqui.
 * Mesmas variáveis do orçamento: API_VENDAS_URL, API_VENDAS_KEY, API_VENDAS_TIMEOUT_MS.
 * A credencial precisa ser SEM restrição de representante (senão não tira o
 * cliente de outro vendedor).
 */
@Injectable()
export class CarteirizacaoCeltaClient {
  private readonly logger = new Logger(CarteirizacaoCeltaClient.name);

  private get baseUrl(): string | null {
    const u = (process.env.API_VENDAS_URL ?? '').trim().replace(/\/+$/, '');
    return u || null;
  }

  private get timeoutMs(): number {
    const n = Number(process.env.API_VENDAS_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : 30_000;
  }

  configurado(): boolean {
    return !!this.baseUrl && !!process.env.API_VENDAS_KEY;
  }

  async trocarRepresentante(empresa: number, cli_codigo: number, rep_codigo: number): Promise<void> {
    if (!this.configurado()) {
      throw new ServiceUnavailableException('Integração com o Celta não configurada (API_VENDAS_URL / API_VENDAS_KEY).');
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/clientes/${empresa}/${cli_codigo}/representante`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': process.env.API_VENDAS_KEY as string },
        body: JSON.stringify({ rep_codigo }),
        signal: ctrl.signal,
      });
      if (r.ok) return;
      const texto = await r.text();
      let dados: any = null;
      try {
        dados = texto ? JSON.parse(texto) : null;
      } catch {
        /* resposta sem JSON: usa o texto */
      }
      const msg = Array.isArray(dados?.message) ? dados.message.join('; ') : dados?.message || texto || `HTTP ${r.status}`;
      this.logger.warn(`Celta recusou a troca de vendedor do cliente ${cli_codigo} (${r.status}): ${msg}`);
      if (r.status === 404) throw new NotFoundException(msg);
      if (r.status === 400) throw new BadRequestException(msg);
      if (r.status === 403) throw new BadGatewayException(`A credencial da intranet na API do Celta não pode trocar este vendedor: ${msg}`);
      throw new BadGatewayException(`O Celta não aceitou a troca: ${msg}`);
    } catch (e) {
      if (e instanceof BadGatewayException || e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      if ((e as Error).name === 'AbortError') {
        // Pode ter gravado do lado de lá: o Celta só não respondeu a tempo.
        throw new ServiceUnavailableException('O Celta não respondeu a tempo: confira o vendedor no cadastro antes de repetir.');
      }
      const causa = (e as { cause?: { code?: string } }).cause?.code;
      this.logger.error(`Falha ao chamar a api-vendas-service (representante): ${(e as Error).message}${causa ? ` (${causa})` : ''}`);
      throw new ServiceUnavailableException('Não foi possível falar com a API do Celta agora.');
    } finally {
      clearTimeout(t);
    }
  }
}
