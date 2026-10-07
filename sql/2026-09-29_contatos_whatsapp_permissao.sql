-- ============================================================================
-- Aba nova: /vendas/carteirizacao/contatos — Contatos WhatsApp
-- (lista de números sem cliente com sugestão de vínculo)
-- Aplicar MANUALMENTE no Postgres da intranet. DDL/DML nunca roda pelo app.
--
-- A aba mostra o nome salvo na agenda dos celulares corporativos e trechos de
-- evidência das conversas (produto citado): é visão de supervisão. Por isso
-- parte de quem já vê a aba Supervisão da carteirização. Depois disso a
-- permissão se ajusta por usuário na tela Usuários, item
-- "Carteirização · Contatos WhatsApp".
--
-- ORDEM: aplique ANTES de subir o front novo. Entre o deploy e o script a aba
-- simplesmente não aparece para ninguém.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/carteirizacao/contatos') AND visualizar
GROUP BY tela;

-- Passo 2 — liberar para quem vê a Supervisão. `editar` junto: a aba grava
-- vínculo e "não é cliente". `sis_permissoes` não tem índice único em
-- (usuario_id, tela): a proteção contra duplicata é o NOT EXISTS; rodar de novo
-- insere 0 linhas.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT p.usuario_id, 'Vendas', '/vendas/carteirizacao/contatos', TRUE, TRUE, FALSE, FALSE
FROM sis_permissoes p
WHERE p.tela = '/vendas/carteirizacao/supervisao'
  AND p.visualizar
GROUP BY p.usuario_id
HAVING NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = '/vendas/carteirizacao/contatos'
);

-- Passo 3 — conferir: as duas telas devem ter o mesmo número de usuários.
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/carteirizacao/contatos') AND visualizar
GROUP BY tela;
