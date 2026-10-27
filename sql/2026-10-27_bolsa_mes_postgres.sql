-- ============================================================================
-- Fechamento mensal da bolsa do atacado (ven_bolsa_mes). Aplicar MANUALMENTE no
-- Postgres da intranet (banco `intranet`). DDL/DML nunca roda pelo app.
--
-- Uma linha = um vendedor (rep_codigo) num mês COMISSIONAL (26 a 25; `mes` é o
-- mês em que o período termina). No fechamento (dia 26, ou POST
-- /orcamento/bolsa/fechamento) o vendas-service grava:
--   gerado      = bolsa do mês (receita − custo × piso + absorvido + ajuste − excedente)
--   saldo_final = saldo_inicial + gerado
--   reserva     = 30% do saldo_final, até R$ 3 mil (negativo passa 30% sem teto)
--   premio_base = max(0, lucro acima da linha − reserva), sem absorvido/ajuste (a mesma conta do cartão);
--   premio_pct  = taxa pelo atingimento da meta (5% / 15% / 25%)
--   premio      = premio_pct × premio_base (meta e atingimento gravados junto)
-- e cria a linha do mês seguinte só com saldo_inicial = reserva. Linha com
-- fechado_em NULL = mês ainda aberto, só carrega o saldo inicial.
--
-- Idempotente: pode rodar de novo.
-- ORDEM: aplicar ANTES de publicar o vendas-service desta entrega. Sem a tabela,
-- a bolsa sai com saldo inicial 0 e o fechamento falha.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ven_bolsa_mes (
    id            TEXT PRIMARY KEY,
    rep_codigo    INTEGER       NOT NULL,
    ano           INTEGER       NOT NULL,
    mes           INTEGER       NOT NULL,              -- mês comissional (1–12)
    saldo_inicial NUMERIC(15,2) NOT NULL DEFAULT 0,    -- reserva do fechamento anterior
    gerado        NUMERIC(15,2),
    saldo_final   NUMERIC(15,2),
    reserva       NUMERIC(15,2),                       -- vira o saldo_inicial do mês seguinte
    meta          NUMERIC(15,2),                       -- meta do mês (ven_meta_vendedor); NULL = sem meta
    atingimento   NUMERIC(8,4),                        -- venda líquida do mês ÷ meta
    premio_pct    NUMERIC(6,4),
    premio_base   NUMERIC(15,2),
    premio        NUMERIC(15,2),                       -- premio_pct × premio_base (o RH lê nas comissões)
    piso          NUMERIC(8,4),                        -- piso da bolsa usado no fechamento
    fechado_em    TIMESTAMPTZ,
    fechado_por   TEXT,
    observacao    TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT uq_ven_bolsa_mes_rep_periodo UNIQUE (rep_codigo, ano, mes)
);

-- quem aplicou a versão sem as colunas do prêmio
ALTER TABLE ven_bolsa_mes ADD COLUMN IF NOT EXISTS meta        NUMERIC(15,2);
ALTER TABLE ven_bolsa_mes ADD COLUMN IF NOT EXISTS atingimento NUMERIC(8,4);
ALTER TABLE ven_bolsa_mes ADD COLUMN IF NOT EXISTS premio      NUMERIC(15,2);

CREATE INDEX IF NOT EXISTS idx_ven_bolsa_mes_periodo ON ven_bolsa_mes (ano, mes);
