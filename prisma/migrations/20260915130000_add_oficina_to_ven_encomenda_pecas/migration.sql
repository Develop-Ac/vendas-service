-- Indica se a encomenda é de oficina, enviado no POST /encomenda-pecas.
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "oficina" BOOLEAN;
