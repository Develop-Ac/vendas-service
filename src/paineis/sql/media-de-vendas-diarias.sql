WITH CalendarioFiltrado AS (               -- 1 único filtro de data aqui
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))                        -- Field Filter -> vw_d_calendario_tipado.data_date
),

-- Data final "inteligente":
-- - se o usuário filtrou até uma data FUTURA, usa hoje
-- - se filtrou até hoje ou uma data passada, usa o próprio MAX(data_date)
DataFim AS (
  SELECT
    CASE
      WHEN MAX(data_date) > CAST(GETDATE() AS date)
        THEN CAST(GETDATE() AS date)      -- trava na data de hoje
      ELSE MAX(data_date)                 -- usa a última data realmente filtrada
    END AS data_fim
  FROM CalendarioFiltrado
),

PeriodosSelecionados AS (                   -- meses comissionais tocados
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),

VendSel AS (                                -- carrega filtro de vendedor (se houver)
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}           -- Field Filter -> f_metas_vendedores.vendedor
),

-- Dias úteis acumulados ATÉ a data final "inteligente", somados nos meses comissionais tocados
DiasUteisAteFim AS (
  SELECT
      SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis_ate_fim_total
  FROM dbo.vw_d_calendario_tipado v
  JOIN dbo.d_calendario d
    ON CAST(d.data AS date) = v.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = v.mes_comissional
   AND p.ano_comissional = v.ano_comissional
  CROSS JOIN DataFim df
  WHERE v.data_date <= df.data_fim         -- aqui já está respeitando HOJE se o filtro for futuro
),

-- Total de vendas nos mesmos meses comissionais (filtrando vendedor se aplicado)
VendasTotal AS (
  SELECT
      SUM(v.liquido_produto) AS total_vendas
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(v.dt_emissao AS date) = c.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE (
    NOT EXISTS (SELECT 1 FROM VendSel)  -- sem filtro de vendedor → todos
    OR UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendSel)
  )
)

SELECT
  CASE WHEN du.dias_uteis_ate_fim_total = 0 THEN NULL
       ELSE CONVERT(decimal(18,2), vt.total_vendas * 1.0 / du.dias_uteis_ate_fim_total)
  END AS media_vendas_diaria_ate_data_final
FROM VendasTotal vt
CROSS JOIN DiasUteisAteFim du;
