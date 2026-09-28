# Spec — Conversas do WhatsApp dos vendedores do atacado (captura, mídia e áudio em texto)

Cartão: Analytics Atacado: Mensagens do WhatsApp dos vendedores e transcrição de áudios (20).
Fechada em 26/09/2026 a partir das decisões da entrevista. Entrega desta spec = captar e guardar. Sinais e uso vêm depois.

## Problem Statement

O sensor de WhatsApp do CRM do Atacado registra só o fato do contato (quem, com quem, quando, direção, tipo). O conteúdo da conversa se perde: o que o cliente pediu, o que reclamou, o que o vendedor prometeu, o áudio que ninguém vai reouvir. Sem isso a gestão não consegue medir o trabalho do atacado além de orçamento e nota, e a base do CRM próprio (métodos de força de vendas, não a ferramenta Salesforce) nasce sem a matéria-prima principal: a conversa.

Os números são corporativos, de uso exclusivo em venda, o comunicado à equipe já foi feito, cada vendedor assina termo de ciência, e a diretoria definiu guarda por prazo indefinido. O que falta é o software guardar.

## Solution

O serviço de WhatsApp que já guarda contatos e metadados passa a guardar também o corpo das mensagens, a mídia (imagem, áudio, documento) e a transcrição dos áudios, nos dois sentidos, ligados a cliente e vendedor, para as sessões que a gestão liberar. O histórico das sessões desde 01/09/2026 é importado uma vez por sessão. O analytics do atacado copia as conversas para o Mongo em forma analítica, um documento por cliente, vendedor e mês. Nesta fase ninguém lê em tela: grava-se e mede-se.

## User Stories

1. Como supervisor do atacado, quero que o texto das mensagens trocadas entre vendedor e cliente fique guardado, para saber o que foi pedido e prometido sem depender da memória de ninguém.
2. Como supervisor, quero que os áudios recebidos dos clientes virem texto automaticamente, para não ter que ouvir áudio para saber o que o cliente pediu.
3. Como supervisor, quero que os áudios enviados pelos vendedores também virem texto, para enxergar o comportamento do vendedor (prazo prometido, desconto dado, resposta por áudio em vez de orçamento).
4. Como supervisor, quero que fotos e documentos enviados na conversa fiquem guardados, porque a foto do vidro ou do chassi é o pedido em si.
5. Como supervisor, quero cada mensagem ligada ao cliente do ERP e ao vendedor da sessão, para consultar a conversa por cliente e por vendedor.
6. Como supervisor, quero que a captura de conteúdo seja ligada e desligada por vendedor, para atender saída de vendedor ou pedido da diretoria sem mexer nos outros.
7. Como diretor, quero que sessões fora da lista liberada continuem só com metadados, como hoje, para que ligar o conteúdo seja um ato deliberado.
8. Como diretor, quero que as conversas de 01/09/2026 em diante também sejam guardadas, porque o termo de ciência cobre esse período.
9. Como diretor, quero que nada seja apagado por prazo, porque a guarda foi definida como indefinida.
10. Como diretor, quero que grupos, listas de transmissão e a sessão do assistente fiquem fora, para guardar só conversa de venda.
11. Como diretor, quero que nesta fase nenhuma tela mostre o texto das conversas, para que a leitura fique restrita a quem tem acesso ao banco até existir controle de acesso próprio.
12. Como gestor do sistema, quero disparar a importação do histórico por sessão e por data depois de conectar cada número, e poder repetir sem duplicar.
13. Como gestor do sistema, quero ver nas medições quantas mensagens têm corpo e quantos áudios estão pendentes, transcritos ou com erro, para saber se a captura e o transcritor estão funcionando.
14. Como gestor do sistema, quero que a falha do transcritor não perca mensagem: o áudio fica guardado e a transcrição tenta de novo.
15. Como gestor do sistema, quero que o webhook responda rápido mesmo com áudio, para o WAHA não desistir do envio.
16. Como gestor do sistema, quero que a mídia fique no MinIO local com chave previsível por vendedor, ano, mês e mensagem, para achar o arquivo sem consultar nada.
17. Como gestor do sistema, quero que a transcrição rode na máquina que já roda o assistente, sem serviço pago e sem segunda cópia do modelo.
18. Como analista, quero as conversas copiadas para o Mongo do analytics, um documento por cliente, vendedor e mês, para calcular sinais (tempo de resposta, sem retorno, produtos citados) sobre a lista sem join.
19. Como analista, quero que a cópia seja incremental e idempotente, para que transcrição e vínculo de cliente que chegam depois atualizem o documento certo.
20. Como analista, quero que mensagem sem cliente vinculado entre no pacote assim que o vínculo manual acontecer, sem reprocessar tudo.
21. Como vendedor, quero que a mensagem antiga importada conte como contato na fila e no resgate, porque o contato aconteceu.
22. Como vendedor, não quero nenhuma ação nova: tudo é observado, nada é digitado.
23. Como futuro módulo de sugestão de orçamento, quero texto, transcrição, mídia, cliente, vendedor e hora guardados juntos, para montar o pedido a partir da conversa.
24. Como desenvolvedor, quero a captura testável sem banco, MinIO, WAHA ou transcritor, para rodar os testes em qualquer máquina.

## Implementation Decisions

**Onde vive o conteúdo.** Postgres da intranet, no serviço de vendas, na tabela de mensagens do sensor que já existe. Fonte quente e permanente. O desenho anterior da spec do analytics (evento bruto repassado ao analytics, corpo em Mongo, transcritor em contêiner novo) fica substituído por este e a seção correspondente da spec do analytics é reescrita.

**Colunas novas na tabela de mensagens**: corpo (texto ou legenda da mídia), chave da mídia no MinIO, mimetype da mídia, transcrição, status da transcrição (PENDENTE, OK, ERRO), contagem de tentativas, data de atualização. SQL manual entregue no repositório, nunca migration automática, conforme regra da casa. A chave única sessão + id da mensagem continua sendo a proteção contra duplicidade.

**Quem captura conteúdo.** Env com a lista de sessões liberadas (vazia = ninguém). Vale para webhook, importação de histórico e mídia. Sessão fora da lista segue só metadados. A lista de sessões ignoradas (assistente) e os chats ignorados (grupo, transmissão, canal) continuam como estão.

**Webhook.** Continua tratando os mesmos eventos de mensagem e ack. Para sessão liberada: grava o corpo; se há mídia dos tipos aceitos (imagem, áudio, PDF, documentos Office) até 20 MB, baixa do WAHA pela URL do payload (com a chave de API e com a troca do host interno pelo endereço configurado, como o serviço de recebimento já faz), guarda no MinIO no bucket próprio de WhatsApp do atacado com chave sessão/ano/mês/id.extensão, e grava chave e mimetype. Áudio entra com status PENDENTE. Vídeo, sticker e contato não são baixados. Falha ao baixar mídia não impede gravar a mensagem. O webhook não transcreve.

**Transcrição.** Rotina agendada no próprio serviço de vendas, a cada minuto, um áudio por vez: lê o mais antigo pendente, baixa do MinIO, envia por multipart ao endpoint de transcrição do runner do assistente na máquina .146 (Bearer com o token do runner que já existe; URL por env), grava o texto e status OK. Erro incrementa tentativas; na terceira falha o status vira ERRO e o áudio permanece no MinIO para nova tentativa manual ou futura. Sem limite de duração. Os dois sentidos (recebido e enviado) são transcritos; se a CPU apertar, uma env prioriza o recebido.

**Endpoint de transcrição no runner.** Rota nova no runner do assistente que recebe o arquivo por multipart e devolve o texto, reaproveitando a função de transcrição já escrita (faster-whisper em CPU, português, modelo carregado uma vez). Entra por último, depois que a sessão que está editando o runner encerrar. Na .146 falta instalar a biblioteca no venv do runner. Nenhum serviço avulso na porta 9000.

**Importação do histórico.** Rota manual no serviço de vendas com sessão e data inicial. Percorre os chats individuais da sessão no WAHA, busca mensagens com filtro de timestamp maior ou igual à data e mídia habilitada, e passa cada mensagem pelo mesmo caminho do webhook (mesma resolução de LID, mesma chave de telefone, mesma gravação de corpo e mídia). Duplicadas são ignoradas pela chave única, então repetir é seguro. Só sessões liberadas. Data padrão 01/09/2026. Limitação conhecida do engine WEBJS: só devolve o que o WhatsApp Web sincronizou do aparelho; o resultado é medido na primeira rodada. Mensagens importadas viram sinal de contato na fila e no resgate; tarefa gerada antes da mensagem pode fechar sozinha, e isso é correto.

**Medições.** A rota de medições do sensor passa a devolver, por sessão, mensagens com corpo, com mídia, e áudios por status.

**Cópia para o Mongo (analytics).** Etapa nova no job noturno do analytics: lê as mensagens do Postgres alteradas desde a última execução (pela data de atualização), agrupa por cliente, vendedor e mês, e faz upsert na coleção de conversas: um documento por chave com a lista de mensagens (id, direção, hora, tipo, corpo, transcrição, status, chave da mídia, mimetype), substituindo a mensagem de mesmo id quando ela chega de novo. Mensagem sem cliente não entra; entra quando o vínculo preencher o cliente e a data de atualização mudar. Cópia, não mudança: o Postgres guarda tudo. Marca d'água da última cópia no estado do job.

**Configuração do WAHA (pelo usuário).** Sessões por vendedor na convenção já usada, download de mídia ligado, áudio na lista de mimetypes de arquivo, webhook apontando para o serviço de vendas com os eventos de mensagem e ack.

**Documentação.** Spec do analytics atualizada; guia do piloto de WhatsApp atualizado com as envs novas, o bucket e o passo da importação.

## Testing Decisions

Um bom teste entra pela porta do serviço e olha o que ele mandou gravar, nunca como gravou. Nada de banco, MinIO, WAHA ou transcritor de verdade.

- **Serviço de WhatsApp (vendas)**: mesma costura do teste que já existe, que instancia o serviço com repositório e ERP falsos. Entram também MinIO falso, cliente WAHA falso e transcritor falso. Casos: sessão liberada grava corpo e mídia; sessão não liberada grava só metadados; áudio entra PENDENTE; mídia de tipo não aceito ou acima do limite não é baixada e a mensagem grava mesmo assim; falha no download não bloqueia a mensagem; o processador de pendentes grava transcrição e status OK, e na terceira falha marca ERRO; a importação do histórico percorre chats, filtra pela data, ignora grupos e duplicadas; medições contam por status.
- **Analytics**: função pura de empacotar (linhas do Postgres mais documentos existentes produzem documentos novos), testada no estilo do teste de eventos, sem Mongo. Casos: agrupamento por cliente, vendedor e mês; substituição de mensagem de mesmo id; mensagem sem cliente fica fora; marca d'água avança.
- **Runner**: um teste com cliente de teste do FastAPI e a função de transcrição substituída por uma falsa: multipart com Bearer devolve o texto; sem Bearer devolve 401.

Prior art: o spec do serviço de WhatsApp no vendas-service e os testes em Python do analytics (eventos, perfis, empacotamento).

## Out of Scope

- Sinais da conversa (tempo de resposta, conversa sem retorno, produtos citados, pedido de preço sem orçamento) e a entrada desses sinais no perfil do cliente e do vendedor.
- Conversa parada virando tarefa na fila.
- Tela de leitura das conversas e controle de acesso ao texto.
- Expurgo por prazo.
- Sugestão de orçamento a partir do pedido na conversa.
- Ligar e desligar captura por tela (é por env nesta fase).
- Vídeo, sticker e contato.
- Serviço de transcrição separado e modelo maior (só se a CPU da .146 não der conta).
- Portal B2B e histórico anterior a 01/09/2026.

## Further Notes

- Estado real em 26/09/2026: tabelas do sensor já existem no Postgres oficial com 1.394 contatos semeados e 584 mensagens (580 da sessão de teste, 4 do assistente). As sessões dos vendedores ainda não estão conectadas; o usuário conecta hoje.
- O runner da .146 responde na porta 9200 de dentro da rede; a porta 9000 do serviço avulso de transcrição do organizador-tarefa nunca subiu lá.
- A função de transcrição foi embutida no runner do assistente na manhã de 26/09/2026 por outra sessão, sem endpoint HTTP; por isso o endpoint entra por último para não conflitar.
- Volume esperado com 4 vendedores: algumas centenas de mensagens por dia. O Postgres guarda anos disso sem expurgo.
- Cartão do Trello: 20 pontos, distribuídos em captura 5, áudio 8, sinais 5, uso 2. Esta spec cobre captura e áudio (13) mais a cópia para o Mongo; sinais e uso ficam para o cartão seguinte.
