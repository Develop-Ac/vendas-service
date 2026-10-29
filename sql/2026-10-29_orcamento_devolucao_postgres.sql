-- ============================================================================
-- Orçamento do Atacado — devolução ao vendedor pela gerência (29/10/2026)
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet` da .144).
-- Não é migration. Idempotente (IF NOT EXISTS): pode rodar de novo sem efeito.
--
-- A gerência devolve ao vendedor um orçamento em APROVACAO, com motivo
-- (POST /orcamento/:id/devolver): o orçamento volta a RASCUNHO e grava quem
-- devolveu, quando e por quê. Só a última devolução fica no orçamento, porque
-- enviar para aprovação de novo limpa as três colunas; o histórico de
-- devoluções fica no sino (aviso `orcamento.devolvido`).
-- ============================================================================

BEGIN;

ALTER TABLE ven_orcamento
  ADD COLUMN IF NOT EXISTS devolvido_por    VARCHAR(120),
  ADD COLUMN IF NOT EXISTS devolvido_em     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS devolvido_motivo TEXT;

COMMIT;
