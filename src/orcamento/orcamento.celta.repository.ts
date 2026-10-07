import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { CorpoCelta } from './celta';
import type { ItemAprovado } from './comprovante';

/**
 * Cliente da api-vendas-service — a API que grava orçamentos no Celta.
 * Variáveis: API_VENDAS_URL, API_VENDAS_KEY (x-api-key), API_VENDAS_TIMEOUT_MS.
 * A empresa vai na rota (`/orcamentos/:empresa`); a chave de idempotência
 * garante que repetir a importação não cria um segundo orçamento no ERP.
 */
/** Uma linha do GET /comparativo/:orcamento da api-vendas-service (repassada como veio). */
export interface ComparativoCelta {
  empresa: number;
  orcamento: number;
  /** Nº do condicional vinculado; null = ainda não existe condicional (nada a comparar). */
  condicional?: number | null;
  quantidade_sku: boolean;
  quantidade_unitaria: boolean;
  valor: boolean;
  ok: boolean;
  [campo: string]: unknown;
}

@Injectable()
export class OrcamentoCeltaRepository {
  private readonly logger = new Logger(OrcamentoCeltaRepository.name);

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

  /** Devolve o nº do orçamento gerado (ou já existente, quando a chave se repete). */
  async criar(empresa: number, corpo: CorpoCelta, chave: string): Promise<{ orcamento: number; repetido: boolean }> {
    if (!this.configurado()) {
      throw new ServiceUnavailableException('Integração com o Celta não configurada (API_VENDAS_URL / API_VENDAS_KEY).');
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/orcamentos/${empresa}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-key': process.env.API_VENDAS_KEY as string,
          'Idempotency-Key': chave,
        },
        body: JSON.stringify(corpo),
        signal: ctrl.signal,
      });
      const texto = await r.text();
      let dados: any = null;
      try {
        dados = texto ? JSON.parse(texto) : null;
      } catch {
        /* resposta sem JSON: tratada abaixo */
      }
      if (!r.ok) {
        const msg = Array.isArray(dados?.message) ? dados.message.join('; ') : dados?.message ?? texto ?? `HTTP ${r.status}`;
        this.logger.warn(`Celta recusou o orçamento (${r.status}): ${msg}`);
        throw new BadGatewayException(`O Celta não aceitou o orçamento: ${msg}`);
      }
      const numero = Number(dados?.orcamento);
      if (!Number.isFinite(numero) || numero <= 0) {
        throw new BadGatewayException('O Celta respondeu sem o número do orçamento.');
      }
      return { orcamento: numero, repetido: r.status === 200 };
    } catch (e) {
      if (e instanceof BadGatewayException) throw e;
      const causa = (e as { cause?: { code?: string } }).cause?.code;
      this.logger.error(`Falha ao chamar a api-vendas-service: ${(e as Error).message}${causa ? ` (${causa})` : ''}`);
      throw new ServiceUnavailableException('Não foi possível falar com a API do Celta agora.');
    } finally {
      clearTimeout(t);
    }
  }
  /**
   * Prévia dos itens acima do desconto máximo do Celta para o corpo que seria importado
   * (POST /orcamentos/:empresa/excedentes): nada é gravado. É o conjunto exato que o
   * comprovante de aprovação precisa carregar. Recusa de cadastro/regra vem como 400 da API e
   * sobe como BadRequest, com a mensagem do ERP.
   */
  async excedentes(empresa: number, corpo: CorpoCelta): Promise<{ valor_descto: number; itens: ItemAprovado[] }> {
    if (!this.configurado()) {
      throw new ServiceUnavailableException('Integração com o Celta não configurada (API_VENDAS_URL / API_VENDAS_KEY).');
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const { comprovante: _c, ...semComprovante } = corpo;
      const r = await fetch(`${this.baseUrl}/orcamentos/${empresa}/excedentes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-api-key': process.env.API_VENDAS_KEY as string },
        body: JSON.stringify(semComprovante),
        signal: ctrl.signal,
      });
      const texto = await r.text();
      let dados: any = null;
      try {
        dados = texto ? JSON.parse(texto) : null;
      } catch {
        /* resposta sem JSON: tratada abaixo */
      }
      if (!r.ok) {
        const msg = Array.isArray(dados?.message) ? dados.message.join('; ') : dados?.message ?? texto ?? `HTTP ${r.status}`;
        this.logger.warn(`Prévia de excedentes recusada pelo Celta (${r.status}): ${msg}`);
        if (r.status === 400 || r.status === 404) throw new BadRequestException(`O Celta não aceitou o orçamento: ${msg}`);
        throw new BadGatewayException(`A prévia do Celta falhou: ${msg}`);
      }
      if (!Array.isArray(dados?.itens)) throw new BadGatewayException('A prévia do Celta respondeu num formato inesperado.');
      return { valor_descto: Number(dados.valor_descto ?? 0), itens: dados.itens };
    } catch (e) {
      if (e instanceof BadGatewayException || e instanceof BadRequestException) throw e;
      const causa = (e as { cause?: { code?: string } }).cause?.code;
      this.logger.error(`Falha ao chamar a api-vendas-service (excedentes): ${(e as Error).message}${causa ? ` (${causa})` : ''}`);
      throw new ServiceUnavailableException('Não foi possível falar com a API do Celta agora.');
    } finally {
      clearTimeout(t);
    }
  }

  /** Comparativo orçamento × condicional × intranet de um nº do Celta (um item por empresa). */
  async comparativo(orcamento: number): Promise<ComparativoCelta[]> {
    if (!this.configurado()) {
      throw new ServiceUnavailableException('Integração com o Celta não configurada (API_VENDAS_URL / API_VENDAS_KEY).');
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await fetch(`${this.baseUrl}/comparativo/${orcamento}`, {
        headers: { Accept: 'application/json', 'x-api-key': process.env.API_VENDAS_KEY as string },
        signal: ctrl.signal,
      });
      const texto = await r.text();
      let dados: any = null;
      try {
        dados = texto ? JSON.parse(texto) : null;
      } catch {
        /* resposta sem JSON: tratada abaixo */
      }
      if (r.status === 404) throw new NotFoundException(`Orçamento ${orcamento} não encontrado no Celta.`);
      if (!r.ok) {
        const msg = Array.isArray(dados?.message) ? dados.message.join('; ') : dados?.message ?? texto ?? `HTTP ${r.status}`;
        this.logger.warn(`Comparativo do orçamento ${orcamento} falhou (${r.status}): ${msg}`);
        throw new BadGatewayException(`O comparativo do Celta falhou: ${msg}`);
      }
      if (!Array.isArray(dados)) throw new BadGatewayException('O comparativo do Celta respondeu num formato inesperado.');
      return dados;
    } catch (e) {
      if (e instanceof BadGatewayException || e instanceof NotFoundException) throw e;
      const causa = (e as { cause?: { code?: string } }).cause?.code;
      this.logger.error(`Falha ao chamar a api-vendas-service: ${(e as Error).message}${causa ? ` (${causa})` : ''}`);
      throw new ServiceUnavailableException('Não foi possível falar com a API do Celta agora.');
    } finally {
      clearTimeout(t);
    }
  }
}
