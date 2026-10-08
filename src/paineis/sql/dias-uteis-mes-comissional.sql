WITH PeriodosSelecionados AS (
  SELECT DISTINCT
         mes_comissional,
         ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))  -- Field Filter -> vw_d_calendario_tipado.data_date
),
DiasUteisPorPeriodo AS (
  SELECT
      v2.mes_comissional,
      v2.ano_comissional,
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis_mes
  FROM dbo.vw_d_calendario_tipado v2         -- calendário SEM filtro, para contar o mês inteiro
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = v2.data_date   -- usa o flag d.is_dia_util
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = v2.mes_comissional
   AND p.ano_comissional = v2.ano_comissional
  GROUP BY v2.mes_comissional, v2.ano_comissional
)
SELECT
  SUM(dias_uteis_mes) AS dias_uteis_totais_comissional
FROM DiasUteisPorPeriodo;
