# Spec — Produtos do dia para o supervisor do atacado

Cartão: Vendas: Produtos do dia para o supervisor do atacado (8 pts).
Fechada em 28/09/2026 a partir das decisões da entrevista. Entrega desta spec = lista diária, tela de leitura, aviso e apuração. Distribuição por vendedor e sugestão no orçamento vêm depois.

## Problem Statement

A empresa compra lotes em oportunidade e registra, por lote, quanto da sobra vai para o vendedor (a bolsa). Esses lotes só rendem se a equipe do atacado empurrar o produto enquanto há estoque e enquanto o cliente está no ponto de recomprar. Hoje o supervisor não tem como saber, ao começar o dia, quais desses produtos valem a ligação: a lista de lotes existe numa tela de gestão, a previsão de recompra por cliente existe no analytics, o estoque existe no ERP, e ninguém cruza os três. O resultado é lote que encalha, bolsa que não se realiza e vendedor que oferece o que dá na telha.

## Solution

Todo dia útil, antes do expediente, o sistema monta uma lista curta de produtos em lote de oportunidade que (1) geram bolsa boa por unidade para o vendedor, (2) têm clientes no ponto de recomprar hoje e giro no atacado, e (3) têm estoque suficiente para sustentar a venda sem desabastecer a loja. A lista chega ao supervisor por uma tela própria da intranet e por aviso no sino e no mural. Cada linha traz os clientes devidos e o vendedor de cada um, para que o supervisor repasse. No dia seguinte o sistema apura quanto de cada item foi vendido, para medir se a lista funciona.

## User Stories

1. Como supervisor do atacado, quero receber todo dia útil, antes das 8h, uma lista de produtos para empurrar, para começar o dia com a equipe orientada.
2. Como supervisor, quero que a lista traga só produtos que estão em lote de oportunidade aberto e com saldo, para que cada venda realize bolsa reservada pela empresa.
3. Como supervisor, quero ver a bolsa por unidade que o vendedor ganha em cada produto, para saber o que argumentar com a equipe.
4. Como supervisor, quero que a lista tenha no máximo 15 itens, para caber numa conversa de manhã com a equipe.
5. Como supervisor, quero que a lista seja menor quando poucos lotes passam nos critérios, em vez de ser completada com produtos fora de lote, para não diluir o foco.
6. Como supervisor, quero uma linha por grupo de produtos equivalentes, mostrando o produto principal, para não ver o mesmo item repetido em três códigos.
7. Como supervisor, quero a lista ordenada por quanto de bolsa o produto pode gerar hoje, para começar pelo que mais rende.
8. Como supervisor, quero ver, em cada linha, a demanda esperada do dia, para entender por que aquele produto está em cima.
9. Como supervisor, quero ver os clientes que estão no ponto de recomprar cada produto, com vendedor da carteira, cidade, dias desde a última compra e quantidade que costuma levar, para repassar ao vendedor certo.
10. Como supervisor, quero que a linha mostre até 5 clientes e indique quantos mais existem, para a tela não virar uma lista de clientes.
11. Como supervisor, quero que a lista só inclua produtos com estoque que cubra alguns dias de venda, para não mandar a equipe vender o que acaba na primeira nota.
12. Como supervisor, quero que produtos com estoque abaixo do ponto de pedido fiquem de fora, para não competir com o varejo pelo mesmo produto.
13. Como supervisor, quero saber quantos lotes abertos ficaram de fora por estoque, e quais, para avisar compras que há lote encalhado por falta de produto.
14. Como supervisor, quero um botão para regenerar a lista do dia, para refazer a conta quando entra mercadoria de manhã.
15. Como supervisor, quero que regenerar substitua a lista do dia, e não crie uma segunda, para não haver duas listas do mesmo dia.
16. Como supervisor, quero um aviso no sino e no mural quando a lista do dia estiver pronta, com link para a tela, para não precisar lembrar de abrir.
17. Como supervisor, quero silêncio quando a lista sair vazia, para o aviso continuar valendo alguma coisa.
18. Como gerente comercial, quero ver a mesma lista e receber o mesmo aviso, para acompanhar o que o supervisor está empurrando.
19. Como gerente, quero consultar a lista de dias anteriores, para ver o que foi sugerido e o que vendeu.
20. Como gerente, quero que cada lista guardada registre, no dia seguinte, a quantidade e o valor vendidos no atacado de cada item, para medir se a sugestão converte.
21. Como gerente, quero que a lista de sábado seja apurada na segunda, para nenhum dia ficar sem apuração.
22. Como gerente, quero que a lista dependa do estoque ao vivo do ERP, e não da foto semanal, para não sugerir o que acabou ontem.
23. Como gerente, quero que a lista continue sendo gerada mesmo se o analytics estiver fora do ar, usando só giro e bolsa, para a rotina não parar por dependência.
24. Como vendedor do atacado, quero que o supervisor chegue com nome de cliente e produto, e não com "vende mais", para a orientação virar ligação.
25. Como gestor de compras, quero que lote de oportunidade sem estoque suficiente apareça como "de fora por estoque", para reagir antes de o lote encerrar sem vender.
26. Como administrador da intranet, quero que a tela use a mesma permissão das outras telas de gestão do atacado, para não criar mais uma permissão para cuidar.
27. Como administrador da intranet, quero que os dias de cobertura de estoque e a janela de clientes devidos sejam configuráveis por variável de ambiente, para ajustar sem deploy de código.
28. Como administrador da intranet, quero que o aviso nasça como regra desligada e seja ligado na configuração de avisos, como toda regra nova, para não surpreender ninguém.
29. Como desenvolvedor, quero que a montagem da lista seja uma função de serviço testável com fontes de dados falsas, para validar a ordenação e os filtros sem banco.
30. Como desenvolvedor, quero que a consulta de clientes devidos por produto seja um endpoint do analytics, e não uma leitura direta do Mongo pelo vendas-service, para manter cada serviço dono do seu banco.

## Implementation Decisions

**Onde mora a lógica.** O job, a montagem da lista, a persistência, a tela e o aviso ficam no vendas-service, no módulo de orçamento, porque é lá que já vivem os lotes de oportunidade, a fórmula da bolsa, o cron diário, o SDK de avisos, a leitura do estoque ao vivo e o cliente do analytics. O analytics-atacado ganha um único endpoint novo de leitura.

**Fonte dos itens.** Somente lotes de compra de oportunidade vigentes e com unidades restantes. Um produto sem lote nunca entra, mesmo com bolsa alta. Quando menos de 15 lotes passam nos filtros, a lista sai menor.

**Chave da linha.** Uma linha por grupo de produtos equivalentes (a chave de grupo já validada no analytics e na análise de estoque). O produto exibido é o do lote. Se dois lotes caem no mesmo grupo, vale o de maior bolsa por unidade.

**Bolsa por unidade.** A parte do vendedor na sobra do lote a preço de tabela, que o endpoint de lotes já devolve por unidade. Não há valor mínimo de bolsa para entrar; a ordenação resolve.

**Demanda esperada do dia.** Soma de duas parcelas: o giro médio diário do produto no atacado (quantidade vendida em 12 meses no analytics dividida por 365) e a soma da quantidade por compra dos clientes devidos hoje. Sem analytics disponível, a segunda parcela é zero e a primeira usa a demanda média diária da análise de estoque.

**Clientes devidos.** Pares cliente e item do analytics cuja próxima compra esperada cai entre 30 dias atrás e 3 dias à frente, com status em dia ou atrasado. Janela configurável por ambiente. O endpoint novo do analytics recebe a janela e a lista de chaves de grupo e devolve, por chave, os clientes com código, nome, cidade, vendedor da carteira, dias desde a última compra e quantidade por compra.

**Ordem.** Bolsa por unidade vezes demanda esperada, decrescente. Empate por bolsa por unidade.

**Filtro de estoque.** Estoque considerado = menor entre o disponível ao vivo no ERP e as unidades restantes do lote. Entra na lista se esse estoque cobre N dias da demanda média diária de todos os canais (análise de estoque) e fica acima do ponto de pedido. N vem do ambiente, padrão 15. Os números da análise de estoque atualizam aos domingos; o estoque ao vivo é lido na hora.

**Lotes de fora por estoque.** Ficam registrados junto com a lista do dia, com o motivo, para a tela mostrar a contagem no rodapé e os nomes ao expandir.

**Persistência.** Uma tabela nova no Postgres do vendas-service: cabeçalho por data (gerado em, gerado por, total de lotes avaliados, lotes de fora com motivo) e linhas com posição, produto, chave de grupo, descrição, bolsa por unidade, giro diário, demanda de clientes devidos, demanda esperada, estoque considerado, clientes devidos em JSON, e os campos de apuração (quantidade e valor vendidos, apurado em). Regenerar no mesmo dia apaga e regrava as linhas daquele dia. DDL entregue como SQL manual.

**Job.** Cron no vendas-service às 7h de Cuiabá, de segunda a sábado, expressão sobrescrevível por ambiente, no mesmo molde do aviso de orçamento vencendo. Sequência: apurar o último dia com lista e sem apuração, depois gerar a lista de hoje, depois emitir o aviso se houver ao menos um item. Falha em uma etapa não impede as outras e vai para o log.

**Apuração.** Lê a venda do atacado por produto no BI para a data da lista, como o encerramento de lote já faz, somando todos os códigos do grupo. Grava quantidade e valor na linha. Lista de sábado é apurada na segunda porque é o próximo dia com cron.

**API do vendas-service.** Leitura da lista por data (padrão hoje), lista de datas disponíveis, e ação de regenerar restrita à gestão (supervisão do atacado e gerência, mesmo critério de papel já usado no front).

**Tela.** Rota própria no módulo de vendas, somente leitura, com seletor de data, tabela dos itens, clientes expandíveis por linha, rodapé de lotes de fora e botão de regenerar visível só para gestão. Permissão copiada de quem vê a supervisão da carteirização, como as outras telas de gestão do atacado. Segue o design system travado da intranet.

**Aviso.** Evento de sistema com chave própria, referência igual à data para não duplicar, alvo por usuário (usuários com hub inicial de supervisão do atacado e de gerência), canais sino e mural, link para a tela. Sem WhatsApp até existir grupo do atacado configurado. A regra nasce inativa.

**Analytics-atacado.** Endpoint novo de leitura, com o mesmo token de aplicação dos demais, consultando a coleção de cliente por item por janela de próxima compra esperada e lista de chaves. Sem cálculo de bolsa em Python.

## Testing Decisions

**O que é um bom teste aqui.** Testa comportamento observável: dada uma lista de lotes, um estoque, um giro e clientes devidos, a lista sai com estes itens, nesta ordem, e estes lotes ficam de fora por este motivo. Não testa chamadas internas, SQL nem formato de log.

**Seam principal (uma só).** O método que gera a lista do dia no serviço novo do vendas-service, com os colaboradores injetados e substituídos por objetos falsos: fonte de lotes, leitor de estoque ao vivo, leitor da análise de estoque, cliente do analytics, repositório de persistência e serviço de avisos. Prior art: o teste do serviço da fila da carteirização, que instancia o serviço com repositórios falsos e verifica o que foi criado. Casos mínimos:

- lote com estoque e clientes devidos entra e fica em cima;
- lote com estoque abaixo da cobertura fica de fora e aparece na contagem;
- lote abaixo do ponto de pedido fica de fora;
- dois lotes no mesmo grupo viram uma linha;
- menos de 15 lotes gera lista menor, sem completar;
- analytics indisponível gera lista só por giro e bolsa;
- lista vazia não emite aviso; lista com item emite uma vez;
- regenerar no mesmo dia substitui as linhas;
- apuração grava quantidade e valor na lista do último dia sem apuração.

**Seam secundário.** A conta da demanda esperada e da ordenação como função pura, no molde dos testes da régua e do custo para bolsa, se a função for extraída. Preferir cobrir pela seam principal; extrair só se o teste do serviço ficar ilegível.

**Analytics.** Um teste do endpoint novo no padrão dos testes de perfis existentes: dado um Mongo com pares cliente e item, a janela devolve os certos e ignora status parado.

**Front.** Sem teste automatizado; validação manual na tela pelo usuário, como nas outras telas do módulo.

## Out of Scope

- Distribuição dos itens por vendedor na tela, com marcação de quem cuida de quê.
- Exibição da lista dentro do editor de orçamento ou na estação do vendedor.
- Produtos fora de lote de oportunidade, mesmo com bolsa alta.
- Envio por WhatsApp.
- Tela de métrica de conversão da lista; só o dado apurado fica guardado.
- Probabilidade calibrada de compra; usa-se a próxima compra esperada e o giro.
- Recalcular a análise de estoque em outra frequência.

## Further Notes

- A defasagem semanal da análise de estoque afeta só a cobertura e o ponto de pedido; o estoque em si é ao vivo. Aceito nesta fase.
- Se os lotes de oportunidade forem sempre poucos, a decisão de restringir a lista a lotes volta à mesa com dado na mão.
- O supervisor do atacado é identificado na intranet pelo hub inicial de supervisão; não existe vínculo com o papel de supervisor da tabela de comissões, e esta spec não cria um.
- Entrega manual: SQL da tabela e da permissão, variáveis de ambiente (cron, cobertura, janela), ativação da regra de aviso, deploys do vendas-service, do analytics-atacado e do front. Nada é comitado pelo agente.
