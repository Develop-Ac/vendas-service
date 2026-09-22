-- Régua do atacado — mix 1 (faixas 1A–1D) com desconto máximo de 5%
-- Ajuste combinado na proposta da diretoria de 09/09/2026 ("tabela neutra + autonomia de
-- desconto"): o markup de lista sobe ~2,1% para que 5% de desconto chegue ao mesmo preço
-- mínimo que 3% dava sobre a lista antiga. As faixas 2A–3D não mudam (as caras já estão no
-- piso 1,538 com os limites maiores).
--
-- ATENÇÃO: isto muda o LIMITE de desconto da tela de orçamento e o preço-alvo da régua.
-- O preço de TABELA dos itens (PRECO2 no ERP) não muda por aqui — enquanto a carga de preços
-- do mix 1 não for feita, o vendedor tem 5% sobre a tabela de hoje.
--
-- Rodar uma vez; o serviço lê a tabela a cada avaliação (sem cache), não precisa reiniciar.

BEGIN;

UPDATE ven_regua_atacado SET markup = 2.910, desc_max = 0.05, updated_at = now() WHERE classe = 'GERAL' AND faixa = '1A';
UPDATE ven_regua_atacado SET markup = 2.350, desc_max = 0.05, updated_at = now() WHERE classe = 'GERAL' AND faixa = '1B';
UPDATE ven_regua_atacado SET markup = 1.990, desc_max = 0.05, updated_at = now() WHERE classe = 'GERAL' AND faixa = '1C';
UPDATE ven_regua_atacado SET markup = 1.890, desc_max = 0.05, updated_at = now() WHERE classe = 'GERAL' AND faixa = '1D';
UPDATE ven_regua_atacado SET markup = 2.350, desc_max = 0.05, updated_at = now() WHERE classe = 'PB' AND faixa = '1A';
UPDATE ven_regua_atacado SET markup = 2.140, desc_max = 0.05, updated_at = now() WHERE classe = 'PB' AND faixa = '1B';
UPDATE ven_regua_atacado SET markup = 1.940, desc_max = 0.05, updated_at = now() WHERE classe = 'PB' AND faixa = '1C';
UPDATE ven_regua_atacado SET markup = 1.790, desc_max = 0.05, updated_at = now() WHERE classe = 'PB' AND faixa = '1D';

COMMIT;

-- Conferência: 8 linhas com desc_max 0.0500 e os markups acima.
SELECT classe, faixa, markup, desc_max, updated_at
  FROM ven_regua_atacado
 WHERE faixa IN ('1A', '1B', '1C', '1D')
 ORDER BY classe, faixa;
