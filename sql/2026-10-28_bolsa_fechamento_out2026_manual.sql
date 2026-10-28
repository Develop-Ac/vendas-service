-- ============================================================================
-- Fechamento MANUAL da bolsa do atacado de out/2026 (mês comissional 26/09–25/10)
-- em ven_bolsa_mes. Aplicar no Postgres da intranet (banco `intranet`).
--
-- Out/26 foi o 1º mês da bolsa e fechou na REGRA ANTIGA: prêmio = 25% da bolsa
-- do mês, sem meta, sem reserva e sem saldo carregado. O fechamento automático do
-- vendas-service (ORCAMENTO_BOLSA_FECHAMENTO_DESDE=2026-11) só começa em nov/26 e
-- aplicaria a regra nova (5/15/25% pela meta, 30% retido); por isso out/26 entra
-- por este SQL, só para o RH ler em /pessoal/comissoes (GET /orcamento/bolsa/fechamento).
--
-- `gerado` = card_saldo do extrato da bolsa (GET /orcamento/vendedor/:rep/bolsa/extrato
-- ?ano=2026&mes=10) lido em 28/10/2026, piso 1,538: saldo das linhas + promoção
-- absorvida + ajuste da bolsa negativa (Alisson R$ 262,07), sem excedente (teto só
-- vige a partir de 28/10). Canal dos 3 vendedores premiados: R$ 14.809,75 (Deyvid, Caio e Leandro ficam de fora).
-- meta/atingimento ficam gravados só para informação (ven_meta_vendedor de out/26);
-- a taxa de 25% NÃO depende deles. reserva = 0 → nov/26 começa com saldo inicial 0
-- (o fechamento de nov/26 cria a própria linha; nada de nov é gravado aqui).
--
-- Idempotente: pode rodar de novo (regrava as 3 linhas de out/26).
-- ============================================================================

INSERT INTO ven_bolsa_mes
    (id, rep_codigo, ano, mes, saldo_inicial, gerado, saldo_final, reserva,
     meta, atingimento, premio_pct, premio_base, premio, piso,
     fechado_em, fechado_por, observacao, created_at, updated_at)
SELECT
    'manual-out2026-' || v.rep_codigo,
    v.rep_codigo, 2026, 10,
    0,                                             -- saldo_inicial: 1º mês da bolsa
    v.gerado,
    v.gerado,                                      -- saldo_final = 0 + gerado
    0,                                             -- reserva: regra antiga não retinha
    v.meta,
    CASE WHEN v.meta > 0 THEN ROUND(v.venda_liquida / v.meta, 4) END,
    0.25,
    GREATEST(v.gerado, 0),                         -- premio_base: só saldo positivo premia
    ROUND(GREATEST(v.gerado, 0) * 0.25, 2),        -- premio
    1.538,
    now(),
    'manual (SQL 2026-10-28)',
    'Fechamento manual de out/2026 na regra antiga: prêmio = 25% da bolsa do mês, sem reserva. Regra por meta vale a partir de nov/2026.',
    now(), now()
FROM (VALUES
    -- rep,  gerado (card_saldo), venda_liquida, meta out/26
    (163,   8995.99,  276296.27, 220000.00),       -- ALISSON
    (349,   3662.02,   97347.97,  80000.00),       -- CRISTIANO
    (200,   2151.74,   35482.58, 140000.00)        -- FERNANDO (férias em out)

) AS v (rep_codigo, gerado, venda_liquida, meta)
ON CONFLICT ON CONSTRAINT uq_ven_bolsa_mes_rep_periodo DO UPDATE SET
    saldo_inicial = EXCLUDED.saldo_inicial,
    gerado        = EXCLUDED.gerado,
    saldo_final   = EXCLUDED.saldo_final,
    reserva       = EXCLUDED.reserva,
    meta          = EXCLUDED.meta,
    atingimento   = EXCLUDED.atingimento,
    premio_pct    = EXCLUDED.premio_pct,
    premio_base   = EXCLUDED.premio_base,
    premio        = EXCLUDED.premio,
    piso          = EXCLUDED.piso,
    fechado_em    = EXCLUDED.fechado_em,
    fechado_por   = EXCLUDED.fechado_por,
    observacao    = EXCLUDED.observacao,
    updated_at    = now();

-- Conferência: 3 linhas; prêmio esperado 2.249,00 + 915,51 + 537,94 = 3.702,45
SELECT rep_codigo, gerado, atingimento, premio_pct, premio, fechado_em
  FROM ven_bolsa_mes
 WHERE ano = 2026 AND mes = 10
 ORDER BY premio DESC;

-- Desfazer (se precisar):
-- DELETE FROM ven_bolsa_mes WHERE ano = 2026 AND mes = 10 AND fechado_por = 'manual (SQL 2026-10-28)';
