-- Fila do CRM do atacado — acerto das tarefas "Cliente novo na sua carteira"
-- concluídas com atraso quando o vendedor JÁ tinha falado com o cliente antes
-- de a troca de carteira ser lançada.
--
-- Regra nova (fila.service.ts, 12/11/2026): para essa tarefa, mensagem enviada
-- pelo dono da tarefa até 3 dias antes da geração (dias de Cuiabá) conclui, com
-- a data da própria mensagem. O código só reconcilia tarefa em andamento; este
-- script aplica a mesma regra às que já tinham sido concluídas com data atrasada.
--
-- Alcance conferido em 12/11/2026 (leitura): 21 tarefas — 19 do Deyvid (357) e
-- 2 do Leandro (359). Não depende do deploy; pode rodar antes ou depois.
-- Rodar no Postgres da intranet (.144:5555 / intranet) com o usuário da aplicação.

BEGIN;

WITH alvo AS (
  SELECT t.id,
         (SELECT max(m.timestamp)
            FROM ven_wa_mensagem m
           WHERE m.direcao = 'ENVIADA'
             AND m.cli_codigo = t.cli_codigo
             AND m.rep_codigo = t.rep_codigo
             AND m.timestamp <= t.gerada_em
             AND m.timestamp >= (date_trunc('day', t.gerada_em AT TIME ZONE 'America/Cuiaba') - interval '3 days')
                                AT TIME ZONE 'America/Cuiaba') AS previo
    FROM ven_fila_tarefa t
   WHERE t.status = 'CONCLUIDA'
     AND t.motivo_geracao LIKE 'Cliente novo na sua carteira%'
     AND t.concluida_em > t.prazo_em
)
UPDATE ven_fila_tarefa t
   SET conclusao_obs   = 'Acerto 12/11/2026: contato prévio do vendedor. Antes: ' || t.conclusao_sinal || ' em '
                         || to_char(t.concluida_em AT TIME ZONE 'America/Cuiaba', 'DD/MM/YYYY HH24:MI'),
       concluida_em    = a.previo,
       conclusao_sinal = 'MENSAGEM',
       updated_at      = now()
  FROM alvo a
 WHERE a.id = t.id
   AND a.previo IS NOT NULL
RETURNING t.rep_nome, t.cli_codigo, t.cli_nome, t.concluida_em, t.conclusao_obs;
-- Esperado: 21 linhas (19 DEYVID, 2 LEANDRO). Se vier diferente, ROLLBACK e me avise.

COMMIT;
