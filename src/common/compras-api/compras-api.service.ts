import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

/**
 * Cliente do compras-service (rotas /compras/pedido/encomenda), usado pela
 * Encomenda de Peças para gerar o pedido de compra ao marcar "Comprado" e para
 * ler os pedidos com o rastreio SSW das NFs.
 *
 * Variáveis: COMPRAS_SERVICE_URL (padrão http://compras-service.acacessorios.local),
 * COMPRAS_SERVICE_TIMEOUT_MS (padrão 30000).
 */
const TIMEOUT_PADRAO_MS = 30_000;

export interface ItemPedidoEncomenda {
  pro_codigo: number;
  pro_descricao: string;
  referencia: string | null;
  mar_descricao: string | null;
  quantidade: number;
  for_codigo: number;
  valor_unitario: number | null;
  frete: number | null;
  prazo: string | null;
  nomeFrete: string | null;
  /** id do item cotado (vira item_id_origem no compras). */
  item_cotado_id: string | null;
}

export interface PedidoEncomendaCriado {
  ok: boolean;
  encomenda_id: number;
  numero: number;
  numero_formatado: string;
  pedidos_criados: number;
  pedidos: Array<{
    id: string;
    pedido_cotacao: number;
    numero_formatado: string;
    for_codigo: number;
    for_nome: string | null;
    itens_count: number;
    novo: boolean;
    pdf_url: string;
  }>;
}

/** Resposta de GET /compras/pedido/encomenda/:id (shape definido no compras-service). */
export interface PedidosDaEncomenda {
  encomenda_id: number;
  numero: number | null;
  numero_formatado: string | null;
  pedidos: Array<Record<string, unknown>>;
}

@Injectable()
export class ComprasApiService {
  private readonly logger = new Logger(ComprasApiService.name);

  private get baseUrl(): string {
    return (
      process.env.COMPRAS_SERVICE_URL ?? 'http://compras-service.acacessorios.local'
    ).replace(/\/+$/, '');
  }

  private get timeoutMs(): number {
    const n = Number(process.env.COMPRAS_SERVICE_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : TIMEOUT_PADRAO_MS;
  }

  criarPedidoEncomenda(corpo: {
    encomenda_id: number;
    usuario?: string | null;
    itens: ItemPedidoEncomenda[];
  }): Promise<PedidoEncomendaCriado> {
    return this.requisitar<PedidoEncomendaCriado>('/compras/pedido/encomenda', {
      method: 'POST',
      body: JSON.stringify(corpo),
    });
  }

  pedidosDaEncomenda(encomendaId: number): Promise<PedidosDaEncomenda> {
    return this.requisitar<PedidosDaEncomenda>(`/compras/pedido/encomenda/${encomendaId}`, {
      method: 'GET',
    });
  }

  private async requisitar<T>(
    rota: string,
    init: { method: string; body?: string },
  ): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const inicio = Date.now();
    try {
      const resp = await fetch(`${this.baseUrl}${rota}`, {
        method: init.method,
        headers: { 'Content-Type': 'application/json', 'x-servico': 'vendas-service' },
        body: init.body,
        signal: ctrl.signal,
      });
      const texto = await resp.text();
      if (!resp.ok) {
        let detalhe = texto.slice(0, 400);
        try {
          const j = JSON.parse(texto);
          detalhe = Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? detalhe);
        } catch {
          /* corpo não-JSON: fica o texto cru */
        }
        throw new BadGatewayException(
          `compras-service respondeu ${resp.status} em ${rota}: ${detalhe}`,
        );
      }
      return JSON.parse(texto) as T;
    } catch (err) {
      const e = err as Error;
      if (e instanceof BadGatewayException) throw e;
      const causa = (e as { cause?: { code?: string } }).cause?.code;
      const motivo =
        e.name === 'AbortError'
          ? `sem resposta em ${this.timeoutMs}ms`
          : `${e.message}${causa ? ` (${causa})` : ''}`;
      this.logger.error(
        `Falha em ${rota} após ${Date.now() - inicio}ms: ${motivo} [alvo: ${this.baseUrl}]`,
      );
      throw new BadGatewayException(`compras-service indisponível (${rota}): ${motivo}`);
    } finally {
      clearTimeout(t);
    }
  }
}
