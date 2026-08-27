import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

/**
 * Cliente da erp-firebird-api — leitura DIRETA no Firebird do ERP.
 *
 * Existe para tirar a Carteirização do caminho
 * `node -> SQL Server -> OPENQUERY(CONSULTA) -> Firebird`. Quando o Firebird
 * engasga nesse caminho, o provider OLE DB não retorna e o KILL não solta a
 * sessão: o SQL Server inteiro fica refém e toda tela que lê o BI para junto,
 * mesmo as que não têm nada a ver com a consulta travada. Medido no
 * adm_consulta_sessao_log: 220 sessões que sobreviveram ao KILL em 25/08, a
 * pior com 37 horas presa em wait OLEDB.
 *
 * A API do lado de lá responde 503/504 rápido em vez de pendurar, então a
 * indisponibilidade aqui é um erro claro e curto, não uma tela que roda para
 * sempre.
 *
 * Variáveis: ERP_API_URL, ERP_API_TOKEN, ERP_API_TIMEOUT_MS.
 */

/** Operadores aceitos pelo montador da API. */
export type OperadorErp =
  | 'igual'
  | 'diferente'
  | 'maior'
  | 'maior_igual'
  | 'menor'
  | 'menor_igual'
  | 'em'
  | 'nao_em'
  | 'entre'
  | 'contem'
  | 'comeca_com'
  | 'igual_trim'
  | 'nulo'
  | 'nao_nulo';

export interface FiltroErp {
  campo: string;
  op: OperadorErp;
  valor?: unknown;
}

export interface AgregacaoErp {
  fn: 'contar' | 'contar_distinto' | 'somar' | 'maximo' | 'minimo' | 'media';
  campo?: string;
  como: string;
}

export interface ConsultaErp {
  empresa?: number;
  campos?: Array<string | { campo: string; como: string }>;
  filtros?: FiltroErp[];
  agrupar?: string[];
  agregar?: AgregacaoErp[];
  ordenar?: Array<{ campo: string; dir?: 'asc' | 'desc'; nulos?: 'primeiro' | 'ultimo' }>;
  incluir?: string[];
  limite?: number;
  distinto?: boolean;
  semCache?: boolean;
}

export interface ResultadoErp<T = Record<string, any>> {
  dados: T[];
  meta: {
    tabela: string;
    colunas: string[];
    relacoes: string[];
    linhas: number;
    ms: number;
    truncado: boolean;
    cache: boolean;
  };
}

const TIMEOUT_PADRAO_MS = 120_000;

@Injectable()
export class ErpApiService {
  private readonly logger = new Logger(ErpApiService.name);

  private get baseUrl(): string {
    return (process.env.ERP_API_URL ?? 'http://localhost:8014').replace(/\/+$/, '');
  }

  private get timeoutMs(): number {
    const n = Number(process.env.ERP_API_TIMEOUT_MS);
    return Number.isFinite(n) && n > 0 ? n : TIMEOUT_PADRAO_MS;
  }

  /** `true` quando a API está configurada e respondendo. Usado pelo /health. */
  async disponivel(): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const r = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
        return r.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  /**
   * Consulta livre a um recurso do ERP. `recurso` é a chave da tabela no
   * catálogo da API (`clientes`, `nf-saida`, `nfs-itens`, `contas-receber`, …).
   *
   * `truncado` é verificado aqui, e não deixado para o chamador: resposta
   * cortada no limite tem o mesmo formato de resposta completa, e a carga da
   * carteira com metade dos clientes passaria por carga bem-sucedida.
   */
  async consultar<T = Record<string, any>>(
    recurso: string,
    consulta: ConsultaErp,
  ): Promise<T[]> {
    const r = await this.chamar<T>(`/erp/${recurso}/consulta`, consulta);
    if (r.meta.truncado) {
      throw new ServiceUnavailableException(
        `Consulta a "${recurso}" foi truncada no limite de ${consulta.limite ?? 'padrão'} linhas. ` +
          'A resposta estaria incompleta sem nenhum sinal na tela — aumente o limite ou pagine.',
      );
    }
    return r.dados;
  }

  private async chamar<T>(rota: string, corpo: unknown): Promise<ResultadoErp<T>> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const inicio = Date.now();
    try {
      const resp = await fetch(`${this.baseUrl}${rota}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-app-token': process.env.ERP_API_TOKEN ?? '',
          // Sem este header o /health/n1 da API relata "desconhecido" e o
          // relatório de quem consulta item a item deixa de ser acionável.
          'x-servico': 'vendas-service',
        },
        body: JSON.stringify(corpo),
        signal: ctrl.signal,
      });

      const texto = await resp.text();
      if (!resp.ok) {
        let detalhe = texto.slice(0, 400);
        try {
          const j = JSON.parse(texto);
          detalhe = Array.isArray(j.message) ? j.message.join('; ') : (j.message ?? detalhe);
        } catch {
          /* corpo não-JSON: fica o texto cru mesmo */
        }
        throw new ServiceUnavailableException(
          `erp-firebird-api respondeu ${resp.status} em ${rota}: ${detalhe}`,
        );
      }
      return JSON.parse(texto) as ResultadoErp<T>;
    } catch (err) {
      const e = err as Error;
      if (e instanceof ServiceUnavailableException) throw e;
      // AbortError = estourou o timeout local. É diferente de erro de rede:
      // significa que a API não devolveu dentro do prazo, e insistir só
      // aumenta a fila do outro lado.
      const motivo =
        e.name === 'AbortError'
          ? `sem resposta em ${this.timeoutMs}ms`
          : e.message;
      this.logger.error(`Falha em ${rota} após ${Date.now() - inicio}ms: ${motivo}`);
      throw new ServiceUnavailableException(
        `erp-firebird-api indisponível (${rota}): ${motivo}`,
      );
    } finally {
      clearTimeout(t);
    }
  }
}
