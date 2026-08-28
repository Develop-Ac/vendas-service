-- ============================================================================
-- CRM do Atacado (fase 1) — Esteira de resgate — DDL PostgreSQL
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
--
-- Um "episódio de resgate" abre quando o cliente entra em risco de inativação
-- (45+ dias sem compra) e acompanha até RECUPERADO (voltou a comprar) ou
-- PERDIDO (chegou aos 60 dias e inativou). O estágio avança SOZINHO por sinal
-- observado — nenhum vendedor arrasta card:
--
--   A_CONTATAR -> CONTATADO (mensagem enviada, sensor WAHA)
--              -> PROPOSTA  (orçamento novo no Celta)
--              -> RECUPERADO (venda) | PERDIDO (inativou)
--
-- O SLA de primeiro contato (48h, curva A) fica gravado no episódio — é o
-- número que o painel do supervisor cobra na reunião semanal.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ven_resgate (
  id                        TEXT PRIMARY KEY,
  cli_codigo                INTEGER NOT NULL,
  cli_nome                  TEXT,
  rep_codigo                INTEGER,
  rep_nome                  TEXT,
  curva                     TEXT,                    -- curva ABC na abertura
  faturamento_total         NUMERIC(15,2) NOT NULL DEFAULT 0, -- o que está em jogo (na abertura)
  dias_sem_compra_abertura  INTEGER,
  aberto_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  estagio                   TEXT NOT NULL DEFAULT 'A_CONTATAR', -- A_CONTATAR | CONTATADO | PROPOSTA | RECUPERADO | PERDIDO
  contatado_em              TIMESTAMPTZ,             -- primeiro sinal de contato observado
  proposta_em               TIMESTAMPTZ,             -- orçamento depois da abertura
  fechado_em                TIMESTAMPTZ,             -- recuperado/perdido
  sla_em                    TIMESTAMPTZ,             -- prazo do 1º contato (48h p/ curva A; nulo nas demais)
  sla_cumprido              BOOLEAN,                 -- contato aconteceu dentro do prazo?
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um episódio ABERTO por cliente (fechar e reabrir é novo episódio) — índice
-- parcial; o Prisma não expressa, a regra mora aqui e no código.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_resgate_aberto
  ON ven_resgate (cli_codigo)
  WHERE estagio NOT IN ('RECUPERADO', 'PERDIDO');

CREATE INDEX IF NOT EXISTS idx_ven_resgate_rep_estagio ON ven_resgate (rep_codigo, estagio);
CREATE INDEX IF NOT EXISTS idx_ven_resgate_fechado ON ven_resgate (fechado_em);
CREATE INDEX IF NOT EXISTS idx_ven_resgate_cli ON ven_resgate (cli_codigo);
