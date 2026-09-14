-- Imposto de cada peça cotada da encomenda.
ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
  ADD COLUMN IF NOT EXISTS "imposto" DOUBLE PRECISION;
