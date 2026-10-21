-- ============================================================================
-- Pedidos do portal B2B: assumir (vira orçamento do atacado) e recusar.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- `empresa`, `observacao`, `endereco`: do pedido no portal, gravados pela busca
-- de cada minuto (antes só existiam lá). Pedido gravado antes fica NULL.
-- `orcamento_id`: o ven_orcamento criado ao assumir. `assumido_*`: quem assumiu
-- (também trava o clique duplo). `recusa_*`: motivo e quando foi recusado.
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem as
-- colunas, a busca de cada minuto falha ao gravar pedido novo.
--
-- ROLLBACK: ALTER TABLE ven_orcamento_b2b DROP COLUMN empresa, DROP COLUMN
-- observacao, DROP COLUMN endereco, DROP COLUMN orcamento_id, DROP COLUMN
-- assumido_em, DROP COLUMN assumido_por, DROP COLUMN recusa_motivo,
-- DROP COLUMN recusado_em;
-- ============================================================================

ALTER TABLE ven_orcamento_b2b
    ADD COLUMN IF NOT EXISTS empresa VARCHAR(160),
    ADD COLUMN IF NOT EXISTS observacao TEXT,
    ADD COLUMN IF NOT EXISTS endereco VARCHAR(300),
    ADD COLUMN IF NOT EXISTS orcamento_id VARCHAR(30),
    ADD COLUMN IF NOT EXISTS assumido_em TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assumido_por VARCHAR(100),
    ADD COLUMN IF NOT EXISTS recusa_motivo TEXT,
    ADD COLUMN IF NOT EXISTS recusado_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orc_b2b_status ON ven_orcamento_b2b (status);
