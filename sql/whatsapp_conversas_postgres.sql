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

-- Números que NÃO são cliente (colega, transportadora, fornecedor): saem da
-- lista de vínculo para não voltarem todo dia. Vincular depois apaga a marca.
CREATE TABLE IF NOT EXISTS ven_wa_contato_ignorado (
  chave       TEXT PRIMARY KEY,                  -- mesma chave de ven_wa_contato (DDD + 8, ou dígitos do LID)
  telefone    TEXT NOT NULL,
  motivo      TEXT,
  criado_por  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Operação: devolver à fila os áudios que viraram ERRO (ou gastaram tentativas)
-- por problema do transcritor, não do arquivo — ex.: token errado, runner fora.
-- UPDATE ven_wa_mensagem
--    SET transcricao_status = 'PENDENTE', transcricao_tentativas = 0
--  WHERE transcricao_status IN ('PENDENTE', 'ERRO') AND transcricao IS NULL AND midia_chave IS NOT NULL;
