-- Prazo da encomenda, gravado via PUT /encomenda-pecas/status/:id.
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "prazo" DATE;
