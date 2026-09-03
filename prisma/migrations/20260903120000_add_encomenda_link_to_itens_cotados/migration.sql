-- Vincula os itens cotados à encomenda (espelha ven_encomenda_pecas_itens_encomendados).
-- Nullable porque já existem linhas antigas sem vínculo (o antigo array pecas_cotadas foi removido).
ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
  ADD COLUMN IF NOT EXISTS "encomenda_pecas_id" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ven_enc_pecas_itens_cotados_encomenda'
  ) THEN
    ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
      ADD CONSTRAINT "fk_ven_enc_pecas_itens_cotados_encomenda"
      FOREIGN KEY ("encomenda_pecas_id")
      REFERENCES "public"."ven_encomenda_pecas"("id")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idx_ven_enc_pecas_itens_cotados_encomenda_id"
  ON "public"."ven_encomenda_pecas_itens_cotados" ("encomenda_pecas_id");

-- Transportadora do item cotado (a coluna no banco está grafada "transpostadora").
ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
  ADD COLUMN IF NOT EXISTS "transpostadora" TEXT;

-- Autorização do item cotado.
ALTER TABLE "public"."ven_encomenda_pecas_itens_cotados"
  ADD COLUMN IF NOT EXISTS "autorizado" BOOLEAN;

-- Tabela de anexos da encomenda (imagem/pdf/video/audio enviados para o MinIO).
CREATE TABLE IF NOT EXISTS "public"."ven_encomenda_pecas_anexos" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ven_encomenda_id" INTEGER NOT NULL,
  "anexo" VARCHAR(500) NOT NULL,
  CONSTRAINT "pk_ven_enc_pecas_anexos" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ven_enc_pecas_anexos_encomenda'
  ) THEN
    ALTER TABLE "public"."ven_encomenda_pecas_anexos"
      ADD CONSTRAINT "fk_ven_enc_pecas_anexos_encomenda"
      FOREIGN KEY ("ven_encomenda_id")
      REFERENCES "public"."ven_encomenda_pecas"("id")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "idx_ven_enc_pecas_anexos_encomenda_id"
  ON "public"."ven_encomenda_pecas_anexos" ("ven_encomenda_id");

-- Data de criação da encomenda.
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "created_at" DATE DEFAULT now();
