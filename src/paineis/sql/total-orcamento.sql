SELECT SUM(dbo.vw_orcamentos.total) AS [sum]
FROM dbo.vw_orcamentos
WHERE (dbo.vw_orcamentos.emissao >= CAST(@de AS date) AND dbo.vw_orcamentos.emissao < DATEADD(day, 1, CAST(@ate AS date)))
  AND {{vendedor:dbo.vw_orcamentos.nome_representante}};
