/* CARD: VENDAS PROJETADAS TOTAIS NO PERÍODO FILTRADO */

WITH CalendarioFiltrado AS (
  SELECT
      data_date
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),

LimitesPeriodo AS (
  SELECT
      MIN(data_date) AS data_ini,
      MAX(data_date) AS data_fim_original
  FROM CalendarioFiltrado
),

DataFim AS (
  SELECT
    CASE
      WHEN lp.data_fim_original > CAST(GETDATE() AS date)
        THEN CAST(GETDATE() AS date)
      ELSE lp.data_fim_original
    END AS data_fim,
    lp.data_ini,
    lp.data_fim_original
  FROM LimitesPeriodo lp
),

-- 🔧 VendSel corrigido: vazio quando não há filtro
VendSel AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1 = 2 OR {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),

DiasUteisPeriodo AS (
  SELECT
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis_periodo
  FROM CalendarioFiltrado cf
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = cf.data_date
  CROSS JOIN DataFim df
  WHERE cf.data_date <= df.data_fim
),

VendasPeriodo AS (
  SELECT
      SUM(v.liquido_produto) AS total_vendas_periodo
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(v.dt_emissao AS date) = c.data_date
  CROSS JOIN DataFim df
  WHERE c.data_date BETWEEN df.data_ini AND df.data_fim
    AND (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
         IN (SELECT vendedor_norm FROM VendSel))
),

DiasUteisRestantes AS (
  SELECT
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis_restantes
  FROM dbo.vw_d_calendario_tipado cal
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = cal.data_date
  CROSS JOIN DataFim df
  WHERE cal.data_date > df.data_fim
    AND cal.data_date <= df.data_fim_original
)

SELECT
  df.data_ini                   AS periodo_ini,
  df.data_fim_original          AS periodo_fim,
  df.data_fim                   AS data_corte_utilizada,

  du.dias_uteis_periodo,
  dur.dias_uteis_restantes,
  vp.total_vendas_periodo,

  CASE WHEN du.dias_uteis_periodo = 0 THEN NULL
       ELSE CONVERT(decimal(18,2),
                    vp.total_vendas_periodo * 1.0 / du.dias_uteis_periodo)
  END AS media_vendas_diaria_periodo,

  CASE WHEN du.dias_uteis_periodo = 0 THEN NULL
       ELSE CONVERT(decimal(18,2),
                    (vp.total_vendas_periodo * 1.0 / du.dias_uteis_periodo)
                    * dur.dias_uteis_restantes)
  END AS proj_adicional,

  CASE WHEN du.dias_uteis_periodo = 0 THEN NULL
       ELSE CONVERT(decimal(18,2),
                    vp.total_vendas_periodo
                    + (vp.total_vendas_periodo * 1.0 / du.dias_uteis_periodo)
                      * dur.dias_uteis_restantes)
  END AS vendas_projetadas_total

FROM DataFim df
CROSS JOIN DiasUteisPeriodo du
CROSS JOIN VendasPeriodo vp
CROSS JOIN DiasUteisRestantes dur;
