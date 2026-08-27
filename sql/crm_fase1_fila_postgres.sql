-- ============================================================================
-- CRM do Atacado (fase 1) — Fila do dia + motivo de perda — DDL PostgreSQL
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
--
-- Duas tabelas overlay (o ERP continua a fonte da verdade da carteira):
--   ven_fila_tarefa       -> a fila do dia gerada pela régua por curva; a tarefa
--                            FECHA SOZINHA por sinal observado (orçamento novo ou
--                            venda do cliente) — nunca por auto-relato.
--   ven_orcamento_desfecho-> a única digitação nova do vendedor: o motivo do
--                            orçamento que não fechou (1 toque, 6 opções). É a
--                            pesquisa de motivo de perda da fase 1.
-- ============================================================================

-- 1) Fila do dia --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ven_fila_tarefa (
  id              TEXT PRIMARY KEY,
  tipo            TEXT NOT NULL,                       -- CONTATO (régua) | RESGATE (risco curva A)
  cli_codigo      INTEGER NOT NULL,
  cli_nome        TEXT,                                -- cópia p/ exibição (cadastro pode mudar)
  rep_codigo      INTEGER,
  rep_nome        TEXT,
  curva           TEXT,                                -- curva ABC no momento da geração
  motivo_geracao  TEXT,                                -- ex.: "Curva A: 22d sem compra, 30d sem orçamento (régua 15d)"
  gerada_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  prazo_em        TIMESTAMPTZ NOT NULL,                -- SLA; estourado sem sinal -> ESCALADA (visível ao supervisor)
  status          TEXT NOT NULL DEFAULT 'ABERTA',      -- ABERTA | ESCALADA | CONCLUIDA | CANCELADA
  escalada_em     TIMESTAMPTZ,
  concluida_em    TIMESTAMPTZ,
  conclusao_sinal TEXT,                                -- VENDA | ORCAMENTO | (futuro) MENSAGEM
  conclusao_obs   TEXT,                                -- ex.: motivo do cancelamento
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No máximo UMA tarefa em andamento por cliente (qualquer tipo): índice parcial —
-- o Prisma não expressa unique parcial, então a regra mora aqui e no código.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_fila_tarefa_andamento
  ON ven_fila_tarefa (cli_codigo)
  WHERE status IN ('ABERTA', 'ESCALADA');

CREATE INDEX IF NOT EXISTS idx_ven_fila_tarefa_rep_status ON ven_fila_tarefa (rep_codigo, status);
CREATE INDEX IF NOT EXISTS idx_ven_fila_tarefa_status_prazo ON ven_fila_tarefa (status, prazo_em);
CREATE INDEX IF NOT EXISTS idx_ven_fila_tarefa_cli ON ven_fila_tarefa (cli_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_fila_tarefa_gerada ON ven_fila_tarefa (gerada_em);

-- 2) Desfecho do orçamento (motivo de perda) ----------------------------------
CREATE TABLE IF NOT EXISTS ven_orcamento_desfecho (
  id           TEXT PRIMARY KEY,
  empresa      INTEGER NOT NULL DEFAULT 3,             -- orçamentos do atacado = empresa 3 no Celta
  orcamento    INTEGER NOT NULL,                       -- número do orçamento no Celta
  emissao      DATE,
  cli_codigo   INTEGER NOT NULL,
  cli_nome     TEXT,                                   -- cópia gravada no orçamento
  rep_codigo   INTEGER,
  rep_nome     TEXT,
  total        NUMERIC(15,2) NOT NULL DEFAULT 0,
  motivo       TEXT NOT NULL,                          -- PRECO | PRAZO_FRETE | SEM_ESTOQUE | CONCORRENTE | CLIENTE_ADIOU | CREDITO_BLOQUEADO
  observacao   TEXT,
  usuario_id   TEXT,
  usuario_nome TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um desfecho por orçamento (marcar de novo corrige o motivo, não duplica).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_orc_desfecho_orcamento
  ON ven_orcamento_desfecho (empresa, orcamento);

CREATE INDEX IF NOT EXISTS idx_ven_orc_desfecho_cli ON ven_orcamento_desfecho (cli_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_orc_desfecho_rep ON ven_orcamento_desfecho (rep_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_orc_desfecho_motivo ON ven_orcamento_desfecho (motivo);
CREATE INDEX IF NOT EXISTS idx_ven_orc_desfecho_created ON ven_orcamento_desfecho (created_at);
