-- Ajuste da bolsa negativa (30/09/2026). Produto avariado, usado ou com embalagem danificada só
-- vende com desconto extra e deixa a linha negativa na bolsa do vendedor. Quem tem a permissão
-- '/vendas/orcamento/ajustar-bolsa' (sis_permissoes, editar ou criar — ninguém recebe aqui) reduz
-- o que sai da bolsa naquela linha, com motivo e justificativa. Guardado por unidade
-- (`assumido_unit`, o que a empresa assume); entra na bolsa quando a NF casa com o orçamento.
-- Idempotente: pode rodar de novo.

CREATE TABLE IF NOT EXISTS ven_bolsa_ajuste (
  id               TEXT PRIMARY KEY,
  orcamento_id     TEXT NOT NULL REFERENCES ven_orcamento(id) ON DELETE CASCADE,
  pro_codigo       INTEGER NOT NULL,
  cli_codigo       INTEGER NOT NULL,
  rep_codigo       INTEGER,
  quantidade       NUMERIC(15,3) NOT NULL,
  assumido_unit    NUMERIC(15,4) NOT NULL,   -- R$ por unidade que a empresa assume (> 0)
  negativo_linha   NUMERIC(15,2) NOT NULL,   -- R$ da linha na bolsa ao ajustar (< 0)
  motivo           TEXT NOT NULL,            -- AVARIADO | USADO | EMBALAGEM | OUTRO
  justificativa    TEXT NOT NULL,
  ajustado_id      TEXT,                     -- sis_usuarios.id
  ajustado_por     TEXT,
  ajustado_codigo  INTEGER,                  -- código ERP de quem ajustou
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_ven_bolsa_ajuste_orc_pro UNIQUE (orcamento_id, pro_codigo)
);
CREATE INDEX IF NOT EXISTS idx_ven_bolsa_ajuste_created ON ven_bolsa_ajuste (created_at);
CREATE INDEX IF NOT EXISTS idx_ven_bolsa_ajuste_rep ON ven_bolsa_ajuste (rep_codigo);

-- a aprovação veio do ajuste (dentro da alçada): cai se o orçamento passar da alçada ou o ajuste sair
ALTER TABLE ven_orcamento ADD COLUMN IF NOT EXISTS aprovado_por_ajuste BOOLEAN NOT NULL DEFAULT FALSE;

-- vendedor pede o ajuste na linha: enviar leva o orçamento a APROVACAO até alguém ajustar
ALTER TABLE ven_orcamento_item ADD COLUMN IF NOT EXISTS pedir_ajuste BOOLEAN NOT NULL DEFAULT FALSE;
