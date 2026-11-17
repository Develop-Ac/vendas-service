# Ofertas do atacado (promoção, liquidação, campanha)

Preço fechado de um produto, por um período, cadastrado na intranet e aplicado no orçamento do
atacado (clientes de tabela 2 e 5). Compras monta, a gestão aprova; sem aprovação a oferta não vale.
Os três tipos mudam o preço; o que muda de um para o outro é a bolsa do vendedor.

Módulo `src/oferta` (rotas `/oferta`); regras puras em `src/oferta/oferta.ts` (+ `oferta.spec.ts`),
usadas pelo cadastro e pelo orçamento.

## Modelo

- **Grupo** (`ven_oferta`): `nome`, `tipo` (`PROMOCAO` | `LIQUIDACAO` | `CAMPANHA`), `criado_por`
  (nome do usuário). Liquidação nasce com `premio_tipo = PCT_CUSTO` e `premio_valor = 0,05`; campanha
  grava `origem`, `fornecedor_codigo`/`fornecedor_nome`, `premio_tipo`, `premio_valor` e `premio_faixas`
  (ver "Campanha e prêmio"). Promoção não tem prêmio.
- **Item** (`ven_oferta_item`): um produto dentro do grupo, com `descricao` (cópia do ERP na
  inclusão), `preco_t2` e `preco_t5` (nulo = não vale para aquela tabela), `inicio` e `fim` (datas do
  calendário de Cuiabá, fim inclusivo), `limite_qtd` (nulo = sem limite) e a situação.
- **Situações do item**: `RASCUNHO` → `PENDENTE` → `APROVADO` → `ENCERRADO`, com `enviado_por/em`,
  `aprovado_por/em`, `encerrado_por/em` e `encerrado_motivo` (`DATA` | `LIMITE` | `SALDO` | `MANUAL`).
- **Linha do orçamento** (`ven_orcamento_item`): `oferta_item_id` e `oferta_tipo`, gravados quando a
  linha sai pelo preço da oferta. A linha usa o código reservado `promocao_codigo = PROMOCAO_OFERTA`
  (−1, ao lado de `PROMOCAO_PORTAL = 0` em `src/orcamento/promocao-portal.ts`), e por isso segue todo o
  caminho da promoção: preço fechado, validade pelo fim, "vender fora", PDF, mensagem e `promocao: true`
  no Celta.

## Permissões

Cabeçalho `x-user-id` em todas as rotas, aceito só com `x-app-token` = `APP_TOKEN` (`SoPeloProxy`: o proxy da intranet manda o `VENDAS_SERVICE_TOKEN`; chamada direta ao serviço é recusada). Telas em `sis_permissoes`:

| Ação | Tela | Permissão |
|---|---|---|
| Ler lista e detalhe | `/estoque/promocoes` | visualizar, editar ou criar |
| Criar, renomear, incluir, editar, remover, replicar datas, enviar | `/estoque/promocoes` | editar ou criar |
| Aprovar, encerrar, criar campanha, trocar o prêmio e trocar a fonte da promoção | `/estoque/promocoes/aprovar` | editar ou criar |
| Ganhos do mês e ganho por vendedor no resultado do grupo | `/estoque/promocoes/ganhos` | visualizar |

Sem a permissão: 403. O detalhe devolve `pode_aprovar` e `pode_ver_ganhos` para a tela esconder botões e
abas.

## Fluxo: montar → enviar → aprovar → encerrar

| Rota | Corpo | O que faz |
|---|---|---|
| `GET /oferta?situacao=ativos\|encerrados` | — | Grupos com contagem por situação, período mínimo–máximo e vendido (quantidade e valor). Ativo = sem itens ou com algum não encerrado. |
| `POST /oferta` | `{ nome, tipo, itens?, origem?, fornecedor_codigo?, premio_tipo?, premio_valor?, premio_faixas? }` | Cria o grupo (e inclui os itens, se vierem). Origem e prêmio só valem para `CAMPANHA`. |
| `PUT /oferta/:id/premio` | `{ premio_tipo?, premio_valor, premio_faixas? }` | Troca o prêmio (ver "Campanha e prêmio"). |
| `POST /oferta/:id/marca` | `{ marca, pct }` | Prévia da campanha por marca; não grava. |
| `GET /oferta/:id/resultado` | — | Faturado por item e ganho por vendedor no grupo. |
| `GET /oferta/ganhos?mes=AAAA-MM` | — | Ganhos do mês comissional (ver "Apuração dos ganhos"). |
| `GET /oferta/fonte` | — | `{ intranet, alterado_por, alterado_em, pode_alterar }`: de onde o orçamento do atacado lê a promoção. |
| `PUT /oferta/fonte` | `{ intranet: boolean }` | Troca a fonte (ver "Fonte da promoção"); vale na hora, sem reiniciar. |
| `PUT /oferta/:id` | `{ nome }` | Renomeia. |
| `GET /oferta/:id` | — | Detalhe com os itens: custo, saldo, tabela 2, tabela 5, mínimos, vendidas, restam e `erros` das conferências. |
| `POST /oferta/:id/itens` | `{ itens: [{ pro_codigo, preco_t2?, qtd? }] }` | Inclui por código ou pela lista de sugestão. Resposta: detalhe + `recusados: [{ pro_codigo, motivo }]`. |
| `PUT /oferta/item/:itemId` | `{ preco_t2?, preco_t5?, inicio?, fim?, limite_qtd? }` | Edita (campo ausente não muda). |
| `DELETE /oferta/item/:itemId` | — | Remove; só `RASCUNHO`. |
| `POST /oferta/:id/replicar-datas` | `{ item_id }` | Copia início e fim do item para todos os não encerrados do grupo. |
| `POST /oferta/:id/enviar` | `{ itens?: number[] }` | `RASCUNHO` → `PENDENTE` (vazio = grupo todo). |
| `POST /oferta/:id/aprovar` | `{ itens?: number[] }` | `PENDENTE` → `APROVADO`. |
| `POST /oferta/:id/encerrar` | `{ itens?: number[] }` | Encerra os não encerrados, motivo `MANUAL`. |

**Inclusão.** O serviço lê do ERP (empresa 3, `OrcamentoService.produtosPorCodigo`) descrição, custo,
`PRECO2`, `PRECO5`, saldo e o mínimo da régua de cada tabela (avaliação sem promoção). Datas padrão:
hoje e hoje + 30 dias. Vindo da sugestão (`preco_t2` + `qtd`): o preço da tabela 5 é o mesmo
percentual de desconto da tabela 2 aplicado sobre a tabela 5, limitado ao mínimo, e `limite_qtd = qtd`.
Só por código: cada tabela nasce no mínimo e o montador ajusta na linha. Preço que não fica abaixo da
tabela vira nulo (a oferta não vale naquela tabela). Produto fora do ERP, com erro de conferência ou
em sobreposição é recusado com o motivo; os demais entram.

**Edição.** Item `ENCERRADO` não se edita. Mudar preço, datas ou limite de um `APROVADO` devolve
**só esse item** a `PENDENTE` (limpa `aprovado_por/em`); os outros do grupo continuam valendo. Replicar
datas faz o mesmo para cada aprovado que mudou; um conflito de sobreposição recusa a replicação inteira.

**Envio e aprovação** reconferem cada item com custo e tabela de agora; item com erro, fora da etapa de
origem ou de outro grupo volta em `recusados` e o restante avança.

## Conferências

Ao incluir, editar, enviar e aprovar (mensagem por item):

- preço > 0 e menor que o preço normal daquela tabela; ao menos uma tabela com preço;
- preço ≥ mínimo: liquidação e campanha, `custo × OFERTA_PISO` (padrão 1,30); promoção, o
  `preco_minimo` que a régua do atacado dá ao produto naquela tabela;
- produto sem custo no ERP: recusado;
- início ≤ fim;
- sobreposição: o mesmo produto em outro item **não encerrado** (rascunho inclusive) com datas que se
  cruzam é recusado, dizendo o grupo e o período.

O mínimo é conferido nesses momentos, não a cada venda: se o custo subir depois da aprovação, a oferta
aprovada pode ficar abaixo de `custo × 1,30` até alguém editá-la.

## Vigência e encerramento

**Vigente** = `APROVADO`, hoje (Cuiabá) entre início e fim, vendidas < limite (quando houver) e
saldo disponível no ERP > 0.

Encerramento automático, apurado na leitura (`OfertaService.apurar()`, antes de `GET /oferta` e
`GET /oferta/:id`, no máximo uma vez a cada 10 minutos; falha só loga): para cada item aprovado já
iniciado, grava `ENCERRADO` com o primeiro motivo que valer, nesta ordem:

1. `DATA` — hoje passou do fim;
2. `LIMITE` — vendidas ≥ limite;
3. `SALDO` — saldo disponível ≤ 0.

Item aprovado que ainda não começou não é apurado (o estoque pode chegar até o início). O orçamento
calcula a vigência ao vivo, sem depender da apuração: item fora do período, sem saldo ou no limite já
não sai como oferta. O item que chega ao limite num fechamento fica `ENCERRADO`/`LIMITE` na próxima
apuração. A gestão encerra antes com `POST /oferta/:id/encerrar` (`MANUAL`).

## Limite e vendidas

**Vendidas** = soma de `ven_orcamento_item.quantidade` (e `total`, para o valor) das linhas com aquele
`oferta_item_id`, não vendidas fora (`fora_promocao = false`), em orçamentos `FECHADO`. Orçamento só
enviado não reserva; devolução não devolve quantidade ao limite. **Restam** = limite − vendidas
(nulo = sem limite).

No orçamento, a soma das linhas do mesmo item de oferta não pode passar do que resta: o serviço recusa
salvar com "Item N (descrição): restam X unidades na oferta — reduza a quantidade ou venda fora da
oferta.". A conferência se repete no desfecho `FECHADO`, relendo as vendidas — dois orçamentos abertos
podem somar mais que o restante, e o segundo a fechar é recusado. A releitura e a gravação do `FECHADO`
correm sob uma trava por item de oferta (`pg_advisory_xact_lock`), então dois fechamentos juntos não
passam pelo mesmo saldo. O fechamento também recusa a linha cujo item de oferta não está mais
`APROVADO` (encerrado ou voltado a pendente por edição): o vendedor refaz a linha pelo preço atual.

## Orçamento do atacado

**Fonte da promoção.** O orçamento do atacado lê a promoção de um lugar só, escolhido pelo botão
"Fonte da promoção" da tela Estoque › Promoções (`ven_oferta_config`, linha única; `PUT /oferta/fonte`):
**Celta** (padrão) ou **Intranet**. No Celta nada muda em relação a antes das ofertas: o cadastro, a
aprovação e os relatórios da intranet funcionam, mas não chegam ao orçamento. A troca é lida a cada
consulta de produto, então vale na hora para todos os vendedores, sem reiniciar o serviço.

Com a fonte na **Intranet** **e** cliente de tabela 2 ou 5 (`enriquecer` em
`orcamento.service.ts`):

1. a promoção do Celta (`promocoesVigentes`) não é consultada;
2. a promoção do portal congelada no pedido (`comPromosDoPortal`) entra primeiro e vence para o item;
3. depois entram as ofertas vigentes da intranet (`comOfertas`): preço de `preco_t2` ou `preco_t5`
   pela coluna de onde veio o preço normal do cliente (tabela por substituição incluída). Se a oferta
   não for menor que o preço normal, a linha não é oferta. Falha na leitura das ofertas só loga e o
   orçamento segue sem oferta.

Cliente de outra tabela, ou chave desligada: comportamento de antes (promoção de balcão do Celta).

O produto devolvido ao editor leva `promocao: { codigo: -1, descricao (nome do grupo), data_final,
tipo, oferta_item_id, restam }`. Vender fora da oferta limpa `oferta_item_id` e `oferta_tipo` e segue
a regra normal. Orçamento com oferta que venceu, foi encerrada ou voltou a pendente é re-precificado
ao vivo na reabertura, como a promoção vencida do Celta. A linha de oferta não pede alçada (o mínimo
é o próprio preço). Ao Celta vai `promocao: true` para os três tipos; vendida fora, sem a marca.

`GET /orcamento/produtos/ofertas?tabela=&cli=`: produtos em oferta vigente para a tabela, já avaliados
na régua (chave desligada ou tabela fora do atacado = lista vazia; sem paginação).

PDF e mensagem do WhatsApp mostram ao cliente só "oferta até dd/mm", sem o tipo (vale também para a
promoção do Celta e do portal).

## Bolsa por tipo

- **Promoção**: regra de sempre — o negativo da linha (abaixo de custo × piso) desconta pela metade,
  o positivo soma inteiro.
- **Liquidação e campanha**: a linha fica fora da bolsa, como a linha de serviço.
- **Vendida fora da oferta**: regra normal, inteira.

Onde vale:

- **Orçamento**: `montarItens` soma a linha em `servicos` (fora de custo, promoção e teto);
  `negativoDaLinha` devolve 0 (nada a pedir no ajuste da bolsa); `compensacaoOrcamento` (`celta.ts`)
  e `bolsaDoOrcamento` (`extrato-bolsa.ts`) pulam a linha.
- **Mês do vendedor e por cliente** (`mesDaBolsa`): o BI não conhece o tipo da oferta (liquidação vai
  ao Celta como promoção, marca S). Depois da leitura do BI, a fração de cada linha de NF casada com
  item de liquidação/campanha (`fracaoCasada(…, 'fora_bolsa')`, mesmo casamento de `fracaoPromoPortal`)
  é descontada: venda líquida, custo × piso, excedente do teto e a metade que a marca S fez o BI
  aplicar (`descontoForaBolsaNoMes`). Devolução entra com sinal. O fechamento mensal passa pela mesma
  conta. Casamento indisponível = sem desconto.
- **Extrato por NF**: cada linha leva `fora_bolsa` (fração 0–1); `valoresLinha` multiplica líquido,
  custo × piso, absorvido, excedente, ajuste e saldo por `1 − fora_bolsa`, e a conciliação continua
  fechando com o card.
- **Bolsa do canal** (`canalMtd`, sem casamento por vendedor) continua contando a liquidação.

Promoção do portal (código 0): vai ao Celta com `promocao: true`; quando o BI já traz a marca S, a
fração do portal não soma a metade de novo — a metade entra uma vez só.

## Campanha e prêmio

Campanha (`tipo = CAMPANHA`) é um grupo de oferta com prêmio para o vendedor, fora da bolsa como a
liquidação. Regras puras em `src/oferta/premio.ts` (+ `premio.spec.ts`).

- **Origem**: `EMPRESA` (a AC paga) ou `FORNECEDOR` (o fornecedor banca; o valor vira "a cobrar").
  Na de fornecedor, `fornecedor_codigo` é obrigatório e tem de existir no ERP; o nome gravado é o nome
  fantasia (ou a razão social). Na de empresa, o fornecedor fica nulo.
- **Tipos de prêmio**: `PCT_VENDA` — fração do valor vendido; `VALOR_UNIDADE` — R$ por unidade.
  Liquidação é sempre `PCT_CUSTO` (fração do custo; padrão 0,05).
- **Percentual em fração na API**: 0,02 = 2% (`PCT_VENDA` < 1). A tela mostra em %.
- **Faixas por quantidade** (`premio_faixas: [{ a_partir_de, valor }]`, até 10): a partir dessa
  quantidade total do vendedor na campanha, vale aquele valor no lugar do base, para todas as unidades.
  Cada faixa precisa de `a_partir_de` e `valor` maiores que os da anterior (a primeira, maior que o
  base). Faixa fora de ordem ou fornecedor ausente = 400 com o erro.
- **Mínimo**: o preço da campanha segue `custo × OFERTA_PISO`, como a liquidação.
- **Trocar o prêmio** (`PUT /oferta/:id/premio`, `/estoque/promocoes/aprovar`): tipo ou faixas ausentes
  mantêm os do grupo; promoção = 400; grupo que já tem venda faturada é recusado. Os itens não mudam de
  situação.

**Montagem por marca** (`POST /oferta/:id/marca`, só campanha, `{ marca, pct }`): lê do ERP os produtos
ativos da marca (nome exato) com saldo e aplica o desconto `pct` (fração) sobre as tabelas 2 e 5, sem
passar do mínimo de cada tabela. Resposta `{ marca, pct, truncado, incluidos, excluidos }`: incluídos com
`pro_codigo`, `preco_t2`, `preco_t5` e `no_minimo`; excluídos com `pro_codigo` e `motivo` (sem tabela 2,
sem custo, mínimo ≥ tabela). Não grava: a tela confirma mandando os incluídos para
`POST /oferta/:id/itens`, que repete as conferências.

## Ganho na linha do orçamento

Para liquidação e campanha, `promocao` do produto devolvido ao editor leva também `ganho_unit` (R$ por
unidade no valor base: custo × fração, preço da oferta × fração ou o próprio R$/un) e `proxima_faixa`
(`{ valor, a_partir_de }` da primeira faixa, em R$/un; nulo sem faixas). Promoção não traz os campos.
É calculado na leitura, nada é gravado na linha. PDF, impressão e mensagem do WhatsApp não mostram
ganho, prêmio nem tipo.

## Apuração dos ganhos

Regras puras em `src/oferta/ganhos.ts` (+ `ganhos.spec.ts`); rota `GET /oferta/ganhos?mes=AAAA-MM`
(mês comissional, 26 a 25; ausente = o corrente; formato inválido = 400).

- **O que conta**: a unidade de NF casada (casamento orçamento ↔ NF da bolsa, por vendedor) com linha
  de orçamento que saiu de item de **liquidação ou campanha**. Promoção e venda fora da oferta não geram
  ganho. O casamento olha só os últimos 8 meses de desfecho: venda mais antiga que isso não entra.
- **Liquidação**: bônus das notas emitidas dentro do mês comissional = quantidade × `custo_ref` da
  linha do orçamento × fração.
- **Campanha**: prêmio sobre todas as vendas do vendedor na campanha (faixa pela quantidade total), pago
  de uma vez no mês comissional em que cai o fim, e só depois do fim (`PAGAR`). Antes disso, nos meses
  que a campanha cruza, aparece `ANDAMENTO` ("em andamento"), fora do total.
- **Devolução** entra negativa e desconta. O prêmio da campanha nunca fica negativo; o bônus da
  liquidação pode.
- **A cobrar do fornecedor**: campanhas de origem `FORNECEDOR` pagas no mês, somadas por fornecedor.

Resposta:

```
{ mes: { ano, mes, inicio, fim },
  vendedores: [{ rep_codigo, rep_nome, bonus_liquidacao, premios_campanha, total, em_andamento,
                 linhas: [{ nfs, nota_fiscal, empresa, serie, emissao, devolucao, pro_codigo, descricao,
                            oferta_item_id, quantidade, oferta_id, grupo, tipo, ganho, situacao }] }],
  fornecedores: [{ fornecedor_codigo, fornecedor_nome, unidades, valor,
                   campanhas: [{ oferta_id, grupo, unidades, valor }] }],
  totais: { bonus_liquidacao, premios_campanha, total, em_andamento, a_cobrar } }
```

`nota_fiscal` é o número impresso (só empresa 3; ERP fora = nulo). O Excel (abas Vendedores,
Fornecedores e Detalhe) é gerado pela tela a partir desse JSON; o serviço não exporta arquivo.

`GET /oferta/:id/resultado`: `{ faturado: [{ oferta_item_id, pro_codigo, descricao, quantidade, valor }],
vendedores: [{ rep_codigo, rep_nome, quantidade, valor, ganho, situacao }] | null }` — no grupo inteiro,
sem recorte de mês; `vendedores` é nulo em promoção ou sem `/estoque/promocoes/ganhos`.

O relatório lê o casamento de cada vendedor com venda de oferta, um por vez (cache da bolsa): o mês frio
pode demorar.

## Variáveis

| Variável | Padrão | Efeito |
|---|---|---|
| `OFERTA_PISO` | `1.30` | Mínimo da liquidação e da campanha = custo × piso. Valor inválido ou ≤ 0 volta ao padrão. |

## Deploy

1. Aplicar `sql/2026-11-17_ofertas_postgres.sql` no Postgres da intranet **antes** de subir o serviço
   (o Prisma passa a ler `oferta_item_id` e `oferta_tipo` em toda consulta de item de orçamento;
   serviço novo sem o SQL quebra a leitura de orçamentos).
2. Preencher os usuários de `/estoque/promocoes/aprovar` e aplicar
   `sql/2026-11-17_ofertas_permissao.sql` (copia `/estoque/promocoes` de quem tem `/estoque/analise`).
3. Preencher os usuários da gestão e aplicar `sql/2026-11-17_ofertas_ganhos_permissao.sql`
   (`/estoque/promocoes/ganhos`, só visualizar). Campanha e ganhos não pedem DDL novo: as colunas já
   vêm do SQL do passo 1.
4. Deploy do vendas-service e depois do cotacao-frontend. A fonte da promoção nasce no Celta (o SQL do
   passo 1 grava assim), então o orçamento segue como antes até alguém trocar na tela.

## Virada

1. Com a fonte no Celta, cadastrar em Estoque › Promoções o que hoje está com preço de atacado no
   Celta (o recadastro é manual; nada é importado) e aprovar.
2. No dia combinado, quem tem `/estoque/promocoes/aprovar` troca a fonte para Intranet no botão do
   cabeçalho da tela (pede confirmação).
3. Conferir no orçamento de um cliente de tabela 2 e de um de tabela 5 que o item sai com o preço da
   oferta e o selo do tipo, e que um cliente de varejo continua com a promoção do Celta.

Promoção do Celta com preço de atacado que não for recadastrada some do orçamento do atacado no dia da
virada. Voltar atrás: trocar a fonte para Celta no mesmo botão — o orçamento volta a ler o Celta na hora.

## Fora do escopo

- Preço da campanha abaixo do mínimo (`custo × OFERTA_PISO`) bancado pelo fornecedor.
- Faixa de prêmio por valor vendido (só por quantidade).
- Lançar os ganhos na folha (o relatório é para conferência e pagamento manual).
- Tela de ganhos para o próprio vendedor.
- Varejo e portal B2B: não leem as ofertas da intranet; nada é gravado como promoção no Celta. Venda
  digitada direto no Celta não é oferta.
