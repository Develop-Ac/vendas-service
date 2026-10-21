-- ============================================================================
-- Promoção do portal B2B no orçamento do atacado.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- ven_orcamento_b2b_itens.promocao_preco / promocao_fim: preço promocional
-- PURO (sem a margem) e fim da promoção, congelados pelo portal no pedido.
--
-- ven_orcamento_promo_portal: a promoção do portal de cada item de um
-- orçamento nascido de pedido B2B. É ela que faz o orçamento tratar o item como
-- promoção (preço fechado, sem desconto, metade do negativo da bolsa é da
-- empresa, validade até o fim, "vender fora da promoção") — a promoção não
-- existe no Celta. `preco` já tem a margem do comprador (o que ele viu).
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega.
--
-- ROLLBACK: DROP TABLE ven_orcamento_promo_portal;
--           ALTER TABLE ven_orcamento_b2b_itens DROP COLUMN promocao_preco,
--           DROP COLUMN promocao_fim;
-- ============================================================================

ALTER TABLE ven_orcamento_b2b_itens
    ADD COLUMN IF NOT EXISTS promocao_preco NUMERIC(12,2),
    ADD COLUMN IF NOT EXISTS promocao_fim DATE;

CREATE TABLE IF NOT EXISTS ven_orcamento_promo_portal (
    orcamento_id TEXT          NOT NULL REFERENCES ven_orcamento(id) ON DELETE CASCADE,
    pro_codigo   INTEGER       NOT NULL,
    preco        NUMERIC(12,2) NOT NULL,
    fim          DATE          NOT NULL,
    descricao    VARCHAR(200)  NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (orcamento_id, pro_codigo)
);
