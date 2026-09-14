-- Motivo informado ao cancelar a encomenda (PUT /encomenda-pecas/status/:id com status 'Cancelado').
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "motivoCancelamento" TEXT;
