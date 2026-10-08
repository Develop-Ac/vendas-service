WITH CalendarioFiltrado AS (
  SELECT
    data_date,
    mes_comissional,
    ano_comissional
  FROM dbo.vw_d_calendario_tipado   -- sem alias aqui
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))                 -- Field Filter -> vw_d_calendario_tipado.data_date
),
PeriodosSelecionados AS (
  SELECT DISTINCT
         mes_comissional,
         ano_comissional
  FROM CalendarioFiltrado           -- daqui em diante pode usar alias normalmente
),
MetasFiltradas AS (
  SELECT *
  FROM dbo.f_metas_vendedores
  WHERE 1=1 AND {{vendedor:dbo.f_metas_vendedores.vendedor}}    -- Field Filter em f_metas_vendedores.vendedor (ou cod_vendedor)
),
MetasPorPeriodo AS (
  SELECT
      m.ano,
      m.mes,
      m.cod_vendedor,
      m.vendedor,
      SUM(m.valor_total) AS meta_periodo
  FROM MetasFiltradas m
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = m.mes
   AND p.ano_comissional = m.ano
  GROUP BY m.ano, m.mes, m.cod_vendedor, m.vendedor
)
SELECT SUM(meta_periodo) AS meta_total
FROM MetasPorPeriodo;
