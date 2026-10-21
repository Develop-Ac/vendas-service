import {
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface responsePedidoApi {
  data: PortalOrder[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

export interface PortalProduct {
  id: string;
  proCodigo: string;
  name: string;
  promotion: PortalProductPromotion;
}

export interface PortalProductPromotion {
  textoPromocional: string;
}

export interface PortalOrderItem {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  /**
   * Preço unitário que o comprador viu ao cotar (tabela + margem), congelado
   * pelo portal. `null` quando ele não vê preço ou o pedido é anterior ao campo.
   */
  precoUnitario?: number | null;
  product: PortalProduct;
}

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  phone: string;
  company: string;
  role: string;
  carteira: string;
  /** Cliente do Celta vinculado à empresa; `null`/ausente = sem vínculo. */
  cliCodigo?: number | null;
}

/** Cliente da carteira como o portal recebe (PUT /api/integracoes/clientes-celta). */
export interface ClienteCeltaPortal {
  cliCodigo: number;
  nome: string;
  cpfCnpj: string | null;
  cidade: string | null;
  uf: string | null;
  repCodigo: number | null;
  repNome: string | null;
}

/** Empresa do portal, representada pelo master (GET /api/integracoes/empresas). */
export interface PortalEmpresa {
  id: string;
  name: string;
  email: string;
  company: string | null;
  carteira: string | null;
  cliCodigo: number | null;
  createdAt: string;
}

export interface PortalOrder {
  id: string;
  orderNumber: string;
  userId: string;
  total: number;
  status: string;
  shippingAddress: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  items: PortalOrderItem[];
  user: PortalUser;
  comprador: string;
  /** O comprador via preço quando fez o pedido. `false` = não viu preço. */
  clienteViuPreco?: boolean;
  /** Margem (%) do comprador já embutida no `precoUnitario` dos itens. */
  margem?: number | null;
}

/**
 * Base da API do portal. A barra final sai daqui, como no mais-vendidos:
 * `PORTAL_B2B_URL` gravado com `/` no fim viraria `//api/...`, e o portal
 * responde 404 nesse caminho.
 */
function urlPortal(caminho: string): string {
  const baseUrl = (process.env.PORTAL_B2B_URL ?? 'http://localhost:3000').replace(
    /\/+$/,
    '',
  );
  return `${baseUrl}/api${caminho}`;
}

/**
 * Segredo de serviço do portal: `SERVICO_TOKEN` quando definido, senão o
 * `AUTH_SECRET` — a mesma regra do lado do portal e do mais-vendidos. Antes
 * daqui só ia o `AUTH_SECRET`, e um portal com `SERVICO_TOKEN` próprio
 * recusava as chamadas.
 *
 * NÃO registrar em log: ele trafega a cada chamada.
 */
function tokenServico(): string {
  return process.env.SERVICO_TOKEN || process.env.AUTH_SECRET || '';
}

/** Motivo que o portal devolveu (`{ error }`), ou a mensagem do axios. */
function motivoDoPortal(err: any): string {
  return (
    err?.response?.data?.error ?? err?.response?.data?.message ?? err?.message
  );
}

@Injectable()
export class B2bRepository {
  private readonly logger = new Logger(B2bRepository.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Uma página de pedidos do portal, do mais novo para o mais antigo. 200 é o
   * teto de `limit` do portal.
   */
  async listarPedidos(page = 1, limit = 200): Promise<responsePedidoApi> {
    const url = urlPortal(`/pedidos?page=${page}&limit=${limit}`);

    try {
      const res = await firstValueFrom(
        this.httpService.get<responsePedidoApi>(url, {
          headers: { 'x-servico-token': tokenServico() },
        }),
      );
      return res.data;
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.error(
        `Erro ao consultar pedidos do portal B2B: ${status} - ${err.message}`,
      );
      throw new InternalServerErrorException(
        `Erro ao consultar a API de pedidos do portal B2B: ${err.message}`,
      );
    }
  }

  /** PUT /api/pedidos/:id no portal — o `id` é o do pedido lá (pedidoId aqui). */
  async atualizarStatusPedido(
    pedidoId: string,
    status: string,
    motivo?: string,
  ): Promise<void> {
    const url = urlPortal(`/pedidos/${encodeURIComponent(pedidoId)}`);

    try {
      await firstValueFrom(
        this.httpService.put(
          url,
          // `motivo` só vale no cancelamento: o portal grava em cancelReason.
          motivo ? { status, motivo } : { status },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-servico-token': tokenServico(),
            },
          },
        ),
      );
    } catch (err: any) {
      const statusHttp: number | undefined = err?.response?.status;
      // O portal responde `{ error: '...' }`; sem isto o motivo real ("Transição
      // de status inválida", "Status inválido", "Pedido não encontrado") não
      // chegava nem ao log nem a quem chamou.
      const motivo = motivoDoPortal(err);

      this.logger.error(
        `Erro ao atualizar o status do pedido ${pedidoId} no portal B2B: ${statusHttp ?? 'sem status'} - ${motivo}`,
      );

      // 4xx é recusa do portal (status inválido, transição proibida, pedido
      // inexistente), não falha nossa: repassa o código em vez de virar 500.
      if (statusHttp && statusHttp >= 400 && statusHttp < 500) {
        throw new HttpException(
          `O portal B2B recusou a mudança de status: ${motivo}`,
          statusHttp,
        );
      }

      throw new InternalServerErrorException(
        `Erro ao atualizar o status do pedido no portal B2B: ${motivo}`,
      );
    }
  }

  /** As empresas do portal (uma por master); `semVinculo` = só as sem cliente. */
  async listarEmpresas(semVinculo: boolean): Promise<PortalEmpresa[]> {
    const url = urlPortal(
      `/integracoes/empresas${semVinculo ? '?semVinculo=1' : ''}`,
    );
    try {
      const res = await firstValueFrom(
        this.httpService.get<PortalEmpresa[]>(url, {
          headers: { 'x-servico-token': tokenServico() },
        }),
      );
      return res.data;
    } catch (err: any) {
      const motivo = motivoDoPortal(err);
      this.logger.error(
        `Erro ao listar as empresas do portal B2B: ${err?.response?.status ?? 'sem status'} - ${motivo}`,
      );
      throw new InternalServerErrorException(
        `Erro ao consultar as empresas do portal B2B: ${motivo}`,
      );
    }
  }

  /** Grava no portal o cliente do Celta da empresa do master (e da equipe). */
  async vincularCliente(
    masterId: string,
    cliCodigo: number,
  ): Promise<{ company: string; cliCodigo: number; usuarios: number }> {
    const url = urlPortal(
      `/integracoes/empresas/${encodeURIComponent(masterId)}/cliente`,
    );
    try {
      const res = await firstValueFrom(
        this.httpService.put<{
          company: string;
          cliCodigo: number;
          usuarios: number;
        }>(
          url,
          { cliCodigo },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-servico-token': tokenServico(),
            },
          },
        ),
      );
      return res.data;
    } catch (err: any) {
      const statusHttp: number | undefined = err?.response?.status;
      const motivo = motivoDoPortal(err);
      this.logger.error(
        `Erro ao vincular a empresa ${masterId} ao cliente ${cliCodigo} no portal B2B: ${statusHttp ?? 'sem status'} - ${motivo}`,
      );
      if (statusHttp && statusHttp >= 400 && statusHttp < 500) {
        throw new HttpException(
          `O portal B2B recusou o vínculo: ${motivo}`,
          statusHttp,
        );
      }
      throw new InternalServerErrorException(
        `Erro ao vincular o cliente no portal B2B: ${motivo}`,
      );
    }
  }

  /** Envia clientes da carteira; o portal acerta a carteira dos vinculados. */
  async enviarCarteira(
    clientes: ClienteCeltaPortal[],
  ): Promise<{ clientes: number; usuarios: number }> {
    const url = urlPortal('/integracoes/clientes-celta');
    try {
      const res = await firstValueFrom(
        this.httpService.put<{ clientes: number; usuarios: number }>(
          url,
          { clientes },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-servico-token': tokenServico(),
            },
          },
        ),
      );
      return res.data;
    } catch (err: any) {
      const motivo = motivoDoPortal(err);
      this.logger.error(
        `Erro ao enviar a carteira ao portal B2B: ${err?.response?.status ?? 'sem status'} - ${motivo}`,
      );
      throw new InternalServerErrorException(
        `Erro ao enviar a carteira ao portal B2B: ${motivo}`,
      );
    }
  }
}
