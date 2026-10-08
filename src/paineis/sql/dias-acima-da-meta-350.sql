/* Filtros:
   (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))  -> Field Filter: dbo.vw_d_calendario_tipado.data_date
   {{vendedor:dbo.d_cadastro_representantes.nome_representante}} -> Field Filter: dbo.f_metas_vendedores.vendedor   (opcional)
*/

WITH CalendarioFiltrado AS (   -- dias do período (já com is_dia_util no seu view)
  SELECT data_date, mes_comissional, ano_comissional, is_dia_util
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
PeriodosSelecionados AS (      -- meses comissionais do período
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
DiasUteisMes AS (              -- conta dias úteis de CADA mês comissional (mês inteiro)
  SELECT
    p.mes_comissional AS mes,
    p.ano_comissional AS ano,
    COUNT(*) AS dias_uteis_mes
  FROM PeriodosSelecionados p
  JOIN dbo.vw_d_calendario_tipado c
    ON c.mes_comissional = p.mes_comissional
   AND c.ano_comissional = p.ano_comissional
  WHERE c.is_dia_util = 1
  GROUP BY p.mes_comissional, p.ano_comissional
),
VendedoresFiltro AS (          -- onde o Metabase injeta o filtro (pode ficar vazio)
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),
-- meta diária por vendedor e mês comissional
MetasMes AS (
  SELECT
    fm.[Mes] AS mes, fm.[Ano] AS ano,
    UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
    SUM(fm.valor_total) AS valor_total_mes,
    MAX(du.dias_uteis_mes) AS dias_uteis_mes,
    CASE WHEN MAX(du.dias_uteis_mes) > 0
         THEN SUM(fm.valor_total) / MAX(du.dias_uteis_mes)
         ELSE NULL END AS meta_diaria
  FROM dbo.f_metas_vendedores fm
  JOIN DiasUteisMes du
    ON du.mes = fm.[Mes] AND du.ano = fm.[Ano]
  WHERE
    NOT EXISTS (SELECT 1 FROM VendedoresFiltro)
    OR UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI
         IN (SELECT vendedor_norm FROM VendedoresFiltro)
  GROUP BY fm.[Mes], fm.[Ano],
           UPPER(LTRIM(RTRIM(fm.vendedor))) COLLATE Latin1_General_CI_AI
),
-- projeta meta DIÁRIA só nos dias úteis do período
MetaPorDia AS (
  SELECT
    cf.data_date      AS data,
    cf.mes_comissional,
    cf.ano_comissional,
    mm.vendedor_norm,
    mm.meta_diaria
  FROM MetasMes mm
  JOIN CalendarioFiltrado cf
    ON cf.mes_comissional = mm.mes
   AND cf.ano_comissional = mm.ano
  WHERE cf.is_dia_util = 1
),
-- vendas por dia e vendedor dentro do período
VendasPorDia AS (
  SELECT v.data, v.vendedor_norm, v.vendas_dia
  FROM dbo.f_vendas_dia_vendedor v
  JOIN CalendarioFiltrado cf
    ON cf.data_date = v.data
  WHERE
    NOT EXISTS (SELECT 1 FROM VendedoresFiltro)
    OR v.vendedor_norm IN (SELECT vendedor_norm FROM VendedoresFiltro)
),
-- compara vendas do dia x meta diária (somente em dias úteis, pois a meta é projetada neles)
Comparacao AS (
  SELECT
    m.ano_comissional,
    m.mes_comissional,
    m.data,
    m.vendedor_norm,
    COALESCE(v.vendas_dia, 0) AS vendas_dia,
    m.meta_diaria,
    CASE WHEN COALESCE(v.vendas_dia, 0) > m.meta_diaria THEN 1 ELSE 0 END AS acima_meta
  FROM MetaPorDia m
  LEFT JOIN VendasPorDia v
    ON v.data = m.data AND v.vendedor_norm = m.vendedor_norm
)
SELECT
  DATEFROMPARTS(c.ano_comissional, c.mes_comissional, 1) AS mes_ref,
  FORMAT(DATEFROMPARTS(c.ano_comissional, c.mes_comissional, 1),
         'MMMM/yyyy', 'pt-BR')                           AS mes_label,
  c.vendedor_norm                                       AS vendedor,
  SUM(c.acima_meta)                                     AS dias_acima_da_meta,
  COUNT(*)                                              AS dias_uteis_avaliados
FROM Comparacao c
GROUP BY c.vendedor_norm, c.ano_comissional, c.mes_comissional
ORDER BY mes_ref, vendedor;
