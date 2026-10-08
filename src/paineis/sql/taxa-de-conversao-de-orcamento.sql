-- MANUAL: reescrito em 08/10/2026 (desempenho; mesma regra do card no Metabase). O extrator não sobrescreve.
--
-- Taxa de Conversão de Orçamento (card 345 e cópias): notas de venda ÷ orçamentos distintos nos
-- meses comissionais que o período toca.
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

WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))  -- Field Filter -> vw_d_calendario_tipado.data_date
),
PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
VendSel AS (  -- normaliza vendedor do filtro para propagar às duas fontes
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}  -- Field Filter -> f_metas_vendedores.vendedor
),

-- QTD ORÇAMENTOS (DISTINCT por documento de orçamento)
QtdOrc AS (
  SELECT
    COUNT(DISTINCT o.orcamento) AS qtd_orcamentos
    -- ⚠️ Se o seu ID for outro (ex.: o.orcamento, o.numero), troque aqui.
  FROM dbo.vw_orcamentos o
  JOIN dbo.vw_d_calendario_tipado c
    ON CAST(o.emissao AS date) = c.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE o.emissao >= @ini AND o.emissao < DATEADD(day, 1, @fim)
    AND (UPPER(LTRIM(RTRIM(o.nome_representante))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendSel))
),

-- QTD VENDAS (DISTINCT pelo campo NFS da sua view de vendas)
QtdVend AS (
  SELECT
    COUNT(DISTINCT v.NFS) AS qtd_vendas
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado c
    ON v.dt_emissao_convertida = c.data_date
  JOIN PeriodosSelecionados p
    ON p.mes_comissional = c.mes_comissional
   AND p.ano_comissional = c.ano_comissional
  WHERE v.dt_emissao_convertida >= @ini AND v.dt_emissao_convertida <= @fim
    AND (
    NOT EXISTS (SELECT 1 FROM VendSel)
    OR UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendSel)
  )
)

SELECT
  CASE WHEN qo.qtd_orcamentos = 0 THEN NULL
       ELSE CONVERT(decimal(18,4), 1.0 * qv.qtd_vendas / qo.qtd_orcamentos) END AS conversao_rel  -- 0–1
FROM QtdVend qv
CROSS JOIN QtdOrc qo;
