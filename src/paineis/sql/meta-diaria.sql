WITH PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))   -- Field Filter -> vw_d_calendario_tipado.data_date
),
DiasUteisPorPeriodo AS (
  SELECT
      v.mes_comissional,
      v.ano_comissional,
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis
  FROM dbo.vw_d_calendario_tipado v
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = v.data_date       -- pega TODAS as datas do mês comissional
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = v.mes_comissional
   AND p.ano_comissional = v.ano_comissional
  GROUP BY v.mes_comissional, v.ano_comissional
),
MetasFiltradas AS (
  SELECT ano, mes, vendedor, valor_total
  FROM dbo.f_metas_vendedores
  WHERE 1=1 AND {{vendedor:dbo.f_metas_vendedores.vendedor}}  -- Field Filter -> f_metas_vendedores.vendedor
),
MetasPorPeriodo AS (
  SELECT m.ano, m.mes, SUM(m.valor_total) AS meta_periodo
  FROM MetasFiltradas m
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = m.mes
   AND p.ano_comissional = m.ano
  GROUP BY m.ano, m.mes
),
Totais AS (
  SELECT
    SUM(mp.meta_periodo) AS meta_total,
    SUM(dup.dias_uteis)  AS dias_uteis_total
  FROM MetasPorPeriodo mp
  JOIN DiasUteisPorPeriodo dup
    ON dup.mes_comissional = mp.mes
   AND dup.ano_comissional = mp.ano
)
SELECT
  CASE WHEN dias_uteis_total = 0 THEN NULL
       ELSE CONVERT(decimal(18,2), meta_total * 1.0 / dias_uteis_total)
  END AS meta_diaria
FROM Totais;
