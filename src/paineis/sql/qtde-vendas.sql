SELECT COUNT(DISTINCT dbo.vw_analise_vendas.NFS) AS [count]
FROM dbo.vw_analise_vendas
WHERE (dbo.vw_analise_vendas.DT_EMISSAO >= CAST(@de AS date) AND dbo.vw_analise_vendas.DT_EMISSAO < DATEADD(day, 1, CAST(@ate AS date)))
  AND {{vendedor:dbo.vw_analise_vendas.nome_representante}};
