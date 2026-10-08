SET DATEFIRST 1;  -- 1 = Segunda-feira

WITH CalendarioFiltrado AS (
  SELECT data_date
  FROM dbo.vw_d_calendario_tipado
  WHERE 1=1
  AND (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
VendedoresFiltrados AS (
  SELECT DISTINCT nome_representante AS vendedor
  FROM dbo.d_cadastro_representantes
  WHERE 1=1
  AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),
Base AS (
  SELECT
    DATEPART(WEEKDAY, v.dt_emissao_convertida) AS ordem_dia,
    v.liquido_produto
  FROM dbo.f_analise_vendas v
  JOIN CalendarioFiltrado c
    ON v.dt_emissao_convertida = c.data_date
  JOIN VendedoresFiltrados mv
    ON mv.vendedor = v.nome_representante
  WHERE v.dt_emissao_convertida IS NOT NULL
)
SELECT
  CASE ordem_dia
    WHEN 1 THEN 'Segunda'
    WHEN 2 THEN 'Terça'
    WHEN 3 THEN 'Quarta'
    WHEN 4 THEN 'Quinta'
    WHEN 5 THEN 'Sexta'
    WHEN 6 THEN 'Sábado'
  END AS dia_semana,
  SUM(liquido_produto) AS valor_vendido
FROM Base
WHERE ordem_dia BETWEEN 1 AND 6
GROUP BY ordem_dia
ORDER BY ordem_dia;
