-- Feature: Encomenda de Peças gera pedido de compra ("E-100001") ao ser marcada
-- como "Comprado" (POST /compras/pedido/encomenda no compras-service).
--
-- * Item cotado passa a guardar o fornecedor como CÓDIGO do Celta (for_codigo);
--   a coluna texto `fornecedor` continua, agora com o nome vindo da API do ERP.
-- * Item cotado passa a dizer de qual produto do Celta ele é (pro_codigo), que é o
--   item que vai para o pedido.
-- * A encomenda guarda o número do pedido gerado (pedido_compras) para a listagem
--   mostrar "E-100001" sem consultar o compras-service.
--
-- Aplicar MANUALMENTE no Postgres da intranet (não rodar migration).
-- Depois: `npx prisma db pull` e `npx prisma generate` no vendas-service.

ALTER TABLE ven_encomenda_pecas_itens_cotados
  ADD COLUMN IF NOT EXISTS for_codigo INTEGER NULL;

ALTER TABLE ven_encomenda_pecas_itens_cotados
  ADD COLUMN IF NOT EXISTS pro_codigo INTEGER NULL;

ALTER TABLE ven_encomenda_pecas
  ADD COLUMN IF NOT EXISTS pedido_compras INTEGER NULL;
