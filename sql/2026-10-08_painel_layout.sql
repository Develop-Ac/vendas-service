-- ============================================================================
-- Painel de vendas por hub: ajustes de layout feitos pela tela (08/10/2026)
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
--
-- O catálogo do vendas-service (src/paineis/catalogo/<hub>.json) é o layout
-- padrão; cada linha aqui sobrescreve posição, tamanho, visibilidade e título
-- de um card de um hub. Sem linha = padrão do catálogo. O PUT
-- /paineis/vendedor/layout regrava todas as linhas do hub; o DELETE apaga
-- (= "Restaurar padrão").
-- ============================================================================

CREATE TABLE IF NOT EXISTS ven_painel_layout (
  painel          VARCHAR(32)  NOT NULL,              -- hub: VAREJO | ATACADO | SUPERVISAO_ATACADO | GERENCIA
  dashcard        INTEGER      NOT NULL,              -- dashcard do catálogo
  "row"           INTEGER      NOT NULL,
  col             INTEGER      NOT NULL,
  size_x          INTEGER      NOT NULL,              -- grade de 24 colunas
  size_y          INTEGER      NOT NULL,
  oculto          BOOLEAN      NOT NULL DEFAULT false,
  titulo          VARCHAR(120),                       -- nulo = título do catálogo
  atualizado_por  VARCHAR(120),
  atualizado_em   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ven_painel_layout_pkey PRIMARY KEY (painel, dashcard)
);
