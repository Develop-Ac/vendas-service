-- MANUAL: reescrito em 08/10/2026 (desempenho; mesma regra do card no Metabase). O extrator não sobrescreve.
--
-- Meta Valor Venda Diária (card 367, supervisão do atacado): venda e meta diária por vendedor no período.
-- Período direto em f_analise_vendas.dt_emissao_convertida (date, chave do IX_fav_dt; igual a
-- CAST(dt_emissao AS date) em toda a tabela) em vez de casar o calendário por CAST(dt_emissao AS date),
-- que obrigava a varrer a tabela inteira.

SET DATEFIRST 1; -- segunda = 1

WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional, is_dia_util
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),

PeriodosSelecionados AS (
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),

DiasMes AS (
  SELECT
    p.mes_comissional AS mes,
    p.ano_comissional AS ano,

    -- seg a sex
    SUM(CASE 
        WHEN DATEPART(WEEKDAY,c.data_date) BETWEEN 1 AND 5 
         AND c.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_semana,

    -- sábado
    SUM(CASE 
        WHEN DATEPART(WEEKDAY,c.data_date) = 6 
         AND c.is_dia_util = 1 THEN 1 ELSE 0 END) AS sabados

  FROM PeriodosSelecionados p
  JOIN dbo.vw_d_calendario_tipado c
    ON c.mes_comissional = p.mes_comissional
   AND c.ano_comissional = p.ano_comissional
  GROUP BY p.mes_comissional, p.ano_comissional
),

VendedoresFiltro AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),

MetasMes AS (
  SELECT
    fm.[Mes] AS mes,
    fm.[Ano] AS ano,
    UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
    SUM(fm.valor_total) AS meta_mes,

    MAX(dm.dias_semana) AS dias_semana,
    MAX(dm.sabados) AS sabados,

    -- 🧠 meta base redistribuída
    CASE 
      WHEN (MAX(dm.dias_semana) + (MAX(dm.sabados)*0.5)) > 0
      THEN SUM(fm.valor_total) / (MAX(dm.dias_semana) + (MAX(dm.sabados)*0.5))
      ELSE NULL
    END AS meta_base

  FROM dbo.f_metas_vendedores fm
  JOIN DiasMes dm
    ON dm.mes = fm.[Mes] AND dm.ano = fm.[Ano]

  WHERE
    NOT EXISTS (SELECT 1 FROM VendedoresFiltro)
    OR UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendedoresFiltro)

  GROUP BY fm.[Mes], fm.[Ano],
           UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI
),

MetaPorDia AS (
  SELECT
    cf.data_date AS data,
    mm.vendedor_norm,

    CASE 
      WHEN DATEPART(WEEKDAY,cf.data_date) = 6 
        THEN mm.meta_base * 0.5     -- sábado 50%
      WHEN DATEPART(WEEKDAY,cf.data_date) BETWEEN 1 AND 5
        THEN mm.meta_base           -- seg-sex redistribuído
      ELSE NULL
    END AS meta_diaria

  FROM MetasMes mm
  JOIN CalendarioFiltrado cf
    ON cf.mes_comissional = mm.mes
   AND cf.ano_comissional = mm.ano
  WHERE cf.is_dia_util = 1
),

VendasPorDia AS (
  SELECT
    v.dt_emissao_convertida AS data,
    UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
    SUM(v.liquido_produto) AS vendas_dia
  FROM dbo.f_analise_vendas v
  JOIN CalendarioFiltrado cf
    ON cf.data_date = v.dt_emissao_convertida
  WHERE
    v.dt_emissao_convertida >= CAST(@de AS date)
    AND v.dt_emissao_convertida < DATEADD(day, 1, CAST(@ate AS date))
    AND (NOT EXISTS (SELECT 1 FROM VendedoresFiltro)
    OR UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
       IN (SELECT vendedor_norm FROM VendedoresFiltro))
  GROUP BY v.dt_emissao_convertida,
           UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
)

SELECT
  COALESCE(v.data, m.data) AS data,
  COALESCE(v.vendedor_norm, m.vendedor_norm) AS vendedor,
  v.vendas_dia,
  m.meta_diaria
FROM VendasPorDia v
FULL OUTER JOIN MetaPorDia m
  ON m.data = v.data AND m.vendedor_norm = v.vendedor_norm
ORDER BY data, vendedor;
