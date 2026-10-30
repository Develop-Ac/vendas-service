-- ============================================================================
-- Motivos de perda do orçamento: "Concorrente" unido a "Preço" (30/10/2026)
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet` da .144).
-- Não é migration. Idempotente: rodar de novo não altera nada.
--
-- A equipe não distinguia "perdeu no preço" de "fechou com concorrente", então
-- a tela passou a ter uma opção só (PRECO = preço/concorrente). O histórico
-- gravado como CONCORRENTE vira PRECO para o placar de motivos somar junto.
-- ============================================================================

BEGIN;

UPDATE ven_orcamento SET desfecho_motivo = 'PRECO' WHERE desfecho_motivo = 'CONCORRENTE';
UPDATE ven_orcamento_desfecho SET motivo = 'PRECO' WHERE motivo = 'CONCORRENTE';

COMMIT;
