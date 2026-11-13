-- ============================================================================
-- Retorno de venda perdida ("produto chegou") — DDL PostgreSQL
--
-- ven_venda_perdida_retorno: quando o produto de uma venda perdida (Fechou do
-- orçamento ou pesquisa F7) volta a ter saldo, a carga diária gera aqui uma
-- sugestão de contato para o vendedor do cliente, com prazo, desfecho
-- (ABERTA | CONTATADA | NEGLIGENCIADA | CANCELADA) e a conversão em venda.
-- Fica FORA de ven_fila_tarefa de propósito: não entra em metas, prêmio do
-- supervisor nem escaladas da régua.
--
-- Sem FK para ven_venda_perdida (o Fechou apaga/reescreve a venda perdida);
-- por isso a data dela é copiada em venda_perdida_em.
--
-- Aplicar MANUALMENTE no Postgres da intranet (.144:5555 / intranet) ANTES do
-- deploy do vendas-service (não usar prisma migrate). Idempotente.
-- Sem permissão nova em sis_permissoes (não há rota nova).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ven_venda_perdida_retorno (
  id                TEXT PRIMARY KEY,
  venda_perdida_id  TEXT,                                -- id solto de ven_venda_perdida (sem FK)
  venda_perdida_em  TIMESTAMPTZ NOT NULL,                -- data da venda perdida que originou
  cli_codigo        INTEGER NOT NULL,
  cli_nome          TEXT,                                -- cópia p/ exibição
  pro_codigo        INTEGER NOT NULL,
  descricao         TEXT,
  quantidade_pedida NUMERIC(15,3) NOT NULL,
  saldo_na_geracao  NUMERIC(15,3) NOT NULL,
  rep_codigo        INTEGER NOT NULL,                    -- vendedor que recebe a sugestão
  rep_nome          TEXT,
  gerada_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  prazo_em          TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ABERTA',      -- ABERTA | CONTATADA | NEGLIGENCIADA | CANCELADA
  contato_em        TIMESTAMPTZ,
  contato_sinal     TEXT,                                -- VENDA | ORCAMENTO | MENSAGEM
  cancelada_em      TIMESTAMPTZ,
  encerrada_em      TIMESTAMPTZ,                         -- nulo = ainda acompanhado pela carga
  convertida_em     DATE,                                -- 1ª venda do par na janela de conversão
  convertida_qtd    NUMERIC(15,3),
  convertida_valor  NUMERIC(15,2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ven_vp_retorno_rep_encerrada
  ON ven_venda_perdida_retorno (rep_codigo, encerrada_em);
CREATE INDEX IF NOT EXISTS idx_ven_vp_retorno_cli_pro
  ON ven_venda_perdida_retorno (cli_codigo, pro_codigo);
CREATE INDEX IF NOT EXISTS idx_ven_vp_retorno_gerada
  ON ven_venda_perdida_retorno (gerada_em);

-- No máximo UM retorno aberto por cliente + produto: índice parcial —
-- o Prisma não expressa unique parcial, então a regra mora aqui e no código.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ven_vp_retorno_aberto
  ON ven_venda_perdida_retorno (cli_codigo, pro_codigo)
  WHERE encerrada_em IS NULL;

COMMIT;
