-- ============================================================================
-- Pedidos do portal B2B (/vendas/b2b) — preço cotado pelo comprador.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- O portal passou a congelar no pedido se o comprador VIU preço
-- (`clienteViuPreco`), a margem dele e o preço unitário de cada item
-- (`precoUnitario`). O vendas-service grava isso junto com o pedido.
--
-- `"clienteViuPreco"` fica NULL nos pedidos gravados antes desta entrega: a
-- listagem completa com o que o portal devolver para eles.
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem as
-- colunas, a leitura de ven_orcamento_b2b falha e a tela /vendas/b2b passa a
-- mostrar só o que vem do portal (e nada é gravado).
-- ============================================================================

ALTER TABLE ven_orcamento_b2b
    ADD COLUMN IF NOT EXISTS "clienteViuPreco" BOOLEAN,
    ADD COLUMN IF NOT EXISTS margem NUMERIC(7,2);

ALTER TABLE ven_orcamento_b2b_itens
    ADD COLUMN IF NOT EXISTS preco_unitario NUMERIC(12,2);
