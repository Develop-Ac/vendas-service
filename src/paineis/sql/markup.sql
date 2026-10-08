WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))  -- Field Filter -> vw_d_calendario_tipado.data_date
),
PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
VendSel AS (  -- carrega o filtro de vendedor 1x (normalizado)
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}  -- Field Filter -> f_metas_vendedores.vendedor
),
VendasAgg AS (  -- soma receita e custo do(s) mês(es) comissional(is) tocados
  SELECT
    SUM(v.liquido_produto)                              AS receita_liquida,
    SUM(CAST(v.custo_produto AS decimal(18,6)))         AS custo_total  -- use sua coluna de custo total
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(
         /* Se sua coluna for 'emissao', troque para v.emissao */
         v.dt_emissao AS date
       ) = c.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE (
    NOT EXISTS (SELECT 1 FROM VendSel)  -- sem filtro → pega todos
    OR UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendSel)
  )
)
SELECT
  -- % aplicado sobre o custo (MARKUP%)
  CASE WHEN custo_total = 0 THEN NULL
       ELSE CONVERT(decimal(18,4), (receita_liquida - custo_total) / custo_total)
  END AS markup_aplicado_pct

FROM VendasAgg;
