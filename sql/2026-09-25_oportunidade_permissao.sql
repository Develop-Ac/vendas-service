-- ============================================================================
-- Tela nova: /vendas/orcamento/oportunidade — Compra de oportunidade
-- (reserva da empresa na bolsa do vendedor). Aplicar MANUALMENTE no Postgres
-- da intranet (banco `intranet`). DDL/DML nunca roda pelo app.
--
-- A tela registra a nota de compra e o % da sobra que fica com o vendedor: é
-- decisão de gestão, não de vendedor. Por isso parte de quem já vê a supervisão
-- da carteirização. A própria tela ainda exige o papel de gestão do orçamento.
--
-- ORDEM: pode ser antes ou depois de publicar o front. Sem o script a tela só
-- abre pelo botão "Compra de oportunidade" da lista de orçamentos (gestão) e
-- não aparece no cadastro de usuários como liberada.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/orcamento/oportunidade') AND visualizar
GROUP BY tela;

-- Passo 2 — liberar (ver + editar) para quem vê a supervisão da carteirização.
-- Para outro grupo, troque a tela de referência do WHERE (ou liste os usuario_id).
-- `sis_permissoes` não tem índice único em (usuario_id, tela): a proteção contra
-- duplicata é o NOT EXISTS; rodar de novo insere 0 linhas.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT p.usuario_id, 'Vendas', '/vendas/orcamento/oportunidade', TRUE, TRUE, TRUE, FALSE
FROM sis_permissoes p
WHERE p.tela = '/vendas/carteirizacao/supervisao'
  AND p.visualizar
GROUP BY p.usuario_id
HAVING NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = '/vendas/orcamento/oportunidade'
);

-- Passo 3 — conferir: as duas telas devem ter o mesmo número de usuários.
SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/carteirizacao/supervisao', '/vendas/orcamento/oportunidade') AND visualizar
GROUP BY tela;
