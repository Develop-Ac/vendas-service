# WAHA local: WEBJS → NOWEB (roteiro de migração)

## Por quê

O container `automacao_waha-vendas` (EasyPanel local, .144) rodava 7 sessões
(`rep-*` + `assistente`) no engine WEBJS: cada sessão é um Chromium escondido.
Em 28/09/2026 ele estava em 1,5 GB de RAM e 10% de CPU em repouso, numa VM de
4 vCPU e 12 GB com 0 livre e swap cheio; foi **parado** depois das duas quedas
do dia. O NOWEB fala com o WhatsApp por WebSocket, sem navegador, e gasta uma
fração disso. É código aberto (TypeScript no repositório público do WAHA,
Apache 2.0, sobre um fork do Baileys) e vem na mesma imagem `devlikeapro/waha`.
O GOWS foi descartado: o binário é grátis, mas o fonte em Go é do tier pago.

Regras do WAHA que moldam o roteiro:

- O engine é **por container** (`WHATSAPP_DEFAULT_ENGINE`), não por sessão.
  Trocar = as 7 sessões trocam juntas.
- Sessão pareada no WEBJS **não** é reaproveitada no NOWEB: cada número escaneia
  o QR de novo.
- Chats, mensagens, contatos e a resolução de LID no NOWEB dependem do **store**
  ligado na criação da sessão (`config.noweb.store.enabled=true`). Não mude
  isso depois de parear, senão perde o histórico sincronizado.
- Aviso oficial: "API responses and webhook payloads may differ significantly,
  test your system before changing the engine". Daí o checklist do passo 6.

Ponto de partida: `waha-vendas` parado, captura do WhatsApp dos vendedores
desligada até o fim deste roteiro. Reserve uma sentada de ~1 h com os 6
aparelhos corporativos e o do assistente à mão.

## 1. vendas-service (branch `teste`)

O webhook lê campos que só o WEBJS preenche. Ajuste em
`src/whatsapp/whatsapp.service.ts`, nada fora dele:

| Campo usado hoje | WEBJS | NOWEB | Ajuste |
|---|---|---|---|
| `p.type` / `p._data.type` → coluna `tipo` | `chat`, `image`, `ptt`, `audio`, `document`… | não existe; `_data` é a mensagem crua do Baileys | derivar: sem mídia → `chat`; com mídia → prefixo do mimetype (`image`, `audio`, `application`…) |
| `p.body \|\| p._data.caption` → `corpo` | `body` vazio em mídia, legenda em `_data.caption` | legenda deve vir em `body` (confirmar no item 4 do checklist) | manter a ordem; se a legenda vier fora de `body`, ler `_data.message.*Message.caption` |
| `p._data.size` → corte de 20 MB antes de baixar | preenchido | ausente (NaN → corte não roda) | conferir `content-length` na resposta do download antes de ler o corpo |
| `p.media.url` / `p.media.mimetype` | ok | ok (exige `WHATSAPP_DOWNLOAD_MEDIA=true` + mimetypes, como hoje) | nenhum |
| `p.from` / `p.to` / `p.fromMe` / `p.timestamp` / `p.ack` / `p.id` | ok | ok | nenhum; confirmar que o `id` mantém o formato `fromMe_chat_id` (item 7) |
| `GET /api/{sessao}/lids/{lid}` | ok | ok com store ligado | nenhum |
| histórico: `GET /api/{s}/chats` e `/chats/{id}/messages?filter.timestamp.gte=` | limitado ao que o WhatsApp Web sincronizou | vem do store; `fullSync=true` pede ~1 ano ao aparelho | nenhum no código; `fullSync` na criação da sessão |

Os campos antigos seguem tendo precedência, então o mesmo código continua
correto no WEBJS (rollback sem reverter código).

Testes em `whatsapp.service.spec.ts`: payload no formato NOWEB (sem `type`,
sem `_data.size`, legenda em `body`) grava `tipo` derivado e baixa a mídia;
`content-length` acima de 20 MB não baixa. Sem banco, MinIO ou WAHA reais.

O runner do assistente (`assistente-whatsapp/runner/server.py`) só usa
`hasMedia`, `media`, `sendText`, `sendFile`, `startTyping` e `lids`: nada a
mudar, mas entra no checklist (item 8).

Deploy do vendas-service antes de religar o WAHA.

## 2. Guardar o que existe

Com o `waha-vendas` ainda parado, anote do EasyPanel: todas as variáveis do
serviço e o volume montado em `/app/.sessions`. Depois **inicie** o serviço só
para exportar as sessões e os webhooks por sessão (o assistente tem webhook
próprio para o n8n local):

```bash
curl -s -H "X-Api-Key: $WAHA_KEY" "http://waha.acacessorios.local/api/sessions?all=true" > sessoes-webjs.json
```

Se preferir não ligar o WEBJS nem por um minuto, o webhook do assistente está
descrito em `assistente-whatsapp/docs/passo-a-passo.md` §4 e os `rep-*` usam o
webhook global; o JSON é só conferência.

## 3. Trocar o engine

No `waha-vendas`, variáveis:

- `WHATSAPP_DEFAULT_ENGINE=NOWEB`
- as demais ficam como estão (`WHATSAPP_HOOK_URL`, `WHATSAPP_HOOK_EVENTS`,
  `WHATSAPP_DOWNLOAD_MEDIA`, `WHATSAPP_FILES_MIMETYPES`, chave de API, dashboard).
  **`WAHA_BASE_URL` continua o endereço da LAN** (`http://waha.acacessorios.local`):
  o runner do assistente na .146 baixa a mídia por ele e não resolve nome interno
  do EasyPanel; o vendas-service reescreve o host pelo `WA_API_URL` sozinho.

Recursos: limite de memória 2,5 GB agora; cai para 1 GB depois de medido
(passo 8). Redeploy e iniciar.

## 4. Apagar e recriar as sessões — `assistente` primeiro

Ordem: **`assistente` antes dos `rep-*`**. É a sessão que não envolve vendedor e
já exercita tudo que o NOWEB precisa provar (texto, áudio transcrito na .146,
PDF/imagem, LID, envio de texto e arquivo). Só chame os 6 aparelhos depois de
o assistente responder "oi" e um áudio.

Sessões com credenciais do WEBJS ficam `FAILED` no NOWEB; apague todas:

```bash
for s in rep-XXX rep-XXX rep-XXX rep-XXX rep-XXX rep-XXX assistente; do
  curl -s -X DELETE -H "X-Api-Key: $WAHA_KEY" "http://waha.acacessorios.local/api/sessions/$s"
done
```

Recrie cada `rep-*` já com store e webhook (o header do token só se
`WA_WEBHOOK_TOKEN` estiver definido no vendas-service):

```bash
curl -s -X POST -H "X-Api-Key: $WAHA_KEY" -H "Content-Type: application/json" \
  http://waha.acacessorios.local/api/sessions -d '{
    "name": "rep-316",
    "start": true,
    "config": {
      "noweb": { "store": { "enabled": true, "fullSync": true } },
      "webhooks": [{
        "url": "http://intranet_vendas-service:<porta>/whatsapp/webhook",
        "events": ["message.any", "message.ack"],
        "customHeaders": [{ "name": "x-webhook-token", "value": "<WA_WEBHOOK_TOKEN>" }]
      }]
    }
  }'
```

A `assistente` igual, com o webhook do n8n local no lugar do vendas-service
(o runner da .146, o n8n local e o `runner\.env` não mudam: `WAHA_URL`,
`WAHA_API_KEY` e `WAHA_SESSION=assistente` continuam válidos):

```bash
curl -s -X POST -H "X-Api-Key: $WAHA_KEY" -H "Content-Type: application/json"   http://waha.acacessorios.local/api/sessions -d '{
    "name": "assistente",
    "start": true,
    "config": {
      "noweb": { "store": { "enabled": true, "fullSync": false } },
      "webhooks": [{
        "url": "http://automacao_n8n_webhook:5678/webhook/assistente-whatsapp",
        "events": ["message"]
      }]
    }
  }'
```

QR com o celular do número da empresa (Aparelhos vinculados → vincular). Depois
`GET /api/sessions/assistente` = `WORKING` com o webhook listado, e o teste do
passo-a-passo §5.4: "oi" do seu celular, execução no n8n com 202 do runner,
resposta em 10 a 40 s. Mande também um áudio e um PDF antes de seguir.

## 5. Parear os 7 números

Dashboard do WAHA → sessão → QR, ou `GET /api/{sessao}/auth/qr` com
`Accept: image/png`. Um aparelho por vez; conferir `status: WORKING` em
`GET /api/sessions` antes do próximo.

## 6. Checklist de validação (um vendedor, um cliente conhecido)

O item 8 (assistente) já foi provado no passo 4; os demais:

Cada item se confere na tabela de mensagens do vendas-service
(`GET /whatsapp/medicoes` e a linha gravada):

1. Texto recebido: linha `RECEBIDA`, `corpo` preenchido, `tipo=chat`.
2. Texto enviado pelo celular: linha `ENVIADA`, `ack` sobe com `message.ack`.
3. Áudio recebido: `midia_chave` no MinIO, `midia_mime=audio/ogg`,
   `transcricao_status=PENDENTE` e `OK` no cron seguinte.
4. Imagem com legenda: `corpo` = legenda, `tipo=image`, mídia no MinIO.
5. PDF: mídia no MinIO, `tipo=application`.
6. Contato que chega como `@lid`: `chat_telefone` com o número real, não os
   dígitos do LID.
7. `message_id` no mesmo formato das linhas antigas (`true_55..@c.us_XXXX`).
   Se mudar, o `existe()` deixa de deduplicar entre engines e a reimportação
   do histórico precisa de corte por data em vez de repetição segura.
8. Assistente: mandar uma pergunta ao número do assistente e receber resposta.
9. Vídeo/sticker: mensagem gravada, sem mídia (regra atual).
10. `POST /whatsapp/historico {sessao, desde: "2026-09-01"}`: comparar `lidas`
    com a rodada feita no WEBJS. Com `fullSync` tende a vir mais.

## 7. Histórico

Rodar o passo 10 para as 6 sessões `rep-*`. Repetir não duplica se o item 7
passou; senão, rodar uma vez só por sessão.

## 8. Medida

Dia seguinte: `docker stats --no-stream | grep waha` e comparar com 1,5 GB.
Se ficar abaixo de 700 MB, baixar o teto para 1 GB. Registrar no
`whatsapp-piloto.md` (seção do WAHA) e na KB.

## Rollback

`WHATSAPP_DEFAULT_ENGINE=WEBJS`, redeploy, apagar e recriar as sessões, 7 QR
de novo. O código do passo 1 não precisa ser revertido. Custo do erro: 30
minutos de QR, nenhum dado perdido (o que já entrou está no Postgres e no
MinIO).

## Armadilhas conhecidas

- Trocar o engine **sem** apagar as sessões deixa todas `FAILED`.
- `config.noweb.store` só vale na criação; mudar depois perde o histórico.
- `WAHA_BASE_URL` tem de ser o endereço da LAN, não o nome interno do EasyPanel:
  o runner da .146 usa a URL de mídia como vem no payload. Sem a variável ela
  vem com `localhost:3000` e nem a .146 nem a reescrita do vendas-service
  salvam o runner.
- O WAHA da nuvem (Hostinger, conferência fiscal) não entra nesta migração.
