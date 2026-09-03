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

  /**
   * A mensagem de erro do `fetch` do Node é sempre "fetch failed" — o motivo
   * real (DNS que não resolve, porta fechada, certificado recusado) fica em
   * `error.cause`, uma camada abaixo. Sem desembrulhar, todo problema de rede
   * chega ao log com o mesmo texto e não dá para distinguir "o serviço caiu" de
   * "o endereço está errado".
   */
  private causaDeRede(e: Error): string {
    const causa = (e as { cause?: unknown }).cause as
      | { code?: string; message?: string; hostname?: string; port?: number }
      | undefined;
    if (!causa) return e.message;

    const codigo = causa.code ?? '';
    const onde = causa.hostname
      ? ` (${causa.hostname}${causa.port ? ':' + causa.port : ''})`
      : '';

    // Traduz os quatro casos que aparecem de verdade num deploy de container.
    const explicacao: Record<string, string> = {
      ENOTFOUND: 'nome não resolve — confira o DNS interno do EasyPanel (<projeto>_<serviço>)',
      EAI_AGAIN: 'DNS não respondeu — nome interno provavelmente inexistente',
      ECONNREFUSED: 'porta fechada — o serviço existe mas não escuta nessa porta',
      ETIMEDOUT: 'sem rota até o destino — rede entre os containers',
      CERT_HAS_EXPIRED: 'certificado expirado',
      DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado interno não confiável neste container — falta a CA raiz .local',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificado interno não confiável neste container — falta a CA raiz .local',
      SELF_SIGNED_CERT_IN_CHAIN: 'certificado interno não confiável neste container — falta a CA raiz .local',
    };

    const detalhe = explicacao[codigo];
    return detalhe
      ? `${codigo}${onde}: ${detalhe}`
      : `${e.message}${codigo ? ` (${codigo})` : ''}${onde}${causa.message ? ` — ${causa.message}` : ''}`;
  }

  /**
   * GET direto numa rota da API (as rotas de leitura por chave, como
   * `/erp/encomenda-pecas/produtos/:pro_codigo`). Diferente de {@link consultar},
   * não trata `truncado`: busca por chave devolve no máximo uma linha, e o
   * flag vem ligado no meta mesmo assim.
   */
  async buscar<T = Record<string, any>>(rota: string): Promise<ResultadoErp<T>> {
    return this.requisitar<T>(rota, { method: 'GET' });
  }

  private async chamar<T>(rota: string, corpo: unknown): Promise<ResultadoErp<T>> {
    return this.requisitar<T>(rota, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
  }

  private async requisitar<T>(
    rota: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<ResultadoErp<T>> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const inicio = Date.now();
    try {
      const resp = await fetch(`${this.baseUrl}${rota}`, {
        method: init.method,
        headers: {
          ...(init.headers ?? {}),
          'x-app-token': process.env.ERP_API_TOKEN ?? '',
          // Sem este header o /health/n1 da API relata "desconhecido" e o
          // relatório de quem consulta item a item deixa de ser acionável.
          'x-servico': 'x-vendas',
        },
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
          : this.causaDeRede(e);
      this.logger.error(
        `Falha em ${rota} após ${Date.now() - inicio}ms: ${motivo} [alvo: ${this.baseUrl}]`,
      );
      throw new ServiceUnavailableException(
        `erp-firebird-api indisponível (${rota}): ${motivo}`,
      );
    } finally {
      clearTimeout(t);
    }
  }
}