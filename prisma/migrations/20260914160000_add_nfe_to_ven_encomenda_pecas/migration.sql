-- NF-e da encomenda, gravada via PUT /encomenda-pecas/nfe/:id.
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "nfe" TEXT;
