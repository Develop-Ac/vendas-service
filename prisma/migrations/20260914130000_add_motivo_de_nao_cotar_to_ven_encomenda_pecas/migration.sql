-- Motivo de não cotar a encomenda, enviado opcionalmente em PUT /encomenda-pecas/status/:id.
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "motivoDenaoCotar" TEXT;
