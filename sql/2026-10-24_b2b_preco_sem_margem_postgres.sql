-- ============================================================================
-- Pedidos do portal B2B (/vendas/b2b) — preço SEM a margem do comprador.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- A margem é da loja cliente (o master do portal a põe para os compradores
-- dele); para a AC vale a tabela. O vendas-service passa a gravar
-- `preco_unitario` dos itens já sem a margem e marca o pedido com
-- `"precoSemMargem" = true`.
--
-- Os pedidos já gravados ficam com `false` (o DEFAULT): o preço deles ainda tem
-- a margem e o vendas-service a tira na leitura. Por isso não há UPDATE nos
-- dados — rodar de novo não divide nada duas vezes.
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem a
-- coluna, a leitura de ven_orcamento_b2b falha.
-- ============================================================================

ALTER TABLE ven_orcamento_b2b
    ADD COLUMN IF NOT EXISTS "precoSemMargem" BOOLEAN NOT NULL DEFAULT false;
