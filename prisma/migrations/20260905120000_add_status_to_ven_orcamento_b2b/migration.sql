-- Status do pedido no portal B2B (ex.: 'pendente', 'aprovado'), copiado do
-- payload de /api/pedidos no momento em que o pedido é gravado aqui.
ALTER TABLE "public"."ven_orcamento_b2b"
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(50);
