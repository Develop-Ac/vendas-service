-- MANUAL: reescrito em 08/10/2026 (desempenho; mesma regra do card no Metabase). O extrator não sobrescreve.
--
-- % Conversão de Orçamentos (card 361 e cópias): valor vendido ÷ valor orçado nos meses
-- comissionais que o período toca.
-- @ini/@fim = primeiro e último dia desses meses: vendas por intervalo em dt_emissao_convertida
-- (IX_fav_dt) em vez de CAST(dt_emissao AS date) sem índice. vw_orcamentos (Stage_Orcamentos) não tem
-- índice: o intervalo só corta linhas antes do join.

DECLARE @ini date, @fim date;
SELECT @ini = MIN(c.data_date), @fim = MAX(c.data_date)
FROM dbo.vw_d_calendario_tipado c
WHERE EXISTS (
  SELECT 1 FROM dbo.vw_d_calendario_tipado f
  WHERE f.data_date >= CAST(@de AS date) AND f.data_date < DATEADD(day, 1, CAST(@ate AS date))
    AND f.mes_comissional = c.mes_comissional AND f.ano_comissional = c.ano_comissional
);

WITH CalendarioFiltrado AS (   -- 1 único filtro de data
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))                           -- Field Filter -> vw_d_calendario_tipado.data_date
),
PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
VendedoresFiltrados AS (       -- carrega o filtro de vendedor 1x
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}              -- Field Filter -> f_metas_vendedores.vendedor
),

-- VENDAS por período comissional e vendedor
VendasPorPeriodo AS (
  SELECT
      c.mes_comissional,
      c.ano_comissional,
      UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
      SUM(v.liquido_produto) AS total_vendas
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON v.dt_emissao_convertida = c.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE v.dt_emissao_convertida >= @ini AND v.dt_emissao_convertida <= @fim
    AND (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
            IN (SELECT vendedor_norm FROM VendedoresFiltrados))
  GROUP BY c.mes_comissional, c.ano_comissional,
           UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
),

-- ORÇAMENTOS por período comissional e vendedor
OrcamentosPorPeriodo AS (
  SELECT
      c.mes_comissional,
      c.ano_comissional,
      UPPER(LTRIM(RTRIM(o.nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
      SUM(o.total) AS total_orcamentos
  FROM dbo.vw_orcamentos o
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(o.emissao AS date) = c.data_date   -- << você já confirmou que é 'emissao'
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE o.emissao >= @ini AND o.emissao < DATEADD(day, 1, @fim)
    AND (NOT EXISTS (SELECT 1 FROM VendedoresFiltrados)
         OR UPPER(LTRIM(RTRIM(o.nome_representante))) COLLATE Latin1_General_CI_AI
            IN (SELECT vendedor_norm FROM VendedoresFiltrados))
  GROUP BY c.mes_comissional, c.ano_comissional,
           UPPER(LTRIM(RTRIM(o.nome_representante))) COLLATE Latin1_General_CI_AI
),

VendasTotal AS (SELECT SUM(total_vendas) AS total_vendas FROM VendasPorPeriodo),
OrcamentosTotal AS (SELECT SUM(total_orcamentos) AS total_orcamentos FROM OrcamentosPorPeriodo)

SELECT
    CASE WHEN COALESCE(ot.total_orcamentos,0) = 0 THEN NULL
       ELSE CONVERT(decimal(18,4), vt.total_vendas / ot.total_orcamentos) END AS conversao_rel  -- 0–1
FROM VendasTotal vt
CROSS JOIN OrcamentosTotal ot;
