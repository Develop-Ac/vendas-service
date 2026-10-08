WITH Hoje AS (
  SELECT CAST(GETDATE() AS date) AS data_hoje
),
PeriodoAtual AS (
  SELECT TOP (1)
         v.mes_comissional,
         v.ano_comissional
  FROM dbo.vw_d_calendario_tipado v
  CROSS JOIN Hoje h
  WHERE v.data_date = h.data_hoje
),
DiasUteisRestantes AS (
  SELECT
    COUNT(*) AS dias_uteis_restantes
  FROM dbo.vw_d_calendario_tipado v
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = v.data_date
  CROSS JOIN Hoje h
  CROSS JOIN PeriodoAtual p
  WHERE v.mes_comissional = p.mes_comissional
    AND v.ano_comissional = p.ano_comissional
    AND v.data_date >= h.data_hoje            -- troque para >= para incluir hoje, se ele for útil
    AND d.is_dia_util = 1
)
SELECT dias_uteis_restantes
FROM DiasUteisRestantes;
