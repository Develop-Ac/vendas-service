-- MANUAL: reescrito em 08/10/2026 (desempenho + só vendedores ativos). O extrator não sobrescreve.
--
-- Positivação de Carteira (card 356 e cópias 98, 137, 285): clientes distintos com venda
-- no período ÷ clientes em carteira na última foto (DataSnapshot) dentro do período.
--   - Numerador: todos os vendedores do filtro (ou a empresa toda, sem filtro), ativos ou
--     não: venda feita conta. É o mesmo cálculo do card "Qtde de Clientes com Vendas".
--   - Denominador: só representantes ATIVOS (dbo.ComissaoRepresentante.inativo = 0).
--     Carteira de quem saiu não é meta de ninguém. Por isso este card pode diferir do
--     Metabase quando a lista inclui inativo com carteira na última foto.
-- Desempenho: período direto em dt_emissao_convertida (date, chave do IX_fav_dt) e filtro
-- de vendedor sobre a coluna crua (dados sem espaço sobrando; colunas CI). A versão do
-- Metabase normalizava nomes varrendo f_analise_vendas inteira e casava a data por
-- CAST(dt_emissao AS date) IN (...), sem índice: 12–23 s no pior caso medido.
WITH Unicos AS (
  SELECT COUNT(DISTINCT dbo.f_analise_vendas.CLI_CODIGO) AS clientes_unicos
  FROM dbo.f_analise_vendas
  WHERE dbo.f_analise_vendas.dt_emissao_convertida >= CAST(@de AS date)
    AND dbo.f_analise_vendas.dt_emissao_convertida < DATEADD(day, 1, CAST(@ate AS date))
    AND {{vendedor:dbo.f_analise_vendas.nome_representante}}
),
Base AS (
  SELECT dbo.Fato_CarteiraVendedorDiaria.DataSnapshot, dbo.Fato_CarteiraVendedorDiaria.QuantidadeClientes
  FROM dbo.Fato_CarteiraVendedorDiaria
  WHERE dbo.Fato_CarteiraVendedorDiaria.DataSnapshot >= CAST(@de AS date)
    AND dbo.Fato_CarteiraVendedorDiaria.DataSnapshot < DATEADD(day, 1, CAST(@ate AS date))
    AND {{vendedor:dbo.Fato_CarteiraVendedorDiaria.NomeRepresentante}}
    AND EXISTS (
      SELECT 1 FROM dbo.ComissaoRepresentante a
      WHERE a.rep_codigo = dbo.Fato_CarteiraVendedorDiaria.RepresentanteID AND a.inativo = 0
    )
),
Carteira AS (
  SELECT COALESCE(SUM(b.QuantidadeClientes), 0) AS clientes_carteira
  FROM Base b
  WHERE b.DataSnapshot = (SELECT MAX(DataSnapshot) FROM Base)
)
SELECT
  u.clientes_unicos,
  c.clientes_carteira,
  -- fração 0–1
  ROUND(COALESCE(CAST(u.clientes_unicos AS decimal(18,6)) / NULLIF(c.clientes_carteira, 0), 0), 6) AS razao_fracionaria,
  -- percentual 0–100
  ROUND(COALESCE(100.0 * CAST(u.clientes_unicos AS decimal(18,6)) / NULLIF(c.clientes_carteira, 0), 0), 2) AS razao_percentual
FROM Unicos u
CROSS JOIN Carteira c;
