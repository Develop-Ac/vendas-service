-- ============================================================================
-- Orçamento do Atacado — adiado com data de retorno (29/10/2026)
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet` da .144).
-- Não é migration. Idempotente (IF NOT EXISTS): pode rodar de novo sem efeito.
--
-- Quando o cliente adia a compra, o vendedor marca o desfecho "cliente adiou"
-- com a data em que vai voltar a procurá-lo: o orçamento fica com status
-- ADIADO e `retorno_em` = esse dia (fuso de Cuiabá). No dia do retorno ele
-- aparece no topo da lista e o vendedor é avisado. O índice parcial atende a
-- busca diária dos adiados que vencem no dia.
-- ============================================================================

BEGIN;

ALTER TABLE ven_orcamento ADD COLUMN IF NOT EXISTS retorno_em DATE;

CREATE INDEX IF NOT EXISTS idx_ven_orcamento_retorno
  ON ven_orcamento (retorno_em) WHERE status = 'ADIADO';

COMMENT ON COLUMN ven_orcamento.retorno_em IS
  'Dia (Cuiabá) em que o vendedor volta a procurar o cliente; só com status ADIADO';

COMMIT;
