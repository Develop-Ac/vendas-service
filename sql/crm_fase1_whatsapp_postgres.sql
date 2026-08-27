-- ============================================================================
-- CRM do Atacado (fase 1) — Sensor WhatsApp (piloto WAHA) — DDL PostgreSQL
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
--
-- SÓ METADADOS, por decisão do plano: nenhuma tabela guarda corpo de mensagem.
-- O que se registra é o FATO do contato (quem, com que cliente, quando, em que
-- direção) — o suficiente para a fila constatar trabalho e para o painel do
-- supervisor medir esforço, sem ler conversa de ninguém.
--
--   ven_wa_contato  -> vínculo telefone -> cliente (N para 1). Casamento pela
--                      CHAVE = DDD + últimos 8 dígitos (sobrevive ao 9º dígito).
--   ven_wa_mensagem -> um evento de mensagem por linha (metadados), deduplicado
--                      por (sessao, message_id).
-- ============================================================================

-- 1) Vínculo contato -> cliente ------------------------------------------------
CREATE TABLE IF NOT EXISTS ven_wa_contato (
  id          TEXT PRIMARY KEY,
  chave       TEXT NOT NULL,                     -- DDD + últimos 8 dígitos
  telefone    TEXT NOT NULL,                     -- o número como conhecido (p/ exibição)
  cli_codigo  INTEGER NOT NULL,
  cli_nome    TEXT,
  origem      TEXT NOT NULL DEFAULT 'SEED_ERP',  -- SEED_ERP | MANUAL
  criado_por  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uma chave aponta para UM cliente (vincular de novo corrige, não duplica).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_wa_contato_chave ON ven_wa_contato (chave);
CREATE INDEX IF NOT EXISTS idx_ven_wa_contato_cli ON ven_wa_contato (cli_codigo);

-- 2) Mensagens (metadados) -----------------------------------------------------
CREATE TABLE IF NOT EXISTS ven_wa_mensagem (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL,                   -- id do WhatsApp (dedupe de reentrega)
  sessao        TEXT NOT NULL,                   -- sessão WAHA (convenção: rep-<codigo>)
  rep_codigo    INTEGER,                         -- extraído do nome da sessão
  chat_telefone TEXT NOT NULL,                   -- interlocutor (dígitos, sem @c.us)
  chave         TEXT NOT NULL,                   -- DDD + últimos 8 do interlocutor
  cli_codigo    INTEGER,                         -- resolvido via ven_wa_contato; NULL = fila de vínculo
  direcao       TEXT NOT NULL,                   -- ENVIADA | RECEBIDA
  tipo          TEXT,                            -- chat | image | ptt | document | ...
  "timestamp"   TIMESTAMPTZ NOT NULL,            -- hora da mensagem no WhatsApp
  ack           INTEGER,                         -- último status: 1 enviada, 2 entregue, 3 lida
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_wa_msg_sessao_id ON ven_wa_mensagem (sessao, message_id);
-- O caminho do terceiro sinal da fila: última ENVIADA por cliente.
CREATE INDEX IF NOT EXISTS idx_ven_wa_msg_cli_dir_ts ON ven_wa_mensagem (cli_codigo, direcao, "timestamp");
-- Fila de vínculo (cli_codigo nulo) e re-resolução quando um vínculo é criado.
CREATE INDEX IF NOT EXISTS idx_ven_wa_msg_chave ON ven_wa_mensagem (chave);
CREATE INDEX IF NOT EXISTS idx_ven_wa_msg_sessao_ts ON ven_wa_mensagem (sessao, "timestamp");
