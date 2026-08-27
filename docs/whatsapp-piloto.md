# Sensor WhatsApp — piloto WAHA (CRM do Atacado, fase 1)

O sensor registra **só metadados** (quem falou com que cliente, quando, em que
direção) — nunca o conteúdo. A mensagem enviada vira o terceiro sinal de
auto-conclusão da fila do dia, ao lado do orçamento e da venda.

**Pré-requisito inegociável: o comunicado formal à equipe (D4) sai ANTES do
primeiro webhook.**

## 1. Aplicar o DDL

`sql/crm_fase1_whatsapp_postgres.sql` no Postgres da intranet (manual, idempotente).

## 2. Subir o WAHA no EasyPanel LOCAL

Desde a versão **2026.6.1** tudo que era do Plus está no Core gratuito — imagem
única, sessões ilimitadas:

- **Imagem:** `devlikeapro/waha` (latest — a imagem atual também elimina o bug
  antigo "envia mas não lê" do engine WEBJS).
- **Volume persistente** montado em `/app/.sessions` (perder o volume = escanear
  todos os QR de novo).
- **Env do webhook global** (vale para todas as sessões):
  - `WHATSAPP_HOOK_URL=http://intranet_vendas-service:<porta>/whatsapp/webhook`
    (DNS interno do EasyPanel: `<projeto>_<serviço>`)
  - `WHATSAPP_HOOK_EVENTS=message.any,message.ack`
- Proteja o dashboard e a API com as credenciais/API key do próprio WAHA.

O WAHA da nuvem (Hostinger) segue intocado na conferência fiscal.

## 3. Parear as sessões (1–2 números no piloto)

Criar uma sessão por número corporativo com o nome na convenção
**`rep-<codigo>`** (ex.: `rep-316`) — é do nome da sessão que o vendas-service
extrai o vendedor; sessão fora do padrão registra sem vendedor. Escanear o QR
com o aparelho corporativo (multi-dispositivo: o celular continua funcionando).

Opcional, recomendado antes de generalizar: definir `WA_WEBHOOK_TOKEN` no
vendas-service e configurar o webhook (por sessão, no dashboard) com o header
`x-webhook-token` de mesmo valor. Sem a variável o endpoint aceita qualquer
chamada da rede interna.

## 4. Semear o vínculo telefone → cliente

```bash
curl -X POST http://vendas-service.acacessorios.local/whatsapp/contatos/seed
```

Lê FONE e CELULAR do cadastro do atacado no ERP (celular vence o fixo) e grava
as chaves DDD+8 em `ven_wa_contato`. Idempotente; vínculo manual nunca é
sobrescrito pela semente.

## 5. Acompanhar o piloto

- `GET /whatsapp/medicoes` — total de mensagens, **taxa de casamento**,
  contatos vinculados, chaves pendentes e atividade por sessão (as métricas que
  o piloto valida, junto com a ressincronização pós-queda e a estabilidade da
  sessão).
- `GET /whatsapp/contatos/pendentes` — números que conversaram e ainda não têm
  cliente; `POST /whatsapp/contatos/vincular {telefone, cli_codigo}` resolve e
  conserta o histórico daquele número de uma vez.

Com o sensor no ar, a fila do dia passa a concluir tarefa também por
`MENSAGEM` (enviada depois da geração) e a régua conta a mensagem como contato
— nada a configurar no vendas-service além do deploy.
