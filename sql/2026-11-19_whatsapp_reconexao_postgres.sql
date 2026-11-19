-- ============================================================================
-- WhatsApp (WAHA) — usuário dono da sessão e reconexão pelo próprio usuário
-- Banco: Postgres da intranet (.144). Aplicar MANUALMENTE (não usar prisma
-- migrate). Idempotente: cada bloco pode rodar de novo sem erro e sem mudar nada.
--
-- ven_wa_sessao.usuario_codigo diz quem lê o QR quando a sessão cai.
-- ven_wa_reconexao guarda cada queda de sessão com usuário: quando caiu, quando
-- o usuário viu o aviso e reconectou, e a recarga do período fora do ar.
--
-- ORDEM: aplique ANTES do deploy do vendas-service. Com a coluna no schema e
-- não no banco, a leitura de ven_wa_sessao quebra: param o monitor de sessões
-- e o cache que o webhook usa. No primeiro tick depois do deploy, as sessões
-- já caídas que tiverem usuário (seção 3) entram na reconexão na hora.
-- ============================================================================

-- 1) Usuário da sessão (sis_usuarios.codigo, texto como na sis_usuarios).
ALTER TABLE ven_wa_sessao ADD COLUMN IF NOT EXISTS usuario_codigo TEXT;
COMMENT ON COLUMN ven_wa_sessao.usuario_codigo IS 'sis_usuarios.codigo de quem lê o QR quando a sessão cai; nulo = só pela tela /sistema/whatsapp.';

-- 2) Reconexões (espelha o model ven_wa_reconexao de prisma/schema.prisma).
CREATE TABLE IF NOT EXISTS ven_wa_reconexao (
  id                 TEXT PRIMARY KEY,               -- cuid gerado pelo Prisma
  sessao             TEXT NOT NULL,                  -- ven_wa_sessao.sessao
  caiu_em            TIMESTAMPTZ NOT NULL,           -- quando saiu de WORKING
  marcada_em         TIMESTAMPTZ NOT NULL,           -- quando o monitor abriu a reconexão
  modal_visto_em     TIMESTAMPTZ,                    -- quando o usuário viu o aviso na intranet
  qr_por             TEXT,                           -- nome de quem viu o QR por último pelo aviso
  reconectada_em     TIMESTAMPTZ,                    -- quando voltou a WORKING
  reconectada_por    TEXT,                           -- nulo = reconectada pela tela /sistema/whatsapp
  recarga_de         TIMESTAMPTZ,                    -- início do período recarregado (caiu_em - 1 h)
  recarga_proxima_em TIMESTAMPTZ,                    -- próxima rodada da recarga; nulo = sem rodada pendente
  recarga_rodadas    INTEGER NOT NULL DEFAULT 0,     -- rodadas de recarga já feitas
  recarga_lidas      INTEGER NOT NULL DEFAULT 0,     -- mensagens lidas do WAHA na recarga
  recarga_gravadas   INTEGER NOT NULL DEFAULT 0,     -- mensagens novas gravadas na recarga
  recarga_erro       TEXT,                           -- último erro da recarga
  concluida_em       TIMESTAMPTZ                     -- fim da reconexão (recarga feita ou dispensada)
);
CREATE INDEX IF NOT EXISTS idx_ven_wa_reconexao_sessao ON ven_wa_reconexao (sessao, marcada_em DESC);
COMMENT ON TABLE ven_wa_reconexao IS 'Queda de sessão do WAHA com usuário: espera o usuário ler o QR e depois recarrega o período fora do ar.';
COMMENT ON COLUMN ven_wa_reconexao.id                 IS 'cuid gerado pelo Prisma.';
COMMENT ON COLUMN ven_wa_reconexao.sessao             IS 'Nome da sessão no WAHA (ven_wa_sessao.sessao).';
COMMENT ON COLUMN ven_wa_reconexao.caiu_em            IS 'Quando a sessão saiu de WORKING.';
COMMENT ON COLUMN ven_wa_reconexao.marcada_em         IS 'Quando o monitor abriu a reconexão.';
COMMENT ON COLUMN ven_wa_reconexao.modal_visto_em     IS 'Quando o usuário viu o aviso de reconexão na intranet.';
COMMENT ON COLUMN ven_wa_reconexao.qr_por             IS 'Nome de quem viu o QR por último pelo aviso da intranet; o QR ou reinício pela tela limpa.';
COMMENT ON COLUMN ven_wa_reconexao.reconectada_em     IS 'Quando a sessão voltou a WORKING.';
COMMENT ON COLUMN ven_wa_reconexao.reconectada_por    IS 'Quem reconectou; nulo = reconectada pela tela /sistema/whatsapp.';
COMMENT ON COLUMN ven_wa_reconexao.recarga_de         IS 'Início do período recarregado (caiu_em - 1 h).';
COMMENT ON COLUMN ven_wa_reconexao.recarga_proxima_em IS 'Próxima rodada da recarga; nulo = sem rodada pendente.';
COMMENT ON COLUMN ven_wa_reconexao.recarga_rodadas    IS 'Rodadas de recarga já feitas.';
COMMENT ON COLUMN ven_wa_reconexao.recarga_lidas      IS 'Mensagens lidas do WAHA nas rodadas de recarga.';
COMMENT ON COLUMN ven_wa_reconexao.recarga_gravadas   IS 'Mensagens novas gravadas nas rodadas de recarga.';
COMMENT ON COLUMN ven_wa_reconexao.recarga_erro       IS 'Último erro da recarga (ex.: sessão não guarda conteúdo).';
COMMENT ON COLUMN ven_wa_reconexao.concluida_em       IS 'Fim da reconexão: recarga feita ou dispensada.';

-- 3) Carga do usuário das sessões de vendedor (só onde ainda está nulo; o que
--    a tela já ajustou não é sobrescrito e rodar de novo atualiza 0 linhas).
--    Ficam sem usuário: rep-316 e wa-numero-atacado-geral (mesmo telefone
--    556699213853; o usuário se escolhe pela tela: Lucas Barrada 143 ou o
--    usuário Atacado 789), assistente e default.
UPDATE ven_wa_sessao SET usuario_codigo = '37'  WHERE sessao = 'rep-163' AND usuario_codigo IS NULL;  -- Alisson
UPDATE ven_wa_sessao SET usuario_codigo = '83'  WHERE sessao = 'rep-200' AND usuario_codigo IS NULL;  -- Fernando
UPDATE ven_wa_sessao SET usuario_codigo = '240' WHERE sessao = 'rep-349' AND usuario_codigo IS NULL;  -- Cristiano
UPDATE ven_wa_sessao SET usuario_codigo = '262' WHERE sessao = 'rep-354' AND usuario_codigo IS NULL;  -- Deyvid
UPDATE ven_wa_sessao SET usuario_codigo = '263' WHERE sessao = 'rep-999' AND usuario_codigo IS NULL;  -- Leandro

-- Conferir: rep-163/200/349/354/999 com usuário; rep-316, wa-numero-atacado-geral,
-- assistente e default sem usuário.
SELECT sessao, usuario_codigo, status, leituras_fora
FROM ven_wa_sessao
ORDER BY sessao;
