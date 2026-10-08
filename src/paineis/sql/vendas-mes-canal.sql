WITH CalendarioFiltrado AS (
  SELECT data_date, mes_comissional, ano_comissional
  FROM dbo.vw_d_calendario_tipado
  WHERE (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))
)
SELECT
  DATEFROMPARTS(cf.ano_comissional, cf.mes_comissional, 1) AS mes_ref,
  FORMAT(DATEFROMPARTS(cf.ano_comissional, cf.mes_comissional, 1), 'MMMM/yyyy', 'pt-BR') AS mes_label,
  dbo.f_analise_vendas.local_venda_1,
  SUM(dbo.f_analise_vendas.liquido_produto) AS total_vendas
FROM dbo.f_analise_vendas
JOIN CalendarioFiltrado AS cf
  -- MUDANÇA AQUI: Usando a nova coluna segura da view
  ON dbo.f_analise_vendas.dt_emissao_convertida = cf.data_date
WHERE
  dbo.f_analise_vendas.opf_codigo IN (1,2,4,5,6,7,124,101,104,105,106,200)
  AND {{vendedor:dbo.f_analise_vendas.nome_representante}}
GROUP BY
  DATEFROMPARTS(cf.ano_comissional, cf.mes_comissional, 1),
  dbo.f_analise_vendas.local_venda_1
ORDER BY mes_ref, dbo.f_analise_vendas.local_venda_1;
