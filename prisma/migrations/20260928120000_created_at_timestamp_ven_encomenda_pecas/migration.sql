-- created_at passa a guardar data e hora da criação no horário local
-- (America/Cuiaba, UTC-4), sem fuso: a tela mostra o valor como está gravado.
-- Só converte se a coluna ainda for DATE; registros antigos viram meia-noite.
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
