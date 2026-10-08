/* Filtros do painel:
   (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))  -> Field Filter: dbo.vw_d_calendario_tipado.data_date
   {{vendedor:dbo.d_cadastro_representantes.nome_representante}} -> Field Filter: dbo.f_metas_vendedores.vendedor  (opcional)
*/

WITH CalendarioFiltrado AS (
  SELECT data_date
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
VendedoresFiltro AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),
Base AS (
  SELECT
    -- O nome do vendedor só é usado para o filtro, não mais para agrupamento
    UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
    NULLIF(LTRIM(RTRIM(v.grp_descricao)), '') AS grp_descricao,
    NULLIF(LTRIM(RTRIM(v.subgrp_descricao)), '') AS subgrp_descricao,
    CASE WHEN v.liquido_produto > 0 THEN v.liquido_produto ELSE 0 END AS valor_pos
  FROM dbo.f_analise_vendas v
  JOIN CalendarioFiltrado cf
    ON v.dt_emissao_convertida = cf.data_date -- Usando a coluna segura que criamos antes
  WHERE
    -- Lógica de filtro mantida: se o filtro de vendedor estiver vazio, essa CTE VendedoresFiltro
    -- contém todos os vendedores da f_metas_vendedores, restringindo a análise a eles.
    -- Para incluir TODOS os vendedores (mesmo os sem meta), a lógica precisaria mudar.
    UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
      IN (SELECT vendedor_norm FROM VendedoresFiltro)
),
-- REMOVIDA a CTE 'TotaisVendedor', pois vamos calcular o total de outra forma.

-- A CTE 'Mix' agora agrupa apenas pelo que será exibido, somando as vendas de todos os vendedores.
Mix AS (
  SELECT
    COALESCE(b.grp_descricao, 'SEM GRUPO') AS grupo,
    SUM(b.valor_pos) AS valor_vendas
  FROM Base b
  GROUP BY
    COALESCE(b.grp_descricao, 'SEM GRUPO')
)
-- O SELECT FINAL agora usa uma função de janela para obter o total geral.
SELECT
  m.grupo,
  m.valor_vendas,
  -- A MUDANÇA PRINCIPAL: Calcula o percentual sobre o total geral de vendas na janela de resultados.
  CASE WHEN SUM(m.valor_vendas) OVER () > 0
       THEN (m.valor_vendas * 1.0 / SUM(m.valor_vendas) OVER ())*100
       ELSE 0 END AS Percentul_Mix
FROM Mix m
ORDER BY valor_vendas DESC;
