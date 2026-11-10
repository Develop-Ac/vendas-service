-- ============================================================================
-- Tela única de gestão do atacado (/vendas/atacado) — fechamento do mês
-- comissional, metas da escada nov/26–mar/27 e permissão de tela. Aplicar
-- MANUALMENTE no Postgres da intranet (banco `intranet`). DDL/DML nunca roda
-- pelo app.
--
-- 1. `ven_atacado_fechamento`: uma linha por mês comissional fechado (foto da
--    visão geral + equipe no momento do fechamento). Reapurar regrava a mesma
--    linha (UNIQUE ano, mes). Só a gerência fecha (o vendas-service confere).
-- 2. Metas em `ven_atacado_meta` (append-only com vigência; a meta de um
--    período é a de maior `vigente_desde` <= início do período). Datas = início
--    do mês comissional (dia 26 do mês anterior).
-- 3. `sis_permissoes`: libera /vendas/atacado (só ver) para quem já via uma
--    das telas que ela substitui, e cada aba pela tela antiga que ela herdou:
--      /vendas/supervisao-atacado         -> /vendas/atacado/supervisao (Visão geral, Equipe, Carteira, Fechamento)
--      /vendas/carteirizacao/supervisao   -> /vendas/atacado/esteira    (esteira de resgate na aba Carteira)
--      /vendas/produtos-do-dia            -> /vendas/atacado/produtos-do-dia
--      /vendas/atacado-painel             -> /vendas/atacado/canal
--    Ninguém passa a ver o que não via antes. As linhas das rotas antigas ficam.
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega (e depois
-- do 2026-10-09_supervisao_atacado_metas_postgres.sql, que cria
-- ven_atacado_meta). Sem a tabela o fechamento falha; sem a permissão a tela
-- não abre para ninguém (Vendas é permissão estrita). Rodar de novo não
-- duplica nada.
-- ============================================================================

-- Passo 1 — de onde partimos (só leitura).
SELECT to_regclass('public.ven_atacado_fechamento') AS tabela_fechamento;

SELECT indicador, valor, vigente_desde
FROM ven_atacado_meta
WHERE id LIKE 'seed\_%\_2026____' OR id LIKE 'seed\_%\_2027____'
ORDER BY indicador, vigente_desde;

SELECT tela, count(DISTINCT usuario_id) AS usuarios
FROM sis_permissoes
WHERE tela IN ('/vendas/supervisao-atacado', '/vendas/atacado-painel', '/vendas/produtos-do-dia', '/vendas/carteirizacao/supervisao',
               '/vendas/atacado', '/vendas/atacado/supervisao', '/vendas/atacado/esteira', '/vendas/atacado/produtos-do-dia', '/vendas/atacado/canal')
  AND visualizar
GROUP BY tela;

-- Passo 2a — tabela do fechamento (espelha o model ven_atacado_fechamento do
-- prisma/schema.prisma; o id é cuid gerado pelo app).
CREATE TABLE IF NOT EXISTS ven_atacado_fechamento (
    id          TEXT          PRIMARY KEY,
    ano         INTEGER       NOT NULL,
    mes         INTEGER       NOT NULL,
    nivel       INTEGER       NOT NULL,
    pontos      NUMERIC(5,2)  NOT NULL,
    venda       NUMERIC(15,2) NOT NULL,
    meta        NUMERIC(15,2) NOT NULL,
    foto        JSONB         NOT NULL,
    fechado_em  TIMESTAMPTZ(6) NOT NULL,
    fechado_por TEXT          NOT NULL,
    CONSTRAINT uq_ven_atacado_fechamento_periodo UNIQUE (ano, mes)
);

-- Passo 2b — metas da escada (id seed_<indicador>_<aaaammdd>); vigência que a
-- gerência já cadastrou fica com o valor dela.
INSERT INTO ven_atacado_meta (id, indicador, valor, faixa_amarela, vigente_desde, observacao, criado_por_nome)
SELECT 'seed_' || v.indicador || '_' || to_char(v.desde, 'YYYYMMDD'), v.indicador, v.valor, 10, v.desde,
       'Meta inicial (gestão do atacado, escada nov/26–mar/27)', 'seed'
FROM (VALUES
    ('CLIENTES_ATIVOS_MES',   230,    DATE '2026-10-26'),
    ('CLIENTES_ATIVOS_MES',   250,    DATE '2026-11-26'),
    ('CLIENTES_ATIVOS_MES',   260,    DATE '2026-12-26'),
    ('CLIENTES_ATIVOS_MES',   275,    DATE '2027-01-26'),
    ('CLIENTES_ATIVOS_MES',   290,    DATE '2027-02-26'),
    ('RECUPERACAO_AB_PCT',    30,     DATE '2026-10-26'),
    ('RECUPERACAO_AB_PCT',    35,     DATE '2026-11-26'),
    ('RECUPERACAO_AB_PCT',    40,     DATE '2026-12-26'),
    ('RECUPERACAO_AB_PCT',    40,     DATE '2027-01-26'),
    ('RECUPERACAO_AB_PCT',    40,     DATE '2027-02-26'),
    ('CURVA_A_COMPRANDO_PCT', 65,     DATE '2026-10-26'),
    ('CURVA_A_COMPRANDO_PCT', 70,     DATE '2026-11-26'),
    ('CURVA_A_COMPRANDO_PCT', 75,     DATE '2026-12-26'),
    ('CURVA_A_COMPRANDO_PCT', 75,     DATE '2027-01-26'),
    ('CURVA_A_COMPRANDO_PCT', 75,     DATE '2027-02-26'),
    ('RESGATE_SLA_PCT',       90,     DATE '2026-10-26'),
    ('MOTIVOS_APONTADOS_PCT', 80,     DATE '2026-10-26'),
    ('CUSTO_DEPARTAMENTO',    157000, DATE '2026-10-26'),
    ('PREMIO_N1',             800,    DATE '2026-10-26'),
    ('PREMIO_N2',             1500,   DATE '2026-10-26'),
    ('PREMIO_N3',             2000,   DATE '2026-10-26')
) AS v(indicador, valor, desde)
-- Não entra seed onde já há meta do mesmo indicador e vigência (gravada pela
-- gerência no modal ou seed anterior): a gravada vale.
WHERE NOT EXISTS (
    SELECT 1 FROM ven_atacado_meta m
    WHERE m.indicador = v.indicador AND m.vigente_desde = v.desde
);

-- Passo 2c — liberar /vendas/atacado (só ver) para quem vê qualquer uma das
-- telas antigas. `sis_permissoes` não tem índice único em (usuario_id, tela):
-- a proteção contra duplicata é o NOT EXISTS.
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT p.usuario_id, 'Vendas', '/vendas/atacado', TRUE, FALSE, FALSE, FALSE
FROM sis_permissoes p
WHERE p.tela IN ('/vendas/supervisao-atacado', '/vendas/atacado-painel', '/vendas/produtos-do-dia')
  AND p.visualizar
GROUP BY p.usuario_id
HAVING NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = '/vendas/atacado'
);

-- Passo 2d — cada aba pela tela antiga que ela herdou (só ver; mesma proteção
-- contra duplicata).
INSERT INTO sis_permissoes (usuario_id, modulo, tela, visualizar, editar, criar, deletar)
SELECT DISTINCT p.usuario_id, 'Vendas', m.nova, TRUE, FALSE, FALSE, FALSE
FROM sis_permissoes p
JOIN (VALUES
    ('/vendas/supervisao-atacado',       '/vendas/atacado/supervisao'),
    ('/vendas/carteirizacao/supervisao', '/vendas/atacado/esteira'),
    ('/vendas/produtos-do-dia',          '/vendas/atacado/produtos-do-dia'),
    ('/vendas/atacado-painel',           '/vendas/atacado/canal')
) AS m(antiga, nova) ON m.antiga = p.tela
WHERE p.visualizar
  AND NOT EXISTS (
    SELECT 1 FROM sis_permissoes n
    WHERE n.usuario_id = p.usuario_id AND n.tela = m.nova
  );

-- Passo 3 — conferir: tabela criada, até 21 metas seed (menos as vigências que
-- a gerência já tinha) e
-- /vendas/atacado com o número de usuários distintos das três telas somadas.
SELECT to_regclass('public.ven_atacado_fechamento') AS tabela_fechamento;

SELECT indicador, valor, faixa_amarela, vigente_desde
FROM ven_atacado_meta
WHERE id LIKE 'seed\_%\_2026____' OR id LIKE 'seed\_%\_2027____'
ORDER BY indicador, vigente_desde;

SELECT
    (SELECT count(DISTINCT usuario_id) FROM sis_permissoes
     WHERE tela IN ('/vendas/supervisao-atacado', '/vendas/atacado-painel', '/vendas/produtos-do-dia')
       AND visualizar) AS usuarios_telas_antigas,
    (SELECT count(DISTINCT usuario_id) FROM sis_permissoes
     WHERE tela = '/vendas/atacado' AND visualizar) AS usuarios_atacado;

-- Cada aba nova com o mesmo número de usuários da tela antiga dela.
SELECT m.antiga, m.nova,
       (SELECT count(DISTINCT usuario_id) FROM sis_permissoes WHERE tela = m.antiga AND visualizar) AS usuarios_antiga,
       (SELECT count(DISTINCT usuario_id) FROM sis_permissoes WHERE tela = m.nova AND visualizar) AS usuarios_nova
FROM (VALUES
    ('/vendas/supervisao-atacado',       '/vendas/atacado/supervisao'),
    ('/vendas/carteirizacao/supervisao', '/vendas/atacado/esteira'),
    ('/vendas/produtos-do-dia',          '/vendas/atacado/produtos-do-dia'),
    ('/vendas/atacado-painel',           '/vendas/atacado/canal')
) AS m(antiga, nova);
