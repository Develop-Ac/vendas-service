-- MANUAL: reescrito em 08/10/2026 (desempenho; mesma regra do card no Metabase). O extrator não sobrescreve.
--
-- Vendas - Mato Grosso (card 347 e cópias): venda líquida positiva por município de MT/PA
-- no período, casada com o IBGE pelo nome normalizado da cidade.
-- Período direto em f_analise_vendas.dt_emissao_convertida (date, chave do IX_fav_dt; igual a
-- CAST(dt_emissao AS date) em toda a tabela) em vez de casar o calendário por CAST(dt_emissao AS date),
-- que obrigava a varrer a tabela inteira.

WITH VendasFonte AS (
  SELECT
      dbo.f_analise_vendas.UF,
      dbo.f_analise_vendas.cidade,
      dbo.f_analise_vendas.liquido_produto,
      dbo.f_analise_vendas.nome_representante,
      dbo.vw_d_calendario_tipado.data_date
  FROM dbo.f_analise_vendas
  JOIN dbo.vw_d_calendario_tipado
    ON dbo.f_analise_vendas.dt_emissao_convertida = dbo.vw_d_calendario_tipado.data_date
  WHERE
      dbo.f_analise_vendas.UF IN ('MT','PA')
       AND dbo.f_analise_vendas.dt_emissao_convertida >= CAST(@de AS date)
       AND dbo.f_analise_vendas.dt_emissao_convertida < DATEADD(day, 1, CAST(@ate AS date))
       AND {{vendedor:dbo.f_analise_vendas.nome_representante}}
),

VendasComCidadeNorm AS (
  SELECT
      VendasFonte.UF,
      UPPER(LTRIM(RTRIM(
        CASE
          WHEN RIGHT(LTRIM(RTRIM(VendasFonte.cidade)),4)=(' - '+VendasFonte.UF)
            THEN LEFT(LTRIM(RTRIM(VendasFonte.cidade)), LEN(LTRIM(RTRIM(VendasFonte.cidade)))-4)
          ELSE VendasFonte.cidade
        END
      ))) COLLATE Latin1_General_CI_AI AS cidade_norm,
      VendasFonte.liquido_produto
  FROM VendasFonte
)

SELECT
  g.codigo_ibge_str AS codigo_ibge,
  g.uf,
  g.municipio,
  SUM(CASE WHEN v.liquido_produto > 0 THEN v.liquido_produto ELSE 0 END) AS total_vendas
FROM VendasComCidadeNorm v
JOIN dbo.vw_municipio_ibge g
  ON g.uf = v.UF
 AND g.municipio_norm = v.cidade_norm
GROUP BY g.codigo_ibge_str, g.uf, g.municipio
HAVING SUM(CASE WHEN v.liquido_produto > 0 THEN v.liquido_produto ELSE 0 END) > 0
ORDER BY total_vendas DESC;
