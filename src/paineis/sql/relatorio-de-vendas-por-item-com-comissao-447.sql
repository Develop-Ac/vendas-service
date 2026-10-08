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
),
BaseVendas AS (
  SELECT
    v.dt_emissao_convertida AS dt_emissao,
    v.cli_codigo,
    v.cli_nome,
    v.pro_codigo,
    v.pro_descricao,
    v.liquido_produto,
    v.mix_custo,
    v.faixa_mix
  FROM dbo.f_analise_vendas v
  JOIN CalendarioFiltrado c
    ON v.dt_emissao_convertida = c.data_date
  WHERE v.mix_custo IS NOT NULL
    AND v.faixa_mix IS NOT NULL
    AND (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
           IN (SELECT vendedor_norm FROM VendedoresFiltrados))
),
TotaisPeriodo AS (
  SELECT
    SUM(liquido_produto) AS total_geral,
    SUM(CASE WHEN mix_custo = 1 THEN liquido_produto ELSE 0 END) AS total_mix1
  FROM BaseVendas
),
Regras AS (
  SELECT
    -- escada do MIX1 (set/26): multiplicador pela participacao do mix 1 na venda do periodo
    CASE
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.30 THEN 2.00
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.26 THEN 1.50
      WHEN CAST(total_mix1 AS float) / NULLIF(CAST(total_geral AS float), 0) >= 0.22 THEN 1.25
      ELSE 1.00
    END AS mult_mix1
  FROM TotaisPeriodo
),
Detalhe AS (
  SELECT
    b.*,

    -- ✅ % comissão do SUPERVISOR
    CASE
      WHEN b.mix_custo IN (2,3) THEN 0.0055

      WHEN b.mix_custo = 1 THEN
        -- base por faixa x degrau (1,00 / 1,25 / 1,50 / 2,00)
        (SELECT mult_mix1 FROM Regras) *
        CASE b.faixa_mix
          WHEN 'A' THEN 0.0100
          WHEN 'B' THEN 0.0086
          WHEN 'C' THEN 0.0071
          WHEN 'D' THEN 0.0057
          ELSE 0
        END

      ELSE 0
    END AS pct_comissao_supervisor

  FROM BaseVendas b
),
ComissaoCalculada AS (
  SELECT
    *,
    liquido_produto * pct_comissao_supervisor AS valor_comissao_supervisor
  FROM Detalhe
),
FinalUnion AS (
  SELECT
    0 AS ord_total,
    dt_emissao,
    cli_codigo,
    cli_nome,
    pro_codigo,
    pro_descricao,
    liquido_produto,
    mix_custo,
    faixa_mix,
    pct_comissao_supervisor,
    valor_comissao_supervisor
  FROM ComissaoCalculada

  UNION ALL

  SELECT
    1 AS ord_total,
    CAST(NULL AS date) AS dt_emissao,
    CAST(NULL AS int)  AS cli_codigo,
    CAST('TOTAL GERAL' AS nvarchar(200)) AS cli_nome,
    CAST(NULL AS varchar(50)) AS pro_codigo,
    CAST(NULL AS nvarchar(200)) AS pro_descricao,
    SUM(liquido_produto) AS liquido_produto,
    CAST(NULL AS int) AS mix_custo,
    CAST(NULL AS char(1)) AS faixa_mix,

    -- % efetivo total (ponderado)
    CASE
      WHEN SUM(liquido_produto) = 0 THEN NULL
      ELSE SUM(valor_comissao_supervisor) / SUM(liquido_produto)
    END AS pct_comissao_supervisor,

    SUM(valor_comissao_supervisor) AS valor_comissao_supervisor
  FROM ComissaoCalculada
)
SELECT
  dt_emissao,
  cli_codigo,
  cli_nome,
  pro_codigo,
  pro_descricao,
  liquido_produto,
  mix_custo,
  faixa_mix,
  pct_comissao_supervisor,
  valor_comissao_supervisor
FROM FinalUnion
ORDER BY
  ord_total,
  dt_emissao DESC,
  cli_nome,
  pro_descricao;
