WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))                              -- Field Filter -> vw_d_calendario_tipado.data_date
),
PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
MetasFiltradas AS (
  SELECT *
  FROM dbo.f_metas_vendedores
  WHERE 1=1 AND {{vendedor:dbo.f_metas_vendedores.vendedor}}                 -- Field Filter -> f_metas_vendedores.vendedor
),
MetasPorPeriodo AS (
  SELECT
      m.ano,
      m.mes,
      UPPER(LTRIM(RTRIM(m.vendedor))) AS vendedor_norm,
      SUM(m.valor_total) AS meta_periodo
  FROM MetasFiltradas m
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = m.mes
   AND p.ano_comissional = m.ano
  GROUP BY m.ano, m.mes, UPPER(LTRIM(RTRIM(m.vendedor)))
),
MetasTotal AS (
  SELECT SUM(meta_periodo) AS meta_total
  FROM MetasPorPeriodo
),
VendasFiltradas AS (
  SELECT v.liquido_produto
  FROM dbo.f_analise_vendas v
  WHERE EXISTS (
    SELECT 1 FROM CalendarioFiltrado c
    WHERE CAST(v.dt_emissao AS date) = c.data_date
  )
  AND EXISTS (
    SELECT 1 FROM MetasFiltradas mf
    WHERE UPPER(LTRIM(RTRIM(mf.vendedor))) = UPPER(LTRIM(RTRIM(v.nome_representante)))
  )
),
VendasTotal AS (
  SELECT SUM(liquido_produto) AS total_vendas
  FROM VendasFiltradas
)
SELECT
  COALESCE(vt.total_vendas,0) - COALESCE(mt.meta_total,0) AS kpi_vendas_menos_meta
FROM VendasTotal vt
CROSS JOIN MetasTotal mt; 
