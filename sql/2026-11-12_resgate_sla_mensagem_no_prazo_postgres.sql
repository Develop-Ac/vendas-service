-- Esteira de resgate — acerto do prazo de 48h (curva A) dos episódios reprovados
-- em que o vendedor MANDOU mensagem dentro do prazo, mas ela só chegou ao sistema
-- depois de o prazo ter sido julgado (recarga do WhatsApp em 04/11/2026 cobrindo
-- 26/10–04/11; número vinculado ao cliente só em 06/11).
--
-- A regra não muda: 1º contato em até 48h da abertura. O código (resgate.service.ts,
-- 12/11/2026) passou a comparar a PRIMEIRA mensagem depois da abertura e a rever a
-- reprovação, mas só enquanto o episódio está aberto; este script acerta os que já
-- estavam julgados, inclusive os encerrados.
--
-- Alcance conferido em 12/11/2026 (leitura): 4 episódios do mês comissional
-- 26/10–25/11 — 33672, 27598 e 24084 (Fernando) e 43916 (Alisson).
-- "Resgates no prazo" vai de 4 para 8 de 11. Meses já fechados não entram.
-- Não depende do deploy. Rodar no Postgres da intranet com o usuário da aplicação.

BEGIN;

UPDATE ven_resgate r
   SET sla_cumprido = true,
       updated_at   = now()
 WHERE r.sla_em IS NOT NULL
   AND r.sla_cumprido = false
   AND r.aberto_em >= '2026-10-26T00:00:00-04:00'
   AND EXISTS (SELECT 1
                 FROM ven_wa_mensagem m
                WHERE m.cli_codigo = r.cli_codigo
                  AND m.direcao = 'ENVIADA'
                  AND m.timestamp > r.aberto_em
                  AND m.timestamp <= r.sla_em)
RETURNING r.cli_codigo, r.cli_nome, r.rep_nome, r.estagio, r.sla_em;
-- Esperado: 4 linhas (3 FERNANDO, 1 ALISSON). Se vier diferente, ROLLBACK e me avise.

COMMIT;
