WITH Base AS (
  SELECT
    dbo.Fato_CarteiraVendedorDiaria.DataSnapshot,
    dbo.Fato_CarteiraVendedorDiaria.NomeRepresentante,
    dbo.Fato_CarteiraVendedorDiaria.QuantidadeClientes
  FROM dbo.Fato_CarteiraVendedorDiaria
  WHERE 1=1
     AND (dbo.Fato_CarteiraVendedorDiaria.DataSnapshot >= CAST(@de AS date) AND dbo.Fato_CarteiraVendedorDiaria.DataSnapshot < DATEADD(day, 1, CAST(@ate AS date)))             -- Field Filter -> DataSnapshot
     AND {{vendedor:dbo.Fato_CarteiraVendedorDiaria.NomeRepresentante}}    -- Field Filter -> NomeRepresentante
),
UltimaData AS (
  SELECT MAX(DataSnapshot) AS DataSnapshot
  FROM Base
)
SELECT
  COALESCE(SUM(b.QuantidadeClientes), 0) AS clientes_total_ultima_data
FROM Base b
JOIN UltimaData u
  ON b.DataSnapshot = u.DataSnapshot;
