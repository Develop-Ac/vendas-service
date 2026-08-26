import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as sql from 'mssql';

/**
 * Conexão de LEITURA ao SQL Server BI (DW). Read-only.
 * Variáveis de ambiente (nome canônico primeiro, sinônimos aceitos em seguida):
 *   servidor  BI_SQL_SERVER   | SQL_HOST     | MSSQL_HOST
 *   base      BI_SQL_DATABASE | SQL_DATABASE | MSSQL_DATABASE
 *   usuário   BI_SQL_USER     | SQL_USER     | MSSQL_USER
 *   senha     BI_SQL_PASSWORD | SQL_PASSWORD | MSSQL_PASSWORD
 *   porta     BI_SQL_PORT     | SQL_PORT     | MSSQL_PORT  (default 1433)
 *
 * Os três conjuntos existem porque ambientes diferentes nomearam a mesma conta de
 * formas diferentes. Aceitar todos evita a falha silenciosa que motivou isto: com
 * usuário/senha vazios o driver ainda tenta autenticar, o login falha por
 * requisição, e a Carteirização responde 200 com lista vazia — indistinguível de
 * "não há cliente atacado".
 */
@Injectable()
export class MssqlService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MssqlService.name);
  private pool: sql.ConnectionPool | null = null;
  private connecting: Promise<sql.ConnectionPool> | null = null;

  /** Primeiro valor não-vazio entre as variáveis, na ordem de precedência. */
  private env(...nomes: string[]): string | undefined {
    for (const nome of nomes) {
      const v = process.env[nome];
      if (v !== undefined && v !== '') return v;
    }
    return undefined;
  }

  private buildConfig(): sql.config {
    return {
      server: this.env('BI_SQL_SERVER', 'SQL_HOST', 'MSSQL_HOST') ?? '192.168.1.146',
      database: this.env('BI_SQL_DATABASE', 'SQL_DATABASE', 'MSSQL_DATABASE') ?? 'BI',
      user: this.env('BI_SQL_USER', 'SQL_USER', 'MSSQL_USER') ?? '',
      password: this.env('BI_SQL_PASSWORD', 'SQL_PASSWORD', 'MSSQL_PASSWORD') ?? '',
      port: parseInt(this.env('BI_SQL_PORT', 'SQL_PORT', 'MSSQL_PORT') ?? '1433', 10),
      options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      requestTimeout: 120000,
      connectionTimeout: 15000,
    };
  }

  async onModuleInit() {
    // Credencial ausente não é indisponibilidade temporária: reclamar alto no boot,
    // senão o sintoma só aparece como tela vazia, longe da causa.
    if (!this.buildConfig().user) {
      this.logger.error(
        'Nenhuma credencial do BI configurada (BI_SQL_USER / SQL_USER / MSSQL_USER). ' +
          'A Carteirização vai responder vazia até isto ser corrigido no .env.',
      );
    }
    // Conexão preguiçosa — não derruba o boot se o BI estiver indisponível.
    try {
      await this.getPool();
    } catch (err) {
      this.logger.warn(
        `BI (SQL Server) indisponível no boot: ${(err as Error).message}. Tentará reconectar sob demanda.`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.close().catch(() => undefined);
      this.pool = null;
    }
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const pool = new sql.ConnectionPool(this.buildConfig());
      pool.on('error', (e) => this.logger.error(`Pool BI erro: ${e.message}`));
      await pool.connect();
      this.pool = pool;
      this.logger.log('Conectado ao SQL Server BI (read-only).');
      return pool;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Executa uma query parametrizada. params = { nome: valor }.
   * Tipos inferidos pelo driver mssql.
   */
  async query<T = any>(
    text: string,
    params: Record<string, unknown> = {},
  ): Promise<T[]> {
    const pool = await this.getPool();
    const request = pool.request();
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value as never);
    }
    const result = await request.query<T>(text);
    return result.recordset ?? [];
  }
}
