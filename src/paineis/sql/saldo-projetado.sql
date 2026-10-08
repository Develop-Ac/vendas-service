/* PROJEÇÃO DE VENDAS ATÉ O FIM DO MÊS COMISSIONAL (por vendedor)
   - média diária = vendas até hoje / dias úteis decorridos
   - proj. adicional = média diária * dias úteis restantes
   - proj. total = realizado + adicional
*/

WITH CalendarioFiltrado AS (   -- dias do filtro (já com is_dia_util no seu view)
  SELECT data_date, mes_comissional, ano_comissional, is_dia_util
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
),
PeriodosSelecionados AS (      -- meses comissionais presentes no filtro
  SELECT DISTINCT mes_comissional, ano_comissional
  FROM CalendarioFiltrado
),
LimitesMes AS (                -- início/fim (reais) de cada mês comissional
  SELECT
    p.mes_comissional AS mes,
    p.ano_comissional AS ano,
    MIN(c.data_date)  AS data_ini,
    MAX(c.data_date)  AS data_fim
  FROM PeriodosSelecionados p
  JOIN dbo.vw_d_calendario_tipado c
    ON c.mes_comissional = p.mes_comissional
   AND c.ano_comissional = p.ano_comissional
  GROUP BY p.mes_comissional, p.ano_comissional
),
Hoje AS ( SELECT CAST(GETDATE() AS date) AS hoje ),
Cortes AS (                    -- data de corte por mês (clamp entre ini/fim)
  SELECT
    l.mes, l.ano, l.data_ini, l.data_fim,
    CASE
      WHEN h.hoje < l.data_ini THEN l.data_ini
      WHEN h.hoje > l.data_fim THEN l.data_fim
      ELSE h.hoje
    END AS data_corte
  FROM LimitesMes l
  CROSS JOIN Hoje h
),
DiasUT AS (                    -- dias úteis decorridos e restantes (no mês comissional)
  SELECT
    c.mes, c.ano,
    SUM(CASE WHEN cal.is_dia_util = 1 AND cal.data_date <= c.data_corte THEN 1 ELSE 0 END) AS dias_uteis_decorridos,
    SUM(CASE WHEN cal.is_dia_util = 1 AND cal.data_date >  c.data_corte THEN 1 ELSE 0 END) AS dias_uteis_restantes
  FROM Cortes c
  JOIN dbo.vw_d_calendario_tipado cal
    ON cal.mes_comissional = c.mes
   AND cal.ano_comissional = c.ano
  WHERE cal.data_date BETWEEN c.data_ini AND c.data_fim
  GROUP BY c.mes, c.ano
),
-- Filtro opcional de vendedor (Metabase injeta aqui; vazio = não filtra)
VendedoresFiltro AS (
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm
  FROM dbo.d_cadastro_representantes
  WHERE 1=1 AND {{vendedor:dbo.d_cadastro_representantes.nome_representante}}
),
-- Vendas acumuladas até a data_corte (por vendedor e mês comissional)
VendasAcum AS (
  SELECT
    c.mes, c.ano,
    UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI AS vendedor_norm,
    SUM(v.liquido_produto) AS vendas_acumuladas
  FROM dbo.f_analise_vendas v
  JOIN dbo.vw_d_calendario_tipado cal
    ON CAST(v.dt_emissao AS date) = cal.data_date
  JOIN Cortes c
    ON c.mes = cal.mes_comissional AND c.ano = cal.ano_comissional
  WHERE cal.data_date <= c.data_corte
    AND (UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
               IN (SELECT vendedor_norm FROM VendedoresFiltro))
  GROUP BY c.mes, c.ano,
           UPPER(LTRIM(RTRIM(v.nome_representante))) COLLATE Latin1_General_CI_AI
)
SELECT
  DATEFROMPARTS(v.ano, v.mes, 1)                             AS mes_ref,          -- use no eixo/ordenação
  v.vendedor_norm                                            AS vendedor,
  v.vendas_acumuladas,
  du.dias_uteis_decorridos,
  du.dias_uteis_restantes,
  CASE WHEN du.dias_uteis_decorridos > 0
       THEN v.vendas_acumuladas * 1.0 / du.dias_uteis_decorridos
       ELSE NULL
  END AS media_diaria_realizada,
  CASE WHEN du.dias_uteis_decorridos > 0
       THEN (v.vendas_acumuladas * 1.0 / du.dias_uteis_decorridos) * du.dias_uteis_restantes
       ELSE NULL
  END AS proj_adicional,
  CASE WHEN du.dias_uteis_decorridos > 0
       THEN v.vendas_acumuladas
          + (v.vendas_acumuladas * 1.0 / du.dias_uteis_decorridos) * du.dias_uteis_restantes
       ELSE NULL
  END AS proj_total
FROM VendasAcum v
JOIN DiasUT du
  ON du.mes = v.mes AND du.ano = v.ano
ORDER BY mes_ref, vendedor; 
