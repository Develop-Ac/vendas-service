-- ============================================================================
-- Ofertas do atacado (promoção, liquidação, campanha) — DDL PostgreSQL
--
-- ven_oferta: o grupo cadastrado na intranet (nome, tipo e, para campanha/
-- liquidação, origem e prêmio; premio_faixas = [{ a_partir_de, valor }]).
-- ven_oferta_item: o produto dentro do grupo, com preço por tabela (nulo = não
-- vale naquela tabela), vigência inicio..fim (fim inclusivo, dia de Cuiabá),
-- limite de unidades e o ciclo RASCUNHO > PENDENTE > APROVADO > ENCERRADO.
-- ven_orcamento_item ganha oferta_item_id e oferta_tipo: a linha vendida pela
-- oferta (base da conta de "vendidas" e da bolsa por tipo). Sem FK nessa coluna,
-- no mesmo espírito de promocao_codigo.
--
-- ORDEM: aplicar MANUALMENTE no Postgres da intranet (.144:5555 / intranet)
-- ANTES do deploy do vendas-service — o Prisma passa a ler oferta_item_id e
-- oferta_tipo em toda consulta de item de orçamento; sem as colunas, o
-- orçamento inteiro quebra. Não usar prisma migrate. Idempotente.
-- A permissão das telas (/estoque/promocoes) vai em SQL próprio.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ven_oferta (
  id                SERIAL PRIMARY KEY,
  nome              TEXT NOT NULL,
  tipo              TEXT NOT NULL
                    CHECK (tipo IN ('PROMOCAO', 'LIQUIDACAO', 'CAMPANHA')),
  origem            TEXT
                    CHECK (origem IN ('EMPRESA', 'FORNECEDOR')),           -- nulo fora de campanha
  fornecedor_codigo INTEGER,
  fornecedor_nome   TEXT,
  premio_tipo       TEXT
                    CHECK (premio_tipo IN ('PCT_CUSTO', 'PCT_VENDA', 'VALOR_UNIDADE')),
  premio_valor      NUMERIC(15,4),
  premio_faixas     JSONB,                                               -- [{ a_partir_de, valor }]
  criado_por        TEXT,
  criado_em         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  atualizado_em     TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ven_oferta_item (
  id               SERIAL PRIMARY KEY,
  oferta_id        INTEGER NOT NULL REFERENCES ven_oferta (id),
  pro_codigo       INTEGER NOT NULL,
  descricao        TEXT,                                                -- cópia do ERP na inclusão
  preco_t2         NUMERIC(15,2),                                       -- nulo = não vale na tabela 2
  preco_t5         NUMERIC(15,2),                                       -- nulo = não vale na tabela 5
  inicio           DATE NOT NULL,
  fim              DATE NOT NULL,                                       -- inclusivo
  limite_qtd       NUMERIC(15,3),                                       -- nulo = sem limite
  status           TEXT NOT NULL DEFAULT 'RASCUNHO'
                   CHECK (status IN ('RASCUNHO', 'PENDENTE', 'APROVADO', 'ENCERRADO')),
  enviado_por      TEXT,
  enviado_em       TIMESTAMPTZ(6),
  aprovado_por     TEXT,
  aprovado_em      TIMESTAMPTZ(6),
  encerrado_por    TEXT,
  encerrado_em     TIMESTAMPTZ(6),
  encerrado_motivo TEXT
                   CHECK (encerrado_motivo IN ('DATA', 'LIMITE', 'SALDO', 'MANUAL'))
);

CREATE INDEX IF NOT EXISTS ven_oferta_item_pro_idx
  ON ven_oferta_item (pro_codigo);
CREATE INDEX IF NOT EXISTS ven_oferta_item_oferta_idx
  ON ven_oferta_item (oferta_id);

ALTER TABLE ven_orcamento_item
  ADD COLUMN IF NOT EXISTS oferta_item_id INTEGER,                      -- ven_oferta_item.id (sem FK)
  ADD COLUMN IF NOT EXISTS oferta_tipo    TEXT;                         -- PROMOCAO | LIQUIDACAO | CAMPANHA na hora da venda

CREATE INDEX IF NOT EXISTS ven_orcamento_item_oferta_item_idx
  ON ven_orcamento_item (oferta_item_id)
  WHERE oferta_item_id IS NOT NULL;

-- Fonte da promoção do orçamento do atacado: linha única (id = 1). fonte_intranet
-- FALSE = promoções do Celta (como é hoje); TRUE = só as ofertas da intranet. Quem
-- troca é o botão da tela Estoque › Promoções (gestão); nasce no Celta.
CREATE TABLE IF NOT EXISTS ven_oferta_config (
  id             SMALLINT PRIMARY KEY CHECK (id = 1),
  fonte_intranet BOOLEAN NOT NULL DEFAULT FALSE,
  alterado_por   TEXT,
  alterado_em    TIMESTAMPTZ(6)
);
INSERT INTO ven_oferta_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
