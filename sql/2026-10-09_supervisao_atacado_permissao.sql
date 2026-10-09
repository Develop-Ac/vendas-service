-- ============================================================================
-- Tela nova: /vendas/supervisao-atacado — Supervisão do atacado (KPIs do
-- departamento + esforço mínimo da equipe). Aplicar MANUALMENTE no Postgres da
-- intranet (banco `intranet`). DDL/DML nunca roda pelo app.
--
-- É a tela do supervisor do atacado (e da gerência, que define as metas).
-- Parte de quem já vê a Supervisão da carteirização. Gravar metas continua
-- restrito à gerência pelo papel do cadastro (o vendas-service confere): a
-- permissão de tela só deixa ABRIR.
--
-- ORDEM: depois do 2026-10-09_supervisao_atacado_metas_postgres.sql. Pode ser
-- antes ou depois de publicar o front; sem este script a tela não abre.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/supervisao-atacado') AND visualizar
GROUP BY tela;

-- Passo 2 — liberar (só ver) para quem vê a supervisão da carteirização.
-- Para outro grupo, troque a tela de referência do WHERE (ou liste os usuario_id).
-- `sis_permissoes` não tem índice único em (usuario_id, tela): a proteção contra
-- duplicata é o NOT EXISTS; rodar de novo insere 0 linhas.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT p.usuario_id, 'Vendas', '/vendas/supervisao-atacado', TRUE, FALSE, FALSE, FALSE
FROM sis_permissoes p
WHERE p.tela = '/vendas/carteirizacao/supervisao'
  AND p.visualizar
GROUP BY p.usuario_id
HAVING NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = '/vendas/supervisao-atacado'
);

-- Passo 3 — conferir: as duas telas devem ter o mesmo número de usuários.
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/supervisao-atacado') AND visualizar
GROUP BY tela;
