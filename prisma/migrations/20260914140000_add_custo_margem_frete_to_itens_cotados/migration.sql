-- Custo, margem e frete de cada peça cotada da encomenda.
ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
  ADD COLUMN IF NOT EXISTS "custo" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "margem" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "frete" DOUBLE PRECISION;
