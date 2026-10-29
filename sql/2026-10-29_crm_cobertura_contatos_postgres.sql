-- ============================================================================
-- CRM do Atacado — cobertura/delegação da fila + contatos do WhatsApp (29/10/2026)
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet` da .144), DEPOIS
-- de sql/2026-10-28_crm_reset_fila_resgate_postgres.sql. Não é migration.
-- Idempotente (IF NOT EXISTS): pode rodar de novo sem efeito.
--
-- 1) Fila do dia (ven_fila_tarefa): a tarefa pode estar com outro vendedor que
--    não o dono da carteira. rep_codigo continua sendo quem executa; o dono fica
--    em rep_titular_*. Delegação avulsa grava delegada_por/delegada_em; tarefa
--    passada por cobertura grava cobertura_id (volta ao titular quando a
--    cobertura termina).
-- 2) ven_fila_cobertura: período em que o substituto recebe a fila do titular
--    (férias/ausência). Datas sem fuso; "hoje" é calculado em America/Cuiaba.
-- 3) ven_wa_contato.contato_nome: nome da pessoa do cliente dona do número
--    (cadastro manual ou agenda do celular, ex.: "40289 João" → "João").
-- 4) ven_wa_agenda_divergencia: número já vinculado a um cliente cujo nome na
--    agenda da sessão aponta outro cliente; a gestão decide na tela.
--
-- Os ids TEXT não têm default no banco: o cuid é gerado pelo Prisma.
-- ============================================================================

BEGIN;

-- 1) Fila: titular, delegação e cobertura
ALTER TABLE ven_fila_tarefa
  ADD COLUMN IF NOT EXISTS rep_titular_codigo INTEGER,
  ADD COLUMN IF NOT EXISTS rep_titular_nome   TEXT,
  ADD COLUMN IF NOT EXISTS delegada_por       TEXT,
  ADD COLUMN IF NOT EXISTS delegada_em        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cobertura_id       TEXT;

-- 2) Coberturas
CREATE TABLE IF NOT EXISTS ven_fila_cobertura (
  id                    TEXT PRIMARY KEY,
  rep_titular_codigo    INTEGER NOT NULL,
  rep_titular_nome      TEXT,
  rep_substituto_codigo INTEGER NOT NULL,
  rep_substituto_nome   TEXT,
  inicio                DATE NOT NULL,
  fim                   DATE NOT NULL,
  criado_por            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  encerrada_em          TIMESTAMPTZ,
  encerrada_por         TEXT,
  CHECK (fim >= inicio AND rep_substituto_codigo <> rep_titular_codigo)
);
CREATE INDEX IF NOT EXISTS idx_ven_fila_cobertura_titular_fim
  ON ven_fila_cobertura (rep_titular_codigo, fim);

-- 3) Nome do contato no número vinculado
ALTER TABLE ven_wa_contato ADD COLUMN IF NOT EXISTS contato_nome TEXT;

-- 4) Divergências entre a agenda do celular e o vínculo gravado
CREATE TABLE IF NOT EXISTS ven_wa_agenda_divergencia (
  chave         TEXT PRIMARY KEY,
  sessao        TEXT NOT NULL,
  nome_agenda   TEXT,
  cli_agenda    INTEGER NOT NULL,
  cli_vinculado INTEGER NOT NULL,
  visto_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 'Manter' da gestão: a varredura diária não reabre o mesmo par
ALTER TABLE ven_wa_agenda_divergencia ADD COLUMN IF NOT EXISTS mantida_em TIMESTAMPTZ;

COMMIT;

-- Conferência
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE (table_name = 'ven_fila_tarefa'
        AND column_name IN ('rep_titular_codigo','rep_titular_nome','delegada_por','delegada_em','cobertura_id'))
    OR (table_name = 'ven_wa_contato' AND column_name = 'contato_nome')
    OR table_name IN ('ven_fila_cobertura','ven_wa_agenda_divergencia')
 ORDER BY table_name, ordinal_position;
