-- ============================================================================
-- Ofertas do atacado — condições por item (etapa 3) — DDL PostgreSQL
--
-- ven_oferta_item ganha as condições que passam a ser do item, não do grupo:
--   tipo            PROMOCAO | LIQUIDACAO | CAMPANHA do item (o do grupo vira padrão);
--   premio_valor    bônus da liquidação em fração do custo (0,05 = 5%); nulo fora dela;
--   limite_cliente  máximo de unidades por cliente na oferta (nulo = sem teto);
--   qtd_minima      quantidade a partir da qual vale o primeiro preço (padrão 1);
--   niveis          preço progressivo: [{ a_partir_de, preco_t2, preco_t5 }], até 2;
--   par_pro_codigo  agarradinho: produto que precisa ir junto (nulo = sem par);
--   par_descricao   cópia da descrição do par no ERP;
--   par_proporcao   unidades da oferta liberadas por unidade do par.
-- Os itens já cadastrados herdam o tipo do grupo; os de liquidação herdam o
-- percentual do grupo. Nenhum preço é tocado.
--
-- ORDEM: aplicar MANUALMENTE no Postgres da intranet (.144:5555 / intranet)
-- DEPOIS de 2026-11-17_ofertas_postgres.sql e ANTES do deploy do vendas-service
-- — o Prisma passa a ler essas colunas em toda consulta de item de oferta; sem
-- elas, o cadastro e o orçamento do atacado quebram. Não usar prisma migrate.
-- Idempotente. Sem SQL de permissão (nenhuma tela nova).
-- ============================================================================

BEGIN;

ALTER TABLE ven_oferta_item
  ADD COLUMN IF NOT EXISTS tipo           TEXT,
  ADD COLUMN IF NOT EXISTS premio_valor   NUMERIC(15,4),                -- só liquidação
  ADD COLUMN IF NOT EXISTS limite_cliente NUMERIC(15,3),                -- nulo = sem teto
  ADD COLUMN IF NOT EXISTS qtd_minima     NUMERIC(15,3) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS niveis         JSONB,                        -- [{ a_partir_de, preco_t2, preco_t5 }], até 2
  ADD COLUMN IF NOT EXISTS par_pro_codigo INTEGER,
  ADD COLUMN IF NOT EXISTS par_descricao  TEXT,
  ADD COLUMN IF NOT EXISTS par_proporcao  NUMERIC(15,3);

-- Itens já cadastrados: tipo do grupo; liquidação leva o percentual do grupo.
UPDATE ven_oferta_item i
   SET tipo = o.tipo,
       premio_valor = CASE WHEN o.tipo = 'LIQUIDACAO' THEN o.premio_valor END
  FROM ven_oferta o
 WHERE i.oferta_id = o.id
   AND i.tipo IS NULL;

-- DEFAULT 'PROMOCAO': o vendas-service anterior ao deploy ainda insere itens sem
-- tipo enquanto este SQL já está aplicado; o código novo sempre grava o tipo.
ALTER TABLE ven_oferta_item ALTER COLUMN tipo SET DEFAULT 'PROMOCAO';
ALTER TABLE ven_oferta_item ALTER COLUMN tipo SET NOT NULL;

ALTER TABLE ven_oferta_item DROP CONSTRAINT IF EXISTS ven_oferta_item_tipo_check;
ALTER TABLE ven_oferta_item
  ADD CONSTRAINT ven_oferta_item_tipo_check
  CHECK (tipo IN ('PROMOCAO', 'LIQUIDACAO', 'CAMPANHA'));

COMMIT;
