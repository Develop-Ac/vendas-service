-- Encomenda de Peças: hora de criação e hora de entrada em cada etapa.
-- Aplicar manualmente no Postgres da intranet (idempotente: pode rodar de novo).
-- Horários gravados na hora local de Cuiabá (UTC-4), sem fuso, pelo vendas-service.

-- 1) created_at com hora
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'ven_encomenda_pecas'
        AND column_name = 'created_at') = 'date' THEN
    ALTER TABLE "public"."ven_encomenda_pecas"
      ALTER COLUMN "created_at" TYPE TIMESTAMP(6) USING ("created_at"::timestamp);
  END IF;
END $$;

ALTER TABLE "public"."ven_encomenda_pecas"
  ALTER COLUMN "created_at" SET DEFAULT (now() AT TIME ZONE 'America/Cuiaba');

-- 2) hora de entrada em cada etapa
ALTER TABLE "public"."ven_encomenda_pecas"
  ADD COLUMN IF NOT EXISTS "aguardando_cotacao"       TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "em_cotacao"               TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "aguardando_sup_compras_1" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "aguardando_vendedor"      TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "aguardando_sup_compras_2" TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "liberado_para_comprar"    TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "comprado"                 TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "chegou"                   TIMESTAMP(6),
  ADD COLUMN IF NOT EXISTS "cancelado"                TIMESTAMP(6);

-- Encomendas já existentes: a entrada em "Aguardando cotação" é a criação.
UPDATE "public"."ven_encomenda_pecas"
   SET "aguardando_cotacao" = "created_at"
 WHERE "aguardando_cotacao" IS NULL;
