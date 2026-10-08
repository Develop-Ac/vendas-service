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
BaseFiltrada AS (
  SELECT
    v.mix_custo,
    v.liquido_produto
  FROM dbo.f_analise_vendas v
  JOIN CalendarioFiltrado c
    ON v.dt_emissao_convertida = c.data_date
  JOIN VendedoresFiltrados mv
    ON mv.vendedor = v.nome_representante
  WHERE v.mix_custo IS NOT NULL
),
Totais AS (
  SELECT SUM(liquido_produto) AS total_faturamento
  FROM BaseFiltrada
),
PctPorMix AS (
  SELECT
    mix_custo,
    SUM(liquido_produto) / NULLIF((SELECT total_faturamento FROM Totais), 0) AS pct_participacao
  FROM BaseFiltrada
  GROUP BY mix_custo
)
SELECT
  SUM(CASE WHEN mix_custo = 1 THEN pct_participacao ELSE 0 END) AS pct_mix1
FROM PctPorMix;
