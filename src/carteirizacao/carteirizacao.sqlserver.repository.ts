import { Injectable } from '@nestjs/common';
import { MssqlService } from '../common/mssql/mssql.service';

export interface ClienteBaseRow {
  cli_codigo: number;
  cli_nome: string;
  uf: string | null;
  cidade: string | null;
  fone: string | null;
  contato: string | null;
  data_ult_compra: Date | null;
  rep_codigo: number | null;
  rep_cadastro_nome: string | null;
  tabela_preco: string | null;
  inativo: string | null;
  localizacao_completa: string | null;
  faturamento_total: number;
  faturamento_3m: number;
  faturamento_3m_ant: number;
  faturamento_12m: number;
  qtd_pedidos: number;
  ult_compra_venda: Date | null;
}

export interface VendedorRow {
  rep_codigo: number;
  rep_nome: string;
}

/**
 * Universo da carteirização = clientes ATACADO (tabela de preço 2 = atacado esp, 5 = atacado).
 * Clientes de varejo não são carteirizados.
 */
const TABELAS_ATACADO = ['2', '5'];

@Injectable()
export class CarteirizacaoSqlServerRepository {
  constructor(private readonly mssql: MssqlService) {}

  /**
   * Base completa de clientes atacado + métricas de venda (líquidas de cancelamento),
   * em uma única passada. Universo pequeno (~1,1k clientes) -> carregamos tudo e
   * filtramos/paginamos em memória no service (a carteira vive em outro banco).
   */
  async listarBaseAtacado(): Promise<ClienteBaseRow[]> {
    const inList = TABELAS_ATACADO.map((t) => `'${t}'`).join(',');
    const query = `
      WITH atac AS (
        SELECT c.cli_codigo, c.cli_nome, c.uf, c.cidade, c.fone, c.contato,
               c.data_ult_compra, c.rep_codigo, c.tabela_preco, c.inativo,
               c.localizacao_completa
        FROM dbo.vw_clientes c
        WHERE c.tabela_preco IN (${inList})
      ),
      notas AS (
        SELECT v.CLI_CODIGO, v.EMPRESA, v.SERIE, v.NFS,
               MAX(v.TOTAL_NOTA) AS valor_nota,
               MAX(v.dt_emissao_convertida) AS dt
        FROM dbo.vw_analise_vendas v
        WHERE v.DT_CANCELAMENTO IS NULL
          AND v.CLI_CODIGO IN (SELECT cli_codigo FROM atac)
        GROUP BY v.CLI_CODIGO, v.EMPRESA, v.SERIE, v.NFS
      ),
      metr AS (
        SELECT CLI_CODIGO,
          SUM(valor_nota) AS faturamento_total,
          SUM(CASE WHEN dt >= DATEADD(MONTH,-3, CAST(GETDATE() AS date)) THEN valor_nota ELSE 0 END) AS faturamento_3m,
          SUM(CASE WHEN dt >= DATEADD(MONTH,-6, CAST(GETDATE() AS date))
                    AND dt <  DATEADD(MONTH,-3, CAST(GETDATE() AS date)) THEN valor_nota ELSE 0 END) AS faturamento_3m_ant,
          SUM(CASE WHEN dt >= DATEADD(MONTH,-12, CAST(GETDATE() AS date)) THEN valor_nota ELSE 0 END) AS faturamento_12m,
          COUNT(*) AS qtd_pedidos,
          MAX(dt) AS ult_compra_venda
        FROM notas
        GROUP BY CLI_CODIGO
      )
      SELECT a.cli_codigo, a.cli_nome, a.uf, a.cidade, a.fone, a.contato,
             a.data_ult_compra, a.rep_codigo, a.tabela_preco, a.inativo,
             a.localizacao_completa,
             r.nome_representante AS rep_cadastro_nome,
             COALESCE(m.faturamento_total, 0)   AS faturamento_total,
             COALESCE(m.faturamento_3m, 0)      AS faturamento_3m,
             COALESCE(m.faturamento_3m_ant, 0)  AS faturamento_3m_ant,
             COALESCE(m.faturamento_12m, 0)     AS faturamento_12m,
             COALESCE(m.qtd_pedidos, 0)         AS qtd_pedidos,
             m.ult_compra_venda
      FROM atac a
      LEFT JOIN dbo.d_cadastro_representantes r ON r.cod = a.rep_codigo
      LEFT JOIN metr m ON m.CLI_CODIGO = a.cli_codigo
    `;
    return this.mssql.query<ClienteBaseRow>(query);
  }

  /** Representantes que atuam no atacado (têm cliente atacado vinculado por cadastro). */
  async listarVendedoresAtacado(): Promise<VendedorRow[]> {
    const inList = TABELAS_ATACADO.map((t) => `'${t}'`).join(',');
    const query = `
      SELECT r.cod AS rep_codigo, r.nome_representante AS rep_nome
      FROM dbo.d_cadastro_representantes r
      WHERE r.cod IN (
        SELECT DISTINCT rep_codigo FROM dbo.vw_clientes
        WHERE tabela_preco IN (${inList}) AND rep_codigo IS NOT NULL
      )
      ORDER BY r.nome_representante
    `;
    return this.mssql.query<VendedorRow>(query);
  }

  /** Nomes de representantes por códigos (para reps que só aparecem no overlay). */
  async nomesRepresentantes(codigos: number[]): Promise<VendedorRow[]> {
    if (!codigos.length) return [];
    const inList = codigos.map((c) => Number(c)).filter((n) => !Number.isNaN(n)).join(',');
    if (!inList) return [];
    const query = `
      SELECT cod AS rep_codigo, nome_representante AS rep_nome
      FROM dbo.d_cadastro_representantes
      WHERE cod IN (${inList})
    `;
    return this.mssql.query<VendedorRow>(query);
  }
}
