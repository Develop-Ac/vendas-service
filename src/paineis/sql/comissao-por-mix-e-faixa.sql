-- MANUAL: reescrito em 08/10/2026 (desempenho; mesma regra do card no Metabase). O extrator não sobrescreve.
--
-- Comissão Por Mix e Faixa (card 422, atacado): tabela de comissão por mix/faixa do período.
-- Período direto em f_analise_vendas.dt_emissao_convertida (date, chave do IX_fav_dt; igual a
-- CAST(dt_emissao AS date) em toda a tabela) em vez de casar o calendário por CAST(dt_emissao AS date),
-- que obrigava a varrer a tabela inteira.
-- A venda filtrada é agregada uma vez por (mix, faixa) em @base: como CTE, BaseVendas era
-- reavaliada por cada referência (Totais, Regra, AliquotaMix23...), relendo f_analise_vendas várias vezes.

DECLARE @base TABLE (mix_custo tinyint, faixa_mix char(1) COLLATE Latin1_General_CI_AS, liquido_produto decimal(38,6));

WITH CalendarioFiltrado AS (
  SELECT data_date
  FROM dbo.vw_d_calendario_tipado
  WHERE 1=1
  AND (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
VendedoresFiltrados AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
)
INSERT INTO @base (mix_custo, faixa_mix, liquido_produto)
SELECT v.mix_custo, v.faixa_mix, SUM(v.liquido_produto)
FROM dbo.f_analise_vendas v
JOIN CalendarioFiltrado c
  ON v.dt_emissao_convertida = c.data_date
WHERE v.dt_emissao_convertida >= CAST(@de AS date)
  AND v.dt_emissao_convertida < DATEADD(day, 1, CAST(@ate AS date))
  AND v.mix_custo IS NOT NULL
  AND v.faixa_mix IS NOT NULL
  AND (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
         IN (SELECT vendedor_norm FROM VendedoresFiltrados))
GROUP BY v.mix_custo, v.faixa_mix;

WITH BaseVendas AS (
  SELECT mix_custo, faixa_mix, liquido_produto FROM @base
),
Totais AS (
  SELECT
    SUM(liquido_produto) AS total_geral,
    SUM(CASE WHEN mix_custo = 1 THEN liquido_produto ELSE 0 END) AS total_mix1
  FROM BaseVendas
),
Regra AS (
  SELECT
    -- escada do MIX1 (set/26): multiplicador pela participacao do mix 1 na venda do periodo
    CASE
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.30 THEN 2.00
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.26 THEN 1.50
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.22 THEN 1.25
      ELSE 1.00
    END AS mult_mix1
  FROM Totais
),
AliquotaMix23 AS (
  SELECT
    CASE
      WHEN total_geral IS NULL OR total_geral <= 0 THEN 0.0000
      WHEN total_geral <= 70000.00  THEN 0.0085
      WHEN total_geral <= 100000.00 THEN 0.0100
      WHEN total_geral <= 130000.00 THEN 0.0110
      WHEN total_geral <= 160000.00 THEN 0.0115
      WHEN total_geral <= 180000.00 THEN 0.0120
      ELSE 0.0130
    END AS pct_mix23
  FROM Totais
),
VendasAgrupadas AS (
  SELECT
    mix_custo,
    faixa_mix,
    SUM(liquido_produto) AS valor_vendido
  FROM BaseVendas
  GROUP BY mix_custo, faixa_mix
),
TabelaComissao AS (
  SELECT
    va.mix_custo,
    va.faixa_mix,
    va.valor_vendido,
    CASE
      WHEN va.mix_custo IN (2,3) THEN (SELECT pct_mix23 FROM AliquotaMix23)

      WHEN va.mix_custo = 1 THEN
        -- base por faixa x degrau (1,00 / 1,25 / 1,50 / 2,00)
        (SELECT mult_mix1 FROM Regra) *
        CASE va.faixa_mix
          WHEN 'A' THEN 0.0400
          WHEN 'B' THEN 0.0300
          WHEN 'C' THEN 0.0300
          WHEN 'D' THEN 0.0200
          ELSE 0
        END

      ELSE 0
    END AS pct_comissao
  FROM VendasAgrupadas va
),
Detalhe AS (
  SELECT
    mix_custo AS mix,
    faixa_mix AS faixa,
    valor_vendido,
    pct_comissao,
    (valor_vendido * pct_comissao) AS valor_comissao
  FROM TabelaComissao
),

-- ✅ SUBTOTAL por MIX (aparece depois das faixas do mix)
SubtotalMix AS (
  SELECT
    mix,
    'TOTAL' AS faixa,
    SUM(valor_vendido) AS valor_vendido,
    CASE WHEN SUM(valor_vendido) = 0 THEN NULL
         ELSE SUM(valor_comissao) / SUM(valor_vendido)
    END AS pct_comissao,
    SUM(valor_comissao) AS valor_comissao
  FROM Detalhe
  GROUP BY mix
),

-- ✅ TOTAL geral (última linha)
TotalGeral AS (
  SELECT
    99 AS mix,
    'TOTAL GERAL' AS faixa,
    SUM(valor_vendido) AS valor_vendido,
    CASE WHEN SUM(valor_vendido) = 0 THEN NULL
         ELSE SUM(valor_comissao) / SUM(valor_vendido)
    END AS pct_comissao,
    SUM(valor_comissao) AS valor_comissao
  FROM Detalhe
),

FinalUnion AS (
  SELECT mix, faixa, valor_vendido, pct_comissao, valor_comissao
  FROM Detalhe

  UNION ALL

  SELECT mix, faixa, valor_vendido, pct_comissao, valor_comissao
  FROM SubtotalMix

  UNION ALL

  SELECT mix, faixa, valor_vendido, pct_comissao, valor_comissao
  FROM TotalGeral
)

SELECT
  mix,
  faixa,
  valor_vendido,
  pct_comissao,
  valor_comissao
FROM (
  SELECT
    fu.*,

    -- ordenação: Mix 1, 2, 3, depois Total Geral
    CASE
      WHEN fu.mix IN (1,2,3) THEN 1
      WHEN fu.mix = 99 THEN 2
      ELSE 9
    END AS ord_bloco,

    -- ordenação dos mixes
    CASE
      WHEN fu.mix = 1 THEN 1
      WHEN fu.mix = 2 THEN 2
      WHEN fu.mix = 3 THEN 3
      WHEN fu.mix = 99 THEN 9
      ELSE 99
    END AS ord_mix,

    -- faixas A/B/C/D antes, TOTAL depois, TOTAL GERAL por último
    CASE
      WHEN fu.faixa = 'A' THEN 1
      WHEN fu.faixa = 'B' THEN 2
      WHEN fu.faixa = 'C' THEN 3
      WHEN fu.faixa = 'D' THEN 4
      WHEN fu.faixa = 'TOTAL' THEN 8
      WHEN fu.faixa = 'TOTAL GERAL' THEN 9
      ELSE 99
    END AS ord_faixa

  FROM FinalUnion fu
) x
ORDER BY
  ord_bloco,
  ord_mix,
  ord_faixa;
