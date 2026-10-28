-- ============================================================================
-- CRM do Atacado — RESET da fila de contato e da esteira de resgate (28/10/2026)
-- Aplicar MANUALMENTE no Postgres da intranet (não é migration). Idempotente.
--
-- Acordo com a equipe do atacado em 26/10/2026 (os indicadores passam a pontuar
-- o prêmio do supervisor): a régua muda e tudo o que estava em andamento é
-- zerado para começar do zero com as regras novas:
--   * contato (fila):  curva A 15 d · B 30 d · C/D 60 d sem compra, orçamento
--                      nem mensagem (60 d = inativação)
--   * resgate:         curva A 30 d · B 45 d sem sinal · C/D sem resgate
--   * orçamento sem desfecho: 3 dias sem venda (era 7); só emitidos a partir de
--                      26/10/2026 (corte no código: inicioApontamento)
--
-- Depois de aplicar, gere a fila de novo: POST /carteirizacao/fila/gerar (botão
-- "Gerar fila" da tela de Carteirização) ou aguarde o job das 5h. Os episódios
-- de resgate reabrem sozinhos na primeira leitura da esteira/tela do supervisor.
-- ============================================================================

BEGIN;

-- 1) Fila: tudo que estava aberto/escalado sai com rastro (não apaga histórico).
UPDATE ven_fila_tarefa
   SET status        = 'CANCELADA',
       conclusao_obs = 'Reset 28/10/2026: nova régua de contato/resgate acordada com o atacado em 26/10',
       updated_at    = now()
 WHERE status IN ('ABERTA', 'ESCALADA');

-- 2) Esteira de resgate: episódios em andamento saem; os já fechados
--    (RECUPERADO/PERDIDO) ficam como histórico. Quem ainda estiver na janela
--    nova (A ≥ 30 d, B ≥ 45 d sem sinal) reabre sozinho, com aberto_em de hoje.
DELETE FROM ven_resgate
 WHERE estagio NOT IN ('RECUPERADO', 'PERDIDO');

COMMIT;

-- Conferência
SELECT status, count(*) FROM ven_fila_tarefa GROUP BY status ORDER BY status;
SELECT estagio, count(*) FROM ven_resgate GROUP BY estagio ORDER BY estagio;
