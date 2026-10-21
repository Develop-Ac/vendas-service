-- ============================================================================
-- Pedidos do portal B2B: vínculo com o cliente do Celta e vendedor do pedido.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- `cli_codigo`: cliente do Celta da empresa do comprador. Vem do portal
-- (`user.cliCodigo`), depois que a gestão vincula a empresa na tela B2B.
-- NULL = empresa ainda sem vínculo.
--
-- `rep_*`: vendedor atribuído pela gestão SÓ para este pedido, quando o
-- cliente não tem vendedor na carteira (ven_carteira_cliente). Não carteiriza
-- o cliente: isso continua com a gestão, pela sugestão da carteirização.
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem as
-- colunas, a leitura de ven_orcamento_b2b falha e a tela /vendas/b2b passa a
-- mostrar só o que vem do portal (e nada é gravado).
--
-- ROLLBACK: ALTER TABLE ven_orcamento_b2b DROP COLUMN cli_codigo, DROP COLUMN
-- rep_codigo, DROP COLUMN rep_nome, DROP COLUMN rep_atribuido_por,
-- DROP COLUMN rep_atribuido_em;  (o índice cai junto com a coluna)
-- ============================================================================

ALTER TABLE ven_orcamento_b2b
    ADD COLUMN IF NOT EXISTS cli_codigo INTEGER,
    ADD COLUMN IF NOT EXISTS rep_codigo INTEGER,
    ADD COLUMN IF NOT EXISTS rep_nome VARCHAR(100),
    ADD COLUMN IF NOT EXISTS rep_atribuido_por VARCHAR(100),
    ADD COLUMN IF NOT EXISTS rep_atribuido_em TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_orc_b2b_cli ON ven_orcamento_b2b (cli_codigo);
