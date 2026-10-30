-- ============================================================================
-- Sessões do WhatsApp (WAHA) — cadastro, histórico e tela /sistema/whatsapp
-- Aplicar MANUALMENTE no Postgres da intranet (não usar prisma migrate). Idempotente:
-- cada bloco pode rodar de novo sem erro e sem duplicar.
--
-- ven_wa_sessao guarda as sessões das duas instâncias do WAHA (local e online):
-- vínculo com o vendedor, se grava corpo/mídia, último status lido pelo monitor
-- e o estado da queda (aviso e restart já feitos). ven_wa_sessao_evento é o
-- histórico (status, restart, logout, criada, vendedor, instancia).
--
-- ORDEM: aplique ANTES do deploy do vendas-service. Sem a tabela, o serviço
-- não consegue ler nem gravar o cadastro: o webhook segue só pelo padrão
-- `rep-<código>` (assistente e sessões fora do padrão ficam fora), o monitor
-- falha a cada minuto e a tela /sistema/whatsapp não abre. Com a tabela e sem
-- a semente, o monitor insere as sessões SEM vendedor e SEM guarda de conteúdo
-- e o webhook passa a descartar as mensagens delas até a seção 2 rodar (ela
-- corrige esse caso). Depois, recuperar a lacuna com POST /whatsapp/historico.
-- ============================================================================

-- 1) Tabelas (espelham prisma/schema.prisma).
CREATE TABLE IF NOT EXISTS ven_wa_sessao (
  sessao        TEXT PRIMARY KEY,                 -- nome da sessão no WAHA (rep-163, assistente, default)
  instancia     TEXT NOT NULL,                    -- local | online
  apelido       TEXT NOT NULL,
  rep_codigo    INTEGER,
  rep_nome      TEXT,
  guarda_corpo  BOOLEAN NOT NULL DEFAULT FALSE,   -- grava corpo/mídia das mensagens desta sessão
  status        TEXT,
  status_desde  TIMESTAMPTZ,
  telefone      TEXT,
  push_name     TEXT,
  visto_em      TIMESTAMPTZ,
  leituras_fora INTEGER NOT NULL DEFAULT 0,       -- leituras seguidas fora de WORKING
  avisada       BOOLEAN NOT NULL DEFAULT FALSE,   -- aviso de queda já emitido nesta queda
  restart_em    TIMESTAMPTZ,                      -- restart automático já tentado nesta queda
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ven_wa_sessao_inst ON ven_wa_sessao (instancia);
CREATE INDEX IF NOT EXISTS idx_ven_wa_sessao_rep  ON ven_wa_sessao (rep_codigo);
COMMENT ON TABLE ven_wa_sessao IS 'Sessões do WAHA (local/online): vínculo com o vendedor, guarda de corpo e último status lido pelo monitor.';

CREATE TABLE IF NOT EXISTS ven_wa_sessao_evento (
  id       TEXT PRIMARY KEY,                      -- cuid gerado pelo Prisma
  sessao   TEXT NOT NULL,
  tipo     TEXT NOT NULL,                         -- status | restart | logout | criada | vendedor | instancia
  de       TEXT,
  para     TEXT,
  quando   TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario  TEXT,
  detalhe  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ven_wa_sessao_evt ON ven_wa_sessao_evento (sessao, quando DESC);
COMMENT ON TABLE ven_wa_sessao_evento IS 'Histórico das sessões do WAHA: trocas de status, restart, logout, criação, vendedor e instância.';

-- 2) Semente das 8 sessões. O apelido das sessões de vendedor nasce igual ao
--    nome da sessão; o monitor troca pelo push name na primeira leitura.
--    Se o monitor já tiver inserido a sessão (deploy antes do script), o
--    ON CONFLICT preenche o vendedor só onde ainda não há vínculo; rodar de
--    novo não mexe em nada.
INSERT INTO ven_wa_sessao (sessao, instancia, apelido, rep_codigo, rep_nome, guarda_corpo)
SELECT v.sessao, v.instancia, v.apelido, v.rep_codigo,
       (SELECT c.rep_nome FROM ven_carteira_cliente c
         WHERE c.rep_codigo = v.rep_codigo AND c.rep_nome IS NOT NULL LIMIT 1),
       v.guarda_corpo
FROM (VALUES
  ('rep-163',    'local',  'rep-163',              163,          TRUE),
  ('rep-200',    'local',  'rep-200',              200,          TRUE),
  ('rep-316',    'local',  'rep-316',              316,          TRUE),
  ('rep-349',    'local',  'rep-349',              349,          TRUE),
  ('rep-354',    'local',  'rep-354',              354,          TRUE),
  ('rep-999',    'local',  'rep-999',              999,          TRUE),
  ('assistente', 'local',  'Assistente da gestão', NULL::integer, FALSE),
  ('default',    'online', 'Automação (alertas)',  NULL::integer, FALSE)
) AS v(sessao, instancia, apelido, rep_codigo, guarda_corpo)
ON CONFLICT (sessao) DO UPDATE
   SET rep_codigo   = EXCLUDED.rep_codigo,
       rep_nome     = EXCLUDED.rep_nome,
       guarda_corpo = EXCLUDED.guarda_corpo
 WHERE ven_wa_sessao.rep_codigo IS NULL
   AND EXCLUDED.rep_codigo IS NOT NULL;   -- assistente/default: não sobrescreve o que a tela ajustou

-- Conferir: 8 linhas; rep-* com rep_codigo, rep_nome e guarda_corpo TRUE.
SELECT sessao, instancia, apelido, rep_codigo, rep_nome, guarda_corpo
FROM ven_wa_sessao
ORDER BY instancia, sessao;

-- 3) Permissão da tela /sistema/whatsapp (Sistema · WhatsApp). Parte só do
--    Lucas (codigo 159); depois se ajusta por usuário na tela Usuários.
--    `sis_permissoes` não tem índice único em (usuario_id, tela): a proteção
--    contra duplicata é o NOT EXISTS; rodar de novo insere 0 linhas.

-- Passo 1 — de onde partimos (só leitura).
SELECT u.codigo, u.nome, p.tela, p.visualizar, p.editar, p.criar, p.deletar
FROM sis_usuarios u
LEFT JOIN sis_permissoes p ON p.usuario_id = u.id AND p.tela = '/sistema/whatsapp'
WHERE u.codigo = '159';

-- Passo 2 — liberar.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT u.id, 'Sistema', '/sistema/whatsapp', TRUE, TRUE, TRUE, FALSE
FROM sis_usuarios u
WHERE u.codigo = '159'
  AND NOT EXISTS (
    SELECT 1 FROM sis_permissoes p
    WHERE p.usuario_id = u.id AND p.tela = '/sistema/whatsapp'
  );

-- Passo 3 — conferir: uma linha, visualizar/editar/criar TRUE, deletar FALSE.
SELECT u.codigo, u.nome, p.tela, p.visualizar, p.editar, p.criar, p.deletar
FROM sis_usuarios u
JOIN sis_permissoes p ON p.usuario_id = u.id AND p.tela = '/sistema/whatsapp'
WHERE u.codigo = '159';
