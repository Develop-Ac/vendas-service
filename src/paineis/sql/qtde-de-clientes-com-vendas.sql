SELECT
  COUNT(DISTINCT dbo.f_analise_vendas.cli_codigo) AS clientes_unicos
FROM dbo.f_analise_vendas
JOIN dbo.vw_d_calendario_tipado
  ON CAST(dbo.f_analise_vendas.dt_emissao AS date) = dbo.vw_d_calendario_tipado.data_date
WHERE 1=1
   AND (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date)))      -- Field Filter -> dbo.vw_d_calendario_tipado.data_date
   AND {{vendedor:dbo.f_analise_vendas.nome_representante}}     -- Field Filter -> dbo.f_analise_vendas.nome_representante
;
