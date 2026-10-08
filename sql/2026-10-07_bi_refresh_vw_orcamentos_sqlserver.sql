-- SQL Server BI (192.168.1.146, base BI) — APLICAÇÃO MANUAL, login com ALTER na view
-- (BI_AC não tem). Não cria nem altera objeto: só recompila o metadado das views.
--
-- Problema: dbo.vw_orcamentos é `SELECT o.*, rep.nome_representante FROM Stage_Orcamentos o ...`
-- e foi criada antes de Stage_Orcamentos ganhar perc_descto / perc_descto_orc. View com
-- SELECT * guarda a lista de colunas da criação, então a coluna "nome_representante" da
-- view hoje devolve perc_descto (0, 5, ...). Efeito, no Metabase e nos painéis nativos:
--   - Total Orçamento e Quantidade de Orçamentos falham com filtro de vendedor
--     ("Erro ao converter tipo de dados nvarchar em numeric");
--   - Taxa de Conversão de Orçamento e % Conversão de Orçamentos saem sempre vazias
--     (o nome do vendedor nunca casa).
-- vw_orcamentos_canal (o.* sobre vw_orcamentos) tem o mesmo defeito.

EXEC sp_refreshview 'dbo.vw_orcamentos';
EXEC sp_refreshview 'dbo.vw_orcamentos_canal';

-- Conferência: deve trazer nomes, não números.
SELECT TOP 5 rep_codigo, nome_representante FROM dbo.vw_orcamentos ORDER BY emissao DESC;
