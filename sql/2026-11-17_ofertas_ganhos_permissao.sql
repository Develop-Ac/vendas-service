-- ============================================================================
-- Tela nova: /estoque/promocoes/ganhos — aba 'Ganhos dos vendedores' de
-- /estoque/promocoes e rota GET /oferta/ganhos do vendas-service. Só gestão.
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- Não é liberada para ninguém por padrão: a lista de usuários do passo 2 é
-- preenchida à mão por quem decide quem vê os ganhos dos vendedores.
--
-- ORDEM: pode ser antes ou depois de publicar o front. Sem o script a aba não
-- aparece para quem não é admin, e GET /oferta/ganhos responde 403.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/estoque/promocoes', '/estoque/promocoes/aprovar', '/estoque/promocoes/ganhos') AND visualizar
GROUP BY tela;

-- Passo 2 — /estoque/promocoes/ganhos: PREENCHER a lista de usuario_id antes
-- de rodar. Com a lista vazia, o INSERT não insere ninguém. `sis_permissoes`
-- não tem índice único em (usuario_id, tela): a proteção contra duplicata é o
-- NOT EXISTS; rodar de novo insere 0 linhas.
-- Ex.: WHERE u.usuario_id IN ('id-do-usuario-1', 'id-do-usuario-2')
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT u.usuario_id, 'Estoque', '/estoque/promocoes/ganhos', TRUE, FALSE, FALSE, FALSE
FROM (SELECT DISTINCT usuario_id FROM sis_permissoes) u
WHERE u.usuario_id IN (NULL /* <- trocar NULL pelos usuario_id da gestão */)
  AND NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = u.usuario_id AND n.tela = '/estoque/promocoes/ganhos'
);

-- Passo 3 — conferir: /estoque/promocoes/ganhos só com os usuários do passo 2.
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/estoque/promocoes', '/estoque/promocoes/aprovar', '/estoque/promocoes/ganhos') AND visualizar
GROUP BY tela;
