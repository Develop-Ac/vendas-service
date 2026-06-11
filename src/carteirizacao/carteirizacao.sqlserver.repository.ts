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
  lucro_12m: number;
  base_12m: number;
  custo_12m: number;
}

export interface MetaDwRow {
  cod_vendedor: number;
  vendedor: string;
  valor_total: number;
  valor_diario: number;
  data_inicial: Date | null;
  data_final: Date | null;
}

export interface RealizadoVendedorRow {
  vendedor_venda: number;
  nome: string | null;
  realizado: number;
  pedidos: number;
  lucro: number;
  custo: number;
}

/** Datas e dias úteis do período comissional (26 -> 25), lidas de d_calendario. */
export interface PeriodoComissionalRow {
  data_inicio: string; // 'yyyy-MM-dd'
  data_fim: string; // 'yyyy-MM-dd'
  dias_uteis_total: number;
  dias_uteis_decorridos: number;
}

export interface VendedorAtivoRow {
  rep_codigo: number;
  nome: string;
  papel: string | null;
  local_venda: string | null;
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
      ),
      marg AS (
        SELECT v.CLI_CODIGO,
               SUM(v.lucro) AS lucro_12m,
               SUM(v.liquido_produto) AS base_12m,
               SUM(v.custo_produto) AS custo_12m
        FROM dbo.vw_analise_vendas v
        WHERE v.DT_CANCELAMENTO IS NULL
          AND v.dt_emissao_convertida >= DATEADD(MONTH,-12, CAST(GETDATE() AS date))
          AND v.CLI_CODIGO IN (SELECT cli_codigo FROM atac)
        GROUP BY v.CLI_CODIGO
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
             m.ult_compra_venda,
             COALESCE(g.lucro_12m, 0)           AS lucro_12m,
             COALESCE(g.base_12m, 0)            AS base_12m,
             COALESCE(g.custo_12m, 0)           AS custo_12m
      FROM atac a
      LEFT JOIN dbo.d_cadastro_representantes r ON r.cod = a.rep_codigo
      LEFT JOIN metr m ON m.CLI_CODIGO = a.cli_codigo
      LEFT JOIN marg g ON g.CLI_CODIGO = a.cli_codigo
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

  /** Faturamento mensal de um cliente nos últimos N meses (evolução). */
  async serieMensalCliente(
    cliCodigo: number,
    meses = 12,
  ): Promise<Array<{ ano: number; mes: number; faturamento: number; pedidos: number }>> {
    const query = `
      SELECT n.ano, n.mes,
             SUM(n.valor_nota) AS faturamento,
             COUNT(*) AS pedidos
      FROM (
        SELECT YEAR(v.dt_emissao_convertida) AS ano,
               MONTH(v.dt_emissao_convertida) AS mes,
               v.EMPRESA, v.SERIE, v.NFS,
               MAX(v.TOTAL_NOTA) AS valor_nota
        FROM dbo.vw_analise_vendas v
        WHERE v.CLI_CODIGO = @cli
          AND v.DT_CANCELAMENTO IS NULL
          AND v.dt_emissao_convertida >= DATEADD(MONTH, -@meses, CAST(GETDATE() AS date))
        GROUP BY YEAR(v.dt_emissao_convertida), MONTH(v.dt_emissao_convertida),
                 v.EMPRESA, v.SERIE, v.NFS
      ) n
      GROUP BY n.ano, n.mes
      ORDER BY n.ano, n.mes
    `;
    return this.mssql.query(query, { cli: cliCodigo, meses });
  }

  // ============================ Fase 3 — Metas & Performance ============
  /** Vendedores ativos do módulo de comissões (todos os canais, varejo+atacado). */
  async vendedoresAtivosComissao(): Promise<VendedorAtivoRow[]> {
    const query = `
      SELECT rep_codigo, nome, papel, local_venda
      FROM dbo.ComissaoRepresentante
      WHERE inativo = 0 AND papel IN ('VENDEDOR', 'VENDEDOR_ATACADO')
      ORDER BY nome
    `;
    return this.mssql.query<VendedorAtivoRow>(query);
  }

  /** Metas oficiais do DW (f_metas_vendedores) para um período. */
  async metasDw(ano: number, mes: number): Promise<MetaDwRow[]> {
    const query = `
      SELECT cod_vendedor, vendedor, valor_total, valor_diario, data_inicial, data_final
      FROM dbo.f_metas_vendedores
      WHERE ano = @ano AND mes = @mes
    `;
    return this.mssql.query<MetaDwRow>(query, { ano, mes });
  }

  /**
   * Datas e dias úteis do período comissional (26 -> 25) a partir de d_calendario.
   * `mes` segue a convenção de fechamento: mês em que cai o dia 25 (= mes_comissional).
   * Dias decorridos contam até hoje (0 se o período é futuro; total se já encerrado).
   */
  async periodoComissional(ano: number, mes: number): Promise<PeriodoComissionalRow | null> {
    const query = `
      SELECT CONVERT(varchar(10), MIN(data), 23) AS data_inicio,
             CONVERT(varchar(10), MAX(data), 23) AS data_fim,
             SUM(CAST(is_dia_util AS int)) AS dias_uteis_total,
             SUM(CASE WHEN is_dia_util = 1 AND data <= CAST(GETDATE() AS date)
                      THEN 1 ELSE 0 END) AS dias_uteis_decorridos
      FROM dbo.d_calendario
      WHERE ano_comissional = @ano AND mes_comissional = @mes
    `;
    const rows = await this.mssql.query<PeriodoComissionalRow>(query, { ano, mes });
    const r = rows[0];
    return r && r.data_inicio ? r : null;
  }

  /** Período comissional vigente (o que contém a data de hoje) a partir de d_calendario. */
  async periodoComissionalAtual(): Promise<PeriodoComissionalRow | null> {
    const hoje = await this.mssql.query<{ ano: number; mes: number }>(`
      SELECT ano_comissional AS ano, mes_comissional AS mes
      FROM dbo.d_calendario
      WHERE data = CAST(GETDATE() AS date)
    `);
    const r = hoje[0];
    if (!r) return null;
    return this.periodoComissional(r.ano, r.mes);
  }

  /** Lat/long por código IBGE (para o mapa de calor de vendas por município). */
  async municipiosGeo(): Promise<{ c: number; lat: number; lng: number }[]> {
    return this.mssql.query<{ c: number; lat: number; lng: number }>(`
      SELECT codigo_ibge AS c, latitude AS lat, longitude AS lng
      FROM dbo.vw_municipio_ibge
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    `);
  }

  /** Qtde de clientes distintos com venda no período (replica o card "Qtde de Clientes com vendas"). */
  async clientesComVenda(nomeUpper: string, dataInicio: string, dataFim: string): Promise<number> {
    const rows = await this.mssql.query<{ qtd: number }>(
      `SELECT COUNT(DISTINCT v.CLI_CODIGO) AS qtd
       FROM dbo.vw_analise_vendas v
       WHERE v.DT_CANCELAMENTO IS NULL
         AND LTRIM(RTRIM(UPPER(v.nome_representante))) = @nome
         AND v.dt_emissao_convertida BETWEEN @ini AND @fim`,
      { nome: nomeUpper, ini: dataInicio, fim: dataFim },
    );
    return Number(rows[0]?.qtd ?? 0);
  }

  /** Nome do representante (UPPER/TRIM) para casar com o filtro `vendedor` do Metabase. */
  async nomeRepresentanteComissao(repCodigo: number): Promise<string | null> {
    const rows = await this.mssql.query<{ nome: string }>(
      `SELECT LTRIM(RTRIM(UPPER(nome))) AS nome FROM dbo.ComissaoRepresentante WHERE rep_codigo = @rep`,
      { rep: repCodigo },
    );
    return rows[0]?.nome ?? null;
  }

  /** Faturamento realizado por vendedor no período comissional (todos os canais). */
  async realizadoVendedores(dataInicio: string, dataFim: string): Promise<RealizadoVendedorRow[]> {
    const query = `
      SELECT v.vendedor_venda,
             MAX(v.nome_representante) AS nome,
             SUM(v.total_item) AS realizado,
             COUNT(DISTINCT v.NFS) AS pedidos,
             SUM(v.lucro) AS lucro,
             SUM(v.custo_produto) AS custo
      FROM dbo.vw_analise_vendas v
      WHERE v.DT_CANCELAMENTO IS NULL
        AND v.dt_emissao_convertida BETWEEN @dataInicio AND @dataFim
      GROUP BY v.vendedor_venda
    `;
    return this.mssql.query<RealizadoVendedorRow>(query, { dataInicio, dataFim });
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
