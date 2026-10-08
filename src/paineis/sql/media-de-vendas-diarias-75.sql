WITH CalendarioFiltrado AS (               -- 1 único filtro de data aqui
  SELECT 
      data_date,
      mes_comissional,
      ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))                        -- Field Filter -> vw_d_calendario_tipado.data_date
),

-- Limites do período filtrado
LimitesPeriodo AS (
  SELECT
      MIN(data_date) AS data_ini,
      MAX(data_date) AS data_fim_original
  FROM CalendarioFiltrado
),

-- Data final "inteligente": usa hoje se o filtro for futuro
DataLimite AS (
  SELECT
      lp.data_ini,
      CASE
        WHEN lp.data_fim_original > CAST(GETDATE() AS date)
             THEN CAST(GETDATE() AS date)
        ELSE lp.data_fim_original
      END AS data_fim
  FROM LimitesPeriodo lp
),

-- Filtro opcional de vendedor (truque p/ Metabase: vazio quando não há filtro)
VendSel AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1 = 2 OR {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),

-- Dias úteis DENTRO DO PERÍODO FILTRADO (de data_ini até data_fim)
DiasUteisPeriodo AS (
  SELECT
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis_periodo
  FROM CalendarioFiltrado cf
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = cf.data_date
  CROSS JOIN DataLimite dl
  WHERE cf.data_date BETWEEN dl.data_ini AND dl.data_fim
),

-- Total de vendas DENTRO DO PERÍODO FILTRADO (de data_ini até data_fim)
VendasPeriodo AS (
  SELECT
      SUM(v.liquido_produto) AS total_vendas_periodo
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(v.dt_emissao AS date) = c.data_date
  CROSS JOIN DataLimite dl
  WHERE c.data_date BETWEEN dl.data_ini AND dl.data_fim
    AND (
      NOT EXISTS (SELECT 1 FROM VendSel)    -- sem filtro de vendedor → todos
      OR UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
         IN (SELECT vendedor_norm FROM VendSel)
    )
)

SELECT
  du.dias_uteis_periodo,
  vp.total_vendas_periodo,
  CASE 
    WHEN du.dias_uteis_periodo = 0 THEN NULL
    ELSE CONVERT(decimal(18,2),
                 vp.total_vendas_periodo * 1.0 / du.dias_uteis_periodo)
  END AS media_vendas_diaria_periodo
FROM DiasUteisPeriodo du
CROSS JOIN VendasPeriodo vp;
