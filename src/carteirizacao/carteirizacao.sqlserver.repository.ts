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
  dias_com_venda: number;
  ult_compra_venda: Date | null;
  lucro_12m: number;
  base_12m: number;
  custo_12m: number;
  crediario: string | null;
  con_codigo: number | null;
  limite_credito: number;
  limite_disponivel: number;
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

export interface VendaAposCarteiraRow {
  cli_codigo: number;
  rep_codigo: number;
  rep_nome: string | null;
  valor: number;
  pedidos: number;
  ult_venda: Date | null;
}

// Vendedor "pool" (Lucas Barrada, rep_codigo 316): excluído das sugestões de recarterização.
const REP_DISPONIVEL = 316;

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
          COUNT(DISTINCT CAST(dt AS date)) AS dias_com_venda,
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
      ),
      saldo AS (
        SELECT CLI_CODIGO, SUM(VALOR - VALOR_LIQUIDO_PAGO) AS valor_em_aberto
        FROM dbo.Stage_ContasReceber_Titulos
        WHERE status = 0
          AND DATA_PAGTO IS NULL          -- só títulos NÃO pagos
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
             COALESCE(m.dias_com_venda, 0)      AS dias_com_venda,
             m.ult_compra_venda,
             COALESCE(g.lucro_12m, 0)           AS lucro_12m,
             COALESCE(g.base_12m, 0)            AS base_12m,
             COALESCE(g.custo_12m, 0)           AS custo_12m,
             sc.CREDIARIO                       AS crediario,
             sc.CON_CODIGO                      AS con_codigo,
             COALESCE(sc.LIMITE_CREDITO, 0)     AS limite_credito,
             CASE WHEN sc.CREDIARIO = 'LIBERADO'
                  THEN COALESCE(sc.LIMITE_CREDITO, 0) - COALESCE(sal.valor_em_aberto, 0)
                  ELSE 0 END                    AS limite_disponivel
      FROM atac a
      LEFT JOIN dbo.d_cadastro_representantes r ON r.cod = a.rep_codigo
      LEFT JOIN metr m ON m.CLI_CODIGO = a.cli_codigo
      LEFT JOIN marg g ON g.CLI_CODIGO = a.cli_codigo
      LEFT JOIN dbo.Stage_Clientes sc ON sc.cli_codigo = a.cli_codigo
      LEFT JOIN saldo sal ON sal.CLI_CODIGO = a.cli_codigo
    `;
    return this.mssql.query<ClienteBaseRow>(query);
  }

  /**
   * TODOS os representantes que possuem cliente nas tabelas de atacado (2/5) — parte dos
   * CLIENTES atacado e traz os reps pelo `rep_codigo` deles, independentemente de o rep
   * ainda atuar no atacado. LEFT JOIN no cadastro só para o nome: reps que saíram do
   * atacado (ou não estão mais em d_cadastro_representantes) continuam aparecendo, com
   * fallback "Rep N". Necessário para gerir/redistribuir a carteira de quem saiu.
   */
  async listarVendedoresAtacado(): Promise<VendedorRow[]> {
    const inList = TABELAS_ATACADO.map((t) => `'${t}'`).join(',');
    const query = `
      SELECT c.rep_codigo AS rep_codigo,
             COALESCE(MAX(r.nome_representante), CONCAT('Rep ', c.rep_codigo)) AS rep_nome
      FROM dbo.vw_clientes c
      LEFT JOIN dbo.d_cadastro_representantes r ON r.cod = c.rep_codigo
      WHERE c.tabela_preco IN (${inList}) AND c.rep_codigo IS NOT NULL
      GROUP BY c.rep_codigo
      ORDER BY rep_nome
    `;
    return this.mssql.query<VendedorRow>(query);
  }

  /**
   * Vendas (líquidas) feitas a um conjunto de clientes APÓS uma data de corte específica
   * de cada cliente, agregadas por vendedor — excluindo o próprio pool (203). Usado para
   * sugerir a recarterização dos clientes "disponíveis": quem voltou a vender para eles
   * depois que entraram no pool. Só considera vendas posteriores ao corte (entrada no pool),
   * para não contar vendas anteriores à saída da carteira antiga.
   */
  async vendasAposCarteira(
    itens: Array<{ cli_codigo: number; cutoff: string }>,
  ): Promise<VendaAposCarteiraRow[]> {
    const linhas = itens
      .filter((i) => Number.isInteger(i.cli_codigo) && /^\d{4}-\d{2}-\d{2}$/.test(i.cutoff))
      .map((i) => `(${i.cli_codigo}, '${i.cutoff}')`);
    if (!linhas.length) return [];
    const query = `
      WITH cutoffs (cli_codigo, cutoff) AS (
        SELECT * FROM (VALUES ${linhas.join(',')}) AS t(cli_codigo, cutoff)
      )
      SELECT v.CLI_CODIGO AS cli_codigo,
             v.vendedor_venda AS rep_codigo,
             MAX(v.nome_representante) AS rep_nome,
             SUM(v.liquido_produto) AS valor,
             COUNT(DISTINCT v.NFS) AS pedidos,
             MAX(v.dt_emissao_convertida) AS ult_venda
      FROM dbo.vw_analise_vendas v
      JOIN cutoffs c ON c.cli_codigo = v.CLI_CODIGO
      WHERE v.DT_CANCELAMENTO IS NULL
        AND v.vendedor_venda IS NOT NULL
        AND v.vendedor_venda <> ${REP_DISPONIVEL}
        AND v.dt_emissao_convertida > CAST(c.cutoff AS date)
      GROUP BY v.CLI_CODIGO, v.vendedor_venda
      ORDER BY v.CLI_CODIGO, MAX(v.dt_emissao_convertida) DESC
    `;
    return this.mssql.query<VendaAposCarteiraRow>(query);
  }

  /** Faturamento mensal de um cliente nos últimos N meses (evolução + dias com compra). */
  async serieMensalCliente(
    cliCodigo: number,
    meses = 12,
  ): Promise<Array<{ ano: number; mes: number; faturamento: number; pedidos: number; dias: number }>> {
    const query = `
      SELECT n.ano, n.mes,
             SUM(n.valor_nota) AS faturamento,
             COUNT(*) AS pedidos,
             COUNT(DISTINCT n.dia) AS dias
      FROM (
        SELECT YEAR(v.dt_emissao_convertida) AS ano,
               MONTH(v.dt_emissao_convertida) AS mes,
               v.EMPRESA, v.SERIE, v.NFS,
               MAX(v.TOTAL_NOTA) AS valor_nota,
               MAX(CAST(v.dt_emissao_convertida AS date)) AS dia
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

  /** rep_codigos da equipe do atacado no período (ajustada pelo histórico de canal). */
  async equipeAtacadoReps(dataInicio?: string): Promise<number[]> {
    const rows = await this.equipeAtacado(dataInicio);
    return Array.from(new Set(rows.map((r) => Number(r.rep)).filter((n) => !Number.isNaN(n))));
  }

  /** rep_codigo a partir do nome do representante (para o filtro do supervisor). */
  async repPorNome(nomeUpper: string): Promise<number | null> {
    const rows = await this.mssql.query<{ rep: number }>(
      `SELECT TOP 1 v.vendedor_venda AS rep FROM dbo.vw_analise_vendas v
       WHERE LTRIM(RTRIM(UPPER(v.nome_representante))) = @nome AND v.vendedor_venda IS NOT NULL`,
      { nome: nomeUpper },
    );
    return rows[0]?.rep != null ? Number(rows[0].rep) : null;
  }

  /** Clientes distintos com venda no período, para um conjunto de reps (supervisão). */
  async clientesComVendaReps(reps: number[], dataInicio: string, dataFim: string): Promise<number> {
    const inList = reps.map(Number).filter((n) => !Number.isNaN(n)).join(',');
    if (!inList) return 0;
    const rows = await this.mssql.query<{ qtd: number }>(
      `SELECT COUNT(DISTINCT v.CLI_CODIGO) AS qtd FROM dbo.vw_analise_vendas v
       WHERE v.DT_CANCELAMENTO IS NULL AND v.vendedor_venda IN (${inList})
         AND v.dt_emissao_convertida BETWEEN @ini AND @fim`,
      { ini: dataInicio, fim: dataFim },
    );
    return Number(rows[0]?.qtd ?? 0);
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

  /**
   * Cadastro como fonte da equipe do atacado: representantes ativos marcados como
   * "Vendedor (Atacado)" na tela de Representantes. Garante que rep recém-cadastrado
   * (ainda sem venda no canal) apareça no painel do supervisor e em Metas & Performance.
   * `prio = 2`: o nome do cadastro só é usado quando o rep não tem nome no DW.
   */
  private readonly cadastroAtacadoSel = `
      SELECT cr.rep_codigo AS rep, LTRIM(RTRIM(UPPER(cr.nome))) AS nome, 2 AS prio
      FROM dbo.ComissaoRepresentante cr
      WHERE cr.inativo = 0 AND cr.papel = 'VENDEDOR_ATACADO' AND cr.nome IS NOT NULL`;

  /**
   * 1 nome por rep_codigo, preferindo o nome do DW (`prio` menor) ao do cadastro:
   * é por `nome_representante` que o filtro de vendedor do Metabase casa. Sem isso,
   * um rep cujo nome diverge entre cadastro e DW apareceria duas vezes no dropdown,
   * e a entrada com o nome do cadastro não bateria com venda nenhuma.
   * Espera colunas (rep, nome, prio) na subquery.
   */
  private umNomePorRep(sel: string): string {
    return `SELECT rep, nome FROM (
        SELECT rep, nome, ROW_NUMBER() OVER (PARTITION BY rep ORDER BY prio, nome) AS rn
        FROM (${sel}) t
      ) z WHERE rn = 1`;
  }

  /**
   * Equipe do canal ATACADO para um período (data de início = dia 26).
   * Base: quem tem venda no canal atacado (12 meses) UNIÃO quem está cadastrado como
   * "Vendedor (Atacado)". Ajustada pelo HISTÓRICO de canal (dbo.ComissaoRepresentanteCanal):
   * o canal vigente de cada rep é a última mudança com `vigente_de <= dataInicio`. Remove
   * quem saiu do atacado e inclui quem entrou no atacado naquele período. Se a tabela de
   * histórico não existir, usa só a base.
   */
  async equipeAtacado(dataInicio?: string): Promise<{ rep: number; nome: string }[]> {
    const base = `
      SELECT DISTINCT v.vendedor_venda AS rep, LTRIM(RTRIM(UPPER(v.nome_representante))) AS nome, 1 AS prio
      FROM dbo.vw_analise_vendas v
      WHERE v.local_venda = 'ATACADO' AND v.vendedor_venda IS NOT NULL
        AND v.nome_representante IS NOT NULL
        AND v.dt_emissao_convertida >= DATEADD(MONTH, -12, CAST(GETDATE() AS date))
      UNION ALL
      ${this.cadastroAtacadoSel}`;

    const temHist =
      dataInicio &&
      (await this.mssql.query<{ ok: number }>(
        `SELECT CASE WHEN OBJECT_ID('dbo.ComissaoRepresentanteCanal') IS NULL THEN 0 ELSE 1 END AS ok`,
      ))[0]?.ok === 1;

    if (!temHist) {
      return this.mssql.query<{ rep: number; nome: string }>(this.umNomePorRep(base));
    }

    return this.mssql.query<{ rep: number; nome: string }>(
      `WITH base AS (${base}),
       hist AS (
         SELECT rep_codigo, canal FROM (
           SELECT h.rep_codigo, h.canal,
                  ROW_NUMBER() OVER (PARTITION BY h.rep_codigo ORDER BY h.vigente_de DESC, h.id DESC) rn
           FROM dbo.ComissaoRepresentanteCanal h
           WHERE h.vigente_de <= @ini
         ) z WHERE rn = 1
       ),
       elegiveis AS (
         SELECT b.rep, b.nome, b.prio FROM base b
         WHERE NOT EXISTS (SELECT 1 FROM hist h WHERE h.rep_codigo = b.rep AND h.canal <> 'ATACADO')
         UNION ALL
         SELECT cr.rep_codigo AS rep, LTRIM(RTRIM(UPPER(cr.nome))) AS nome, 2 AS prio
         FROM hist h JOIN dbo.ComissaoRepresentante cr ON cr.rep_codigo = h.rep_codigo
         WHERE h.canal = 'ATACADO' AND cr.nome IS NOT NULL
       )
       ${this.umNomePorRep('SELECT rep, nome, prio FROM elegiveis')}`,
      { ini: dataInicio },
    );
  }

  /** Nomes (UPPER) da equipe do atacado no período. */
  async equipeAtacadoNomes(dataInicio?: string): Promise<string[]> {
    const rows = await this.equipeAtacado(dataInicio);
    return Array.from(new Set(rows.map((r) => r.nome).filter(Boolean)));
  }

  /**
   * Nomes da equipe do atacado no intervalo [ini, fim] — filtro de vendedor do
   * supervisor. Inclui quem vendeu no canal no período E quem está cadastrado como
   * "Vendedor (Atacado)" (rep novo, ainda sem venda, também precisa ser filtrável).
   * Respeita o histórico de canal (exclui quem saiu do atacado até o início do período).
   */
  async equipeAtacadoNomesPeriodo(ini: string, fim: string): Promise<string[]> {
    const baseSel = `
      SELECT DISTINCT v.vendedor_venda AS rep, LTRIM(RTRIM(UPPER(v.nome_representante))) AS nome, 1 AS prio
      FROM dbo.vw_analise_vendas v
      WHERE v.local_venda = 'ATACADO' AND v.vendedor_venda IS NOT NULL
        AND v.nome_representante IS NOT NULL
        AND v.dt_emissao_convertida BETWEEN @ini AND @fim
      UNION ALL
      ${this.cadastroAtacadoSel}`;

    const temHist =
      (await this.mssql.query<{ ok: number }>(
        `SELECT CASE WHEN OBJECT_ID('dbo.ComissaoRepresentanteCanal') IS NULL THEN 0 ELSE 1 END AS ok`,
      ))[0]?.ok === 1;

    const rows = temHist
      ? await this.mssql.query<{ nome: string }>(
          `WITH base AS (${baseSel}),
           hist AS (
             SELECT rep_codigo, canal FROM (
               SELECT h.rep_codigo, h.canal,
                      ROW_NUMBER() OVER (PARTITION BY h.rep_codigo ORDER BY h.vigente_de DESC, h.id DESC) rn
               FROM dbo.ComissaoRepresentanteCanal h WHERE h.vigente_de <= @ini
             ) z WHERE rn = 1
           ),
           elegiveis AS (
             SELECT b.rep, b.nome, b.prio FROM base b
             WHERE NOT EXISTS (SELECT 1 FROM hist h WHERE h.rep_codigo = b.rep AND h.canal <> 'ATACADO')
           )
           ${this.umNomePorRep('SELECT rep, nome, prio FROM elegiveis')}`,
          { ini, fim },
        )
      : await this.mssql.query<{ nome: string }>(this.umNomePorRep(baseSel), { ini, fim });
    return Array.from(new Set(rows.map((r) => r.nome).filter(Boolean)));
  }

  /**
   * Papel (VENDEDOR / VENDEDOR_ATACADO / TECNICO) de TODOS os representantes,
   * 1 por rep_codigo (preferindo o cadastro ativo). Usado pelo filtro de papéis
   * do painel da Gerência — cobre também inativos e técnicos, que têm realizado
   * mas ficam de fora de `vendedoresAtivosComissao`.
   */
  async papeisPorRep(): Promise<{ rep_codigo: number; papel: string | null }[]> {
    return this.mssql.query<{ rep_codigo: number; papel: string | null }>(`
      SELECT rep_codigo, papel FROM (
        SELECT rep_codigo, papel,
               ROW_NUMBER() OVER (PARTITION BY rep_codigo ORDER BY inativo ASC) AS rn
        FROM dbo.ComissaoRepresentante
      ) z WHERE rn = 1`);
  }

  // ===================================== Gerência (empresa toda, todos os canais)
  /** Nomes (UPPER) de TODOS os representantes com venda nos últimos 12 meses (filtro agregado da Gerência). */
  async vendedoresEmpresaNomes(): Promise<string[]> {
    const rows = await this.mssql.query<{ nome: string }>(`
      SELECT DISTINCT LTRIM(RTRIM(UPPER(v.nome_representante))) AS nome
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda IS NOT NULL AND v.nome_representante IS NOT NULL
        AND v.dt_emissao_convertida >= DATEADD(MONTH, -12, CAST(GETDATE() AS date))`);
    return Array.from(new Set(rows.map((r) => r.nome).filter(Boolean)));
  }

  /** rep_codigos de TODOS os representantes com venda nos últimos 12 meses (carteira da Gerência). */
  async vendedoresEmpresaReps(): Promise<number[]> {
    const rows = await this.mssql.query<{ rep: number }>(`
      SELECT DISTINCT v.vendedor_venda AS rep
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda IS NOT NULL
        AND v.dt_emissao_convertida >= DATEADD(MONTH, -12, CAST(GETDATE() AS date))`);
    return Array.from(new Set(rows.map((r) => Number(r.rep)).filter((n) => !Number.isNaN(n))));
  }

  /** Nomes de TODOS os representantes com venda no intervalo [ini, fim] (dropdown de vendedor da Gerência). */
  async vendedoresComVendaNomes(ini: string, fim: string): Promise<string[]> {
    const rows = await this.mssql.query<{ nome: string }>(
      `SELECT DISTINCT LTRIM(RTRIM(UPPER(v.nome_representante))) AS nome
       FROM dbo.vw_analise_vendas v
       WHERE v.DT_CANCELAMENTO IS NULL AND v.vendedor_venda IS NOT NULL AND v.nome_representante IS NOT NULL
         AND v.dt_emissao_convertida BETWEEN @ini AND @fim`,
      { ini, fim },
    );
    return Array.from(new Set(rows.map((r) => r.nome).filter(Boolean)));
  }

  /** Nome do representante (UPPER/TRIM) para casar com o filtro `vendedor` do Metabase. */
  async nomeRepresentanteComissao(repCodigo: number): Promise<string | null> {
    const rows = await this.mssql.query<{ nome: string }>(
      `SELECT LTRIM(RTRIM(UPPER(nome))) AS nome FROM dbo.ComissaoRepresentante WHERE rep_codigo = @rep`,
      { rep: repCodigo },
    );
    return rows[0]?.nome ?? null;
  }

  /**
   * Faturamento realizado por vendedor no período comissional (todos os canais).
   * Usa `liquido_produto` (líquido) — a MESMA base dos painéis do Metabase e das
   * metas — para que realizado/projeção batam com a tela do painel.
   */
  async realizadoVendedores(dataInicio: string, dataFim: string): Promise<RealizadoVendedorRow[]> {
    const query = `
      SELECT v.vendedor_venda,
             MAX(v.nome_representante) AS nome,
             SUM(v.liquido_produto) AS realizado,
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
