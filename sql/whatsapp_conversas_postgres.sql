-- ============================================================================
-- Conversas do WhatsApp do atacado — conteúdo, mídia e áudio em texto
-- Aplicar MANUALMENTE (não usar prisma migrate). Idempotente.
--
-- Estende ven_wa_mensagem (antes só metadados). O corpo, a chave da mídia no
-- MinIO e a transcrição só são preenchidos para as sessões liberadas por
-- WA_CORPO_SESSOES no vendas-service; as demais seguem só com metadados.
-- Guarda por prazo indefinido (decisão da diretoria): nada expira aqui.
-- ============================================================================

ALTER TABLE ven_wa_mensagem
  ADD COLUMN IF NOT EXISTS corpo                  TEXT,          -- texto da mensagem ou legenda da mídia
  ADD COLUMN IF NOT EXISTS midia_chave            TEXT,          -- objeto no MinIO (bucket whatsapp-atacado): sessao/aaaa/mm/<id>.<ext>
  ADD COLUMN IF NOT EXISTS midia_mime             TEXT,
  ADD COLUMN IF NOT EXISTS transcricao            TEXT,          -- áudio em texto
  ADD COLUMN IF NOT EXISTS transcricao_status     TEXT,          -- PENDENTE | OK | ERRO (só áudio)
  ADD COLUMN IF NOT EXISTS transcricao_tentativas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(); -- marca d'água da cópia p/ o analytics

-- Fila da transcrição: o mais antigo pendente primeiro.
CREATE INDEX IF NOT EXISTS idx_ven_wa_msg_transcricao ON ven_wa_mensagem (transcricao_status, "timestamp");
-- Cópia incremental p/ o Mongo do analytics.
CREATE INDEX IF NOT EXISTS idx_ven_wa_msg_updated ON ven_wa_mensagem (updated_at);

-- Bucket no MinIO local (criar pelo console/mc): whatsapp-atacado
