-- Origem do anexo da encomenda: 'carro' (imagens enviadas na criação) ou
-- 'comprovante' (arquivos enviados depois, via POST /encomenda-pecas/anexo/:id).
-- Default 'comprovante' porque até aqui só o endpoint de anexo gravava nesta tabela.
ALTER TABLE "public"."ven_encomenda_pecas_anexos"
  ADD COLUMN IF NOT EXISTS "tipo" VARCHAR(20) NOT NULL DEFAULT 'comprovante';
