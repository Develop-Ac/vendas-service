-- ============================================================================
-- Tela do supervisor do atacado (/vendas/supervisao-atacado) — metas do
-- departamento e régua do semáforo. Aplicar MANUALMENTE no Postgres da
-- intranet (banco `intranet`). DDL/DML nunca roda pelo app.
--
-- Uma linha = a meta de UM indicador a partir de uma data. A meta que vale num
-- período é a de maior `vigente_desde` <= início do período: mês passado é
-- avaliado pela meta que valia naquele mês. Nunca se apaga nem se edita uma
-- linha — mudar a meta é inserir outra (o histórico fica). Só a gerência grava
-- (o vendas-service confere o papel).
--
-- `faixa_amarela`: o quanto abaixo da meta ainda é 🟡. Em indicador de % são
-- pontos percentuais; nos demais, % da meta. Acima dela é 🔴.
-- O sentido (quanto mais, melhor / quanto menos, melhor) e a unidade de cada
-- indicador ficam no catálogo do código (supervisao.indicadores.ts).
--
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem a
-- tabela, a tela abre com as metas padrão do código (as mesmas do seed abaixo)
-- e a gravação de metas falha.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ven_atacado_meta (
    id              TEXT PRIMARY KEY,
    indicador       TEXT          NOT NULL,
    valor           NUMERIC(15,2) NOT NULL,
    faixa_amarela   NUMERIC(7,2)  NOT NULL DEFAULT 10,
    vigente_desde   DATE          NOT NULL,
    observacao      TEXT,
    criado_por      TEXT,
    criado_por_nome TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ven_atacado_meta_ind_vig
    ON ven_atacado_meta (indicador, vigente_desde DESC, created_at DESC);

-- Metas iniciais (F1 · Defesa da Carteira e CRM fase 1), vigentes a partir do
-- mês comissional de outubro/2026 (26/09). Rodar de novo não duplica.
INSERT INTO ven_atacado_meta (id, indicador, valor, faixa_amarela, vigente_desde, observacao, criado_por_nome)
SELECT 'seed_' || v.indicador, v.indicador, v.valor, v.faixa, DATE '2026-09-26', 'Meta inicial (plano diretor F1 / CRM fase 1)', 'seed'
FROM (VALUES
    ('CLIENTES_ATIVOS_MES',       290,    10),
    ('RECEITA_MES',               550000, 10),
    ('VAZAMENTO_TRIMESTRE',       155000, 10),
    ('PERDA_SILENCIOSA',          400,    10),
    ('COMPRADORES_TRIMESTRE_PCT', 40,     10),
    ('CONVERSAO_7D_PCT',          65,     10),
    ('MOTIVOS_APONTADOS_PCT',     80,     10),
    ('RESGATE_SLA_PCT',           90,     10),
    ('FILA_NO_PRAZO_PCT',         80,     10),
    ('ESF_CURVA_A_FORA_REGUA',    0,      10),
    ('ESF_FILA_NO_PRAZO_PCT',     80,     10),
    ('ESF_MOTIVO_3DU_PCT',        80,     10),
    ('ESF_RESGATE_A_48H_PCT',     100,    10)
) AS v(indicador, valor, faixa)
WHERE NOT EXISTS (SELECT 1 FROM ven_atacado_meta m WHERE m.id = 'seed_' || v.indicador);

-- Conferir
SELECT indicador, valor, faixa_amarela, vigente_desde FROM ven_atacado_meta ORDER BY indicador, vigente_desde;
