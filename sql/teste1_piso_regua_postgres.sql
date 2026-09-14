-- =============================================================================
-- Teste 1 (3 meses) — tabela mínima custo × 1,538 nas linhas caras
-- Postgres da intranet · aplicar MANUALMENTE junto com a carga dos preços no ERP
-- (planilha "Teste 1 - Piso 1,538 nas linhas caras (carga).xlsx").
--
-- Regra: nas linhas em que o multiplicador da régua era menor que o piso da
-- bolsa (1,538), o multiplicador de lista passa a ser 1,538 e o desconto máximo
-- da faixa sobe até o valor que devolve o MESMO preço mínimo de antes
-- (ex.: PB 3A: 1,42 × 0,92 = 1,306 ≈ 1,538 × 0,85 = 1,307). Ou seja, o piso da
-- régua não muda; muda o ponto de partida (tabela) e quem decide (vendedor,
-- pela bolsa). As demais linhas ficam como estão (mix 1 continua 3% até a
-- carga dos preços dos itens baratos).
--
-- Alçada (código, sem parâmetro): com bolsa (saldo do mês, já com o orçamento,
-- ≥ 0) vale o máximo inteiro da faixa; sem bolsa vale a escala por quantidade
-- de ven_regua_volume (50% / 75% / 100%).
-- =============================================================================

BEGIN;

UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.10 WHERE classe = 'GERAL' AND faixa = '3A';  -- era 1,51 / 8%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.12 WHERE classe = 'GERAL' AND faixa = '3B';  -- era 1,47 / 8%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.15 WHERE classe = 'GERAL' AND faixa = '3C';  -- era 1,44 / 9%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.17 WHERE classe = 'GERAL' AND faixa = '3D';  -- era 1,42 / 10%

UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.08 WHERE classe = 'PB' AND faixa = '2B';     -- era 1,50 / 6%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.13 WHERE classe = 'PB' AND faixa = '2C';     -- era 1,44 / 7%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.15 WHERE classe = 'PB' AND faixa = '3A';     -- era 1,42 / 8%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.16 WHERE classe = 'PB' AND faixa = '3B';     -- era 1,41 / 8%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.18 WHERE classe = 'PB' AND faixa = '3C';     -- era 1,39 / 9%
UPDATE ven_regua_atacado SET markup = 1.538, desc_max = 0.19 WHERE classe = 'PB' AND faixa = '3D';     -- era 1,38 / 10%

COMMIT;

-- Conferência
SELECT classe, faixa, markup, desc_max, ROUND(markup * (1 - desc_max), 3) AS piso_regua
FROM ven_regua_atacado ORDER BY classe, faixa;

-- Reverter (fim do teste sem aprovação): valores da régua anterior
-- UPDATE ven_regua_atacado SET markup = 1.510, desc_max = 0.08 WHERE classe='GERAL' AND faixa='3A';
-- UPDATE ven_regua_atacado SET markup = 1.470, desc_max = 0.08 WHERE classe='GERAL' AND faixa='3B';
-- UPDATE ven_regua_atacado SET markup = 1.440, desc_max = 0.09 WHERE classe='GERAL' AND faixa='3C';
-- UPDATE ven_regua_atacado SET markup = 1.420, desc_max = 0.10 WHERE classe='GERAL' AND faixa='3D';
-- UPDATE ven_regua_atacado SET markup = 1.500, desc_max = 0.06 WHERE classe='PB' AND faixa='2B';
-- UPDATE ven_regua_atacado SET markup = 1.440, desc_max = 0.07 WHERE classe='PB' AND faixa='2C';
-- UPDATE ven_regua_atacado SET markup = 1.420, desc_max = 0.08 WHERE classe='PB' AND faixa='3A';
-- UPDATE ven_regua_atacado SET markup = 1.410, desc_max = 0.08 WHERE classe='PB' AND faixa='3B';
-- UPDATE ven_regua_atacado SET markup = 1.390, desc_max = 0.09 WHERE classe='PB' AND faixa='3C';
-- UPDATE ven_regua_atacado SET markup = 1.380, desc_max = 0.10 WHERE classe='PB' AND faixa='3D';
