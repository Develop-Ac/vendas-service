-- Bolsa do orçamento congelada no fechamento (02/10/2026). No desfecho FECHADO o serviço grava o
-- piso da bolsa em vigor naquele dia e o resultado do orçamento contra ele (R$ = receita − custo ×
-- piso + metade da promoção absorvida + ajuste da bolsa negativa; item sem custo é neutro). A lista
-- e o orçamento mostram esse valor ao lado da bolsa gerada nas NFs casadas. Orçamentos fechados
-- antes desta coluna ficam nulos: o serviço calcula na leitura com o piso de hoje (bolsa_aprox).
-- Sem backfill. Idempotente: pode rodar de novo.

ALTER TABLE ven_orcamento ADD COLUMN IF NOT EXISTS piso_bolsa numeric(8,4);
ALTER TABLE ven_orcamento ADD COLUMN IF NOT EXISTS bolsa_orcamento numeric(14,2);
