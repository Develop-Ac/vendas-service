# Sensor WhatsApp — piloto WAHA (CRM do Atacado)

O sensor registra metadados de toda sessão (quem falou com que cliente, quando,
em que direção). A mensagem enviada vira o terceiro sinal de auto-conclusão da
fila do dia, ao lado do orçamento e da venda.

Para as sessões liberadas em `WA_CORPO_SESSOES` ele guarda também o **conteúdo**:
texto, mídia no MinIO e áudio transcrito (seção 6). Spec:
`docs/whatsapp-conversas-spec.md`.

**Pré-requisito inegociável: o comunicado formal à equipe (D4) sai ANTES do
primeiro webhook; o conteúdo só é ligado com o termo de ciência assinado.**

## 1. Aplicar o DDL

`sql/crm_fase1_whatsapp_postgres.sql` no Postgres da intranet (manual, idempotente).
Para o conteúdo: `sql/whatsapp_conversas_postgres.sql` (colunas novas, idempotente).

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
  - `WHATSAPP_DOWNLOAD_MEDIA=true` e `WHATSAPP_FILES_MIMETYPES=audio,image,application/pdf,application/msword,application/vnd`
    (sem isso o payload chega sem `media.url` e nada de mídia é guardado)
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

**LIDs (obrigatório para o casamento funcionar):** o WhatsApp esconde o número
de boa parte dos contatos atrás de um Linked ID (`...@lid`) — no primeiro teste
do piloto, 100% das mensagens chegaram assim e o casamento deu zero. O
vendas-service resolve o número real pelo endpoint `/api/{sessao}/lids/{lid}`
do WAHA; para isso, defina no **vendas-service**:

- `WA_API_URL=http://<projeto>_waha:3000` (o mesmo endereço interno do WAHA)
- `WA_API_KEY=<a API key do WAHA, se configurada>`
- `WA_SESSOES_IGNORADAS=assistente` (opcional; sessões do mesmo WAHA que não são de
  vendedor e ficam fora do sensor — padrão já é `assistente`)

Sem `WA_API_URL`, mensagens de contatos com LID caem inteiras na fila de
vínculo manual (nada se perde, mas nada casa sozinho).

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

## 6. Conteúdo das conversas (corpo, mídia, áudio em texto)

Só para as sessões em `WA_CORPO_SESSOES` (vírgula; vazia = ninguém). As demais
seguem só com metadados. Guarda por prazo indefinido: não há expurgo.

**O que é guardado por mensagem:** `corpo` (texto ou legenda), `midia_chave` +
`midia_mime` (objeto no MinIO, bucket `S3_BUCKET_WHATSAPP`, padrão
`whatsapp-atacado`, chave `rep-<cod>/<aaaa>/<mm>/<message_id>.<ext>`),
`transcricao` + `transcricao_status` (PENDENTE → OK | ERRO, só áudio).
Mídia aceita: imagem, áudio, PDF e documentos Office até 20 MB. Vídeo, sticker
e contato ficam de fora. Falha ao baixar a mídia não impede gravar a mensagem.

**Transcrição:** cron por minuto no vendas-service, um áudio por vez, nos dois
sentidos. Manda o arquivo por multipart a `WA_TRANSCRICAO_URL` (o
`POST /transcrever` do runner do assistente na .146, Bearer
`WA_TRANSCRICAO_TOKEN` = `IA_RUNNER_TOKEN`) e grava `{ texto }`. Resposta 4xx
conta tentativa (3 = ERRO, áudio fica no MinIO); rede ou 5xx encerra o tick sem
contar — a fila espera o transcritor voltar. `WA_TRANSCRICAO_SO_RECEBIDAS=1`
prioriza só o áudio do cliente se a CPU apertar. Disparo manual:
`POST /whatsapp/transcricao/processar`.

**Histórico desde 01/09/2026** (data do termo de ciência), uma vez por sessão,
depois de conectá-la:

```bash
curl -X POST http://vendas-service.acacessorios.local/whatsapp/historico -H 'Content-Type: application/json' -d '{"sessao":"rep-163"}'
```

Roda em segundo plano (`GET /whatsapp/historico` mostra chats, lidas, gravadas,
mídias, erro). Repetir é seguro: a chave única `(sessao, message_id)` ignora o
que já entrou. Limite do engine WEBJS: só devolve o que o WhatsApp Web
sincronizou do aparelho — conferir `lidas` contra o celular na primeira rodada.
As mensagens importadas contam como contato na fila e no resgate.

**Acompanhar:** `GET /whatsapp/medicoes` → bloco `conteudo` com sessões
liberadas, mensagens com corpo, com mídia e áudios por status.

**Checklist para ligar:** DDL aplicado → bucket criado no MinIO → WAHA com
download de mídia → `WA_CORPO_SESSOES` + `S3_*` + `WA_TRANSCRICAO_*` no
vendas-service → deploy → histórico por sessão.
