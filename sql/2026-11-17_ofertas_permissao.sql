-- ============================================================================
-- Telas novas: /estoque/promocoes (Sugestões + Promoções e liquidações) e
-- /estoque/promocoes/aprovar (aprovar e encerrar itens de oferta — gestão).
-- Aplicar MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca
-- roda pelo app.
--
-- /estoque/promocoes herda a aba Promoção que saiu de /estoque/analise: quem vê
-- a análise passa a ver a tela nova, com os mesmos visualizar/editar/criar.
-- /estoque/promocoes/aprovar não é liberada para ninguém por padrão: a lista de
-- usuários do passo 2b é preenchida à mão por quem decide quem aprova.
--
-- ORDEM: pode ser antes ou depois de publicar o front. Sem o script a tela não
-- aparece no menu de quem não é admin, e o vendas-service responde 403.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/estoque/analise', '/estoque/promocoes', '/estoque/promocoes/aprovar') AND visualizar
GROUP BY tela;

-- Passo 2a — /estoque/promocoes para quem vê /estoque/analise, copiando
-- visualizar/editar/criar da análise. `sis_permissoes` não tem índice único em
-- (usuario_id, tela): a proteção contra duplicata é o NOT EXISTS; rodar de novo
-- insere 0 linhas.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT p.usuario_id, 'Estoque', '/estoque/promocoes',
       bool_or(p.visualizar), bool_or(p.editar), bool_or(p.criar), FALSE
FROM sis_permissoes p
WHERE p.tela = '/estoque/analise'
  AND p.visualizar
GROUP BY p.usuario_id
HAVING NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = '/estoque/promocoes'
);

-- Passo 2b — /estoque/promocoes/aprovar: PREENCHER a lista de usuario_id antes
-- de rodar. Com a lista vazia, o INSERT não insere ninguém.
-- Ex.: WHERE u.usuario_id IN ('id-do-usuario-1', 'id-do-usuario-2')
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT u.usuario_id, 'Estoque', '/estoque/promocoes/aprovar', TRUE, TRUE, TRUE, FALSE
FROM (SELECT DISTINCT usuario_id FROM sis_permissoes) u
WHERE u.usuario_id IN (NULL /* <- trocar NULL pelos usuario_id que aprovam */)
  AND NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = u.usuario_id AND n.tela = '/estoque/promocoes/aprovar'
);

-- Passo 3 — conferir: /estoque/promocoes com o mesmo número de usuários de
-- /estoque/analise; /estoque/promocoes/aprovar só com os usuários do passo 2b.
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/estoque/analise', '/estoque/promocoes', '/estoque/promocoes/aprovar') AND visualizar
GROUP BY tela;
