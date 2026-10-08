WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional FROM CalendarioFiltrado
),
VendSel AS (  -- carrega filtro de vendedor 1x
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),
VendasAgg AS (  -- receita e custo do(s) mês(es) comissional(is)
  SELECT
    SUM(v.liquido_produto) AS receita_liquida,
    SUM(v.custo_produto)     AS custo_produto   -- AJUSTE 1: nome da coluna de custo total
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(v.dt_emissao AS date) = c.data_date   -- troque para v.emissao se for o seu caso
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional AND p.ano_comissional = c.ano_comissional
  WHERE (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI IN (SELECT vendedor_norm FROM VendSel))
)
SELECT
	receita_liquida,
  	custo_produto,
  	receita_liquida - custo_produto AS lucro_bruto,
  CASE WHEN receita_liquida = 0 THEN NULL
       ELSE CONVERT(decimal(18,4), (receita_liquida - custo_produto) / receita_liquida)
  END AS margem_bruta_pct
FROM VendasAgg;
