-- ============================================================================
-- Carteirização de Clientes — DDL PostgreSQL (vendas-service)
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
-- Overlay da carteira: fonte de verdade cliente->vendedor para o atacado.
-- ============================================================================

-- 1) Atribuição atual (1 linha por cliente carteirizado) -----------------------
CREATE TABLE IF NOT EXISTS ven_carteira_cliente (
  id             TEXT PRIMARY KEY,
  cli_codigo     INTEGER NOT NULL,
  rep_codigo     INTEGER,
  rep_nome       TEXT,
  canal          TEXT,
  origem         TEXT NOT NULL DEFAULT 'MANUAL',
  observacao     TEXT,
  atribuido_por  TEXT,
  atribuido_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  trash          INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_carteira_cliente_cli ON ven_carteira_cliente (cli_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_carteira_cliente_rep ON ven_carteira_cliente (rep_codigo);

-- 2) Histórico append-only (rastreabilidade — Regras 3 e 4) --------------------
CREATE TABLE IF NOT EXISTS ven_carteira_historico (
  id                   TEXT PRIMARY KEY,
  cli_codigo           INTEGER NOT NULL,
  rep_codigo_anterior  INTEGER,
  rep_nome_anterior    TEXT,
  rep_codigo_novo      INTEGER,
  rep_nome_novo        TEXT,
  acao                 TEXT NOT NULL,   -- ATRIBUICAO | ALTERACAO | REMOCAO | TRANSFERENCIA | LOTE
  motivo               TEXT,
  usuario_id           TEXT,
  usuario_nome         TEXT,
  lote_id              TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ven_carteira_hist_cli ON ven_carteira_historico (cli_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_carteira_hist_rep_novo ON ven_carteira_historico (rep_codigo_novo);
CREATE INDEX IF NOT EXISTS idx_ven_carteira_hist_created ON ven_carteira_historico (created_at);
CREATE INDEX IF NOT EXISTS idx_ven_carteira_hist_lote ON ven_carteira_historico (lote_id);

-- 3) Config por vendedor (Fase 2: capacidade/canal/meta) -----------------------
CREATE TABLE IF NOT EXISTS ven_carteira_vendedor_config (
  id                TEXT PRIMARY KEY,
  rep_codigo        INTEGER NOT NULL,
  rep_nome          TEXT,
  capacidade_max    INTEGER,
  canal             TEXT,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  meta_faturamento  NUMERIC(15,2),
  observacao        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_carteira_vend_cfg_rep ON ven_carteira_vendedor_config (rep_codigo);
