# Painéis nativos da intranet sem Metabase (fase 2 da redução do Metabase)

Data: 07/10/2026. Fechado em grill com o Lucas. Uma spec, seção por serviço, uma tarefa no Trello com checklist.

## 1. Por que

Medições de 07/10/2026 (Prometheus da .138 e API do Metabase):

| Item | Valor |
|---|---|
| RAM do Metabase na .144 | 1,2 GB de 12,5 GB (maior container) |
| CPU média do Metabase | 4% |
| Dashboards / cards | 28 / 602 (480 SQL nativo no SQL Server BI) |
| Cache de consulta do Metabase | ligado (estratégia TTL, multiplicador 100; a API `/api/setting` não expõe isso na v0.56, por isso a leitura inicial disse "desligado") |
| 36 cards do dash 18 (Atacado), 30 dias, 1 vendedor | mediana 250 ms, pior 1,3 s |

Conclusão: o SQL não é lento e o mart já existe (`f_analise_vendas`, `f_dre_base`, `f_vendas_dia_vendedor`, `kpi_compras_snapshot`, `vw_kpi_compras_mensal`, recarregados por `sp_refresh_*`). O que pesa é o caminho: cada card é uma requisição do navegador → rota Next → Metabase (JVM) → SQL Server, 36 vezes por abertura, sem cache, numa máquina sem RAM. Trocar o Metabase por outro BI não resolve isso.

Fase 2 = tirar o Metabase do caminho das telas da intranet. O mart continua no SQL Server BI. O Metabase fica como ferramenta de exploração do Lucas e do diretor.

## 2. Escopo

Telas da intranet que hoje leem o Metabase:

| Tela | Rota | Dash hoje | Serviço dono |
|---|---|---|---|
| Painel do vendedor (por hub: varejo, atacado, supervisão, gerência) | `/vendas` | 7 / 13 / 18 / 5 | vendas-service |
| Painel de compras | `/compras/painel` | 93 | compras-service |
| Gestão de estoque | `/estoque/analise` | 89 | compras-service |
| KPIs do DRE (pessoal) | `/api/pessoal/dre-kpis` | 22 | pessoal-service |

Fora do escopo: dashboards que só existem no Metabase (Contas a Receber/Pagar, Fluxo de Caixa, Comissões, Pró-labore, Orçamento por Canal, Carteira de Clientes). Continuam no Metabase.

## 3. Decisões

1. **SQL dos cards vira arquivo `.sql` versionado no serviço dono da tela**, com parâmetros nomeados, executado pela lib `mssql` (padrão fiscal-service / etl-worker) com o login BI_AC. Nada de views ou procs novas no SQL Server para os painéis.
2. **Uma chamada por painel.** O serviço roda os SQLs do painel em paralelo no pool e devolve todos os cards juntos. Fim do card a card.
3. **Formato de resposta por card igual ao do Metabase**: `{ id, titulo, display, data: { cols, rows } }`. Os componentes `VendasPainelKpis` e `PainelMetabase` não mudam.
4. **Cache em memória no serviço, TTL 60 s**, chave = (painel, vendedores, período, demais filtros). 60 s < 5 min do mart, então nunca mostra dado mais velho que o próprio mart.
5. **Flag por rota para voltar ao Metabase** durante a semana de comparação: env `PAINEL_FONTE_<TELA>=metabase|servico`. Some ao final.
6. **Filtro por vendedor continua no token assinado** da rota Next (como hoje). O serviço recebe a lista de vendedores já resolvida; nunca confia em parâmetro do navegador.
7. **Mudança de painel passa a ser commit + deploy.** Aceito: esses painéis mudam pouco; o que muda toda semana fica no Metabase.
8. **Ordem:** vendas (tela Painel por hub) → compras + estoque → DRE. Cada tela roda uma semana ao lado do Metabase com os mesmos filtros antes de o card do Metabase ser arquivado.

## 4. vendas-service

### 4.1 Painel do vendedor (`/vendas`)

- Endpoint `GET /paineis/vendedor?vendedores=A,B&de=YYYY-MM-DD&ate=YYYY-MM-DD` (interno; a rota Next `app/api/vendas/painel` continua sendo a porta do navegador e resolve vendedores pelo token).
- Cards = aba "Painel de Vendas" do dash 18 (19 scalar, 3 gauge, 3 bar, 2 map, 2 row, 2 table). Um `.sql` por card em `src/paineis/sql/vendedor/<slug>.sql`, extraído do Metabase (`GET /api/card/:id`), parâmetros `{{periodo}}`/`{{vendedor}}` convertidos para `@de`, `@ate`, `@vendedores`.
- Hubs supervisão e gerência passam vários vendedores (equipe) ou nenhum (empresa toda), como hoje.
- Rota Next: com `PAINEL_FONTE_VENDAS=servico` chama o endpoint; senão mantém o fluxo Metabase atual.

**Painel do canal: descartado em 08/10/2026 — tudo mora em `/vendas` por hub.** O painel do canal inteiro (`/atacado/vendas`, `/varejo/vendas`, endpoint `GET /paineis/canal`) não será feito; a visão da equipe ou da empresa toda é o painel por hub do 4.1 (SUPERVISAO_ATACADO com a equipe, GERENCIA sem vendedor).

## 5. compras-service

### 5.1 Painel de compras (`/compras/painel`, dash 93)

- Endpoint `GET /paineis/compras?de=&ate=`. 17 cards (7 scalar, 1 combo, 2 line, 3 bar, 2 area, 1 gauge, 1 table) lendo `kpi_compras_snapshot`, `vw_kpi_compras_mensal`, `Stage_*`.
- Rota Next `app/api/compras/painel` com flag `PAINEL_FONTE_COMPRAS`.

### 5.2 Gestão de estoque (`/estoque/analise`, dash 89)

- Endpoint `GET /paineis/estoque?fornecedor=`. 22 cards (11 scalar, 4 bar, 5 table, 2 row).
- Mesma flag e mesmo padrão. Fica no compras-service pela conexão MSSQL já existente; analise-estoque-service (Python/Mongo) não entra.

## 6. pessoal-service

### 6.1 KPIs do DRE (`/api/pessoal/dre-kpis`, dash 22)

- Só os cards que a rota Next consome hoje (não os 76 do dash). Endpoint `GET /paineis/dre-kpis?ano=&canal=` lendo `f_dre_base` via Prisma (já aponta para o SQL Server) ou `mssql` cru.
- Flag `PAINEL_FONTE_DRE`.

## 7. etl-worker

1. **`posCarga` na `CargaConfig`:** campo opcional `posCarga?: string[]` (procs executadas em sequência, sem parâmetros, logo após o `EXEC proc` em `carga.service.ts`, com a mesma telemetria e alerta da carga). Carga `vendas` ganha `posCarga: ['dbo.sp_refresh_f_analise_vendas']`. A rotina `analise-vendas` (10 min) sai de `ROTINAS_ATIVAS`. Atraso do mart cai de ~15 min para ~5 min e a rotina nunca mais roda no meio de uma carga.
2. **Janela fica 06:00–19:00.** Não há venda à noite.
3. **Procs versionadas:** script `scripts/extrair-procs.js` lê `sys.sql_modules` do BI (todas as `sp_refresh_*`, `fn_canal_vendedor_em`, `vw_*` usadas pelos painéis) e grava `sql/procs/<nome>.sql`. Só extrai; não altera conteúdo. Rodar manualmente e comitar antes de qualquer mudança no mart.

## 8. Metabase ao final

- Arquivar as 10 cópias "Vendas por Vendedor - <nome>" (existiam só para travar filtro por usuário, que o token assinado já faz) e os dash 7 e 13 do iframe.
- Manter dash 5 (Geral) e 18 (Atacado) como laboratório do Lucas.
- Fase 1 (separada, sem código): `JAVA_OPTS=-Xmx1g` e teto de 1,5 GB no EasyPanel; o cache de consulta já está ligado (TTL × 100); nada a fazer nele.

## 9. Critérios de aceite

- Cada tela nativa mostra os mesmos números do Metabase para os mesmos filtros, conferidos por uma semana (printar lado a lado no cartão).
- Abertura do painel do vendedor: 1 requisição em vez de 36; segunda abertura em até 60 s responde do cache.
- Venda emitida no ERP aparece no painel em até 5 min no horário comercial.
- Nenhum vendedor vê número de outro.
- `sql/procs/` no etl-worker com todas as procs do mart; `posCarga` com telemetria e alerta iguais aos da carga.
- Ao virar a flag, nenhuma rota Next chama `bi.acacessorios.local`; só os dashboards que ficam no Metabase.

## 10. Pontos

Uma tarefa, 13 pontos (molde). Checklist por serviço no cartão.

## Implementação (07/10/2026)

### vendas-service (feito, sem commit)

- Módulo `src/paineis/`: `GET /paineis/vendedor?hub=VAREJO|ATACADO|SUPERVISAO_ATACADO|GERENCIA&vendedores=A,B&de=&ate=`. Sem `de`/`ate` = mês comissional vigente (`CarteirizacaoService.periodoComissionalVigente`). Resposta `{ painel, filtros, geradoEm, cache, cards[] }`, card com `dashcard`, `card`, `titulo`, `display`, posição, `visualization_settings` (card + override do dashcard) e `data { cols, rows }` no formato do Metabase (datas `...T00:00:00-03:00`, corte em 2000 linhas como o Metabase). Card que falha volta com `data: null` e `erro`, sem derrubar o painel.
- Catálogo e SQL extraídos do Metabase por `scripts/extrair-cards-metabase.ts`: `src/paineis/catalogo/<hub>.json` (aba "Painel de Vendas" dos dash 7/13/18/5; mapas repetidos fundidos como a rota do frontend fazia) e 40 arquivos em `src/paineis/sql/`. Os 7 cards GUI (MBQL) viram SQL no próprio script. Filtro de vendedor fica como marcador `{{vendedor:tabela.coluna}}` resolvido por requisição (`painel-sql.ts`); lista vazia = empresa toda (`1 = 1`).
- Painel do canal (`GET /paineis/canal`) removido em 08/10/2026 (decisão do usuário: tudo mora no painel por hub). Saíram a rota, `PaineisService.canal`, `CONDICAO_CANAL`/`SQL_MEMBROS_CANAL`/`CANAIS_BI` e o canal histórico de `painel-sql.ts`, os testes correspondentes, os cenários `--canal` do `scripts/comparar-com-metabase.ts` e o `sql/2026-10-07_painel_canal_permissao.sql`. `dbo.fn_canal_vendedor_em` continua no BI (não é do painel). Comparação por hub depois da remoção igual à de antes: ATACADO (1) e SUPERVISAO_ATACADO (3) 28 iguais; GERENCIA 30 iguais + Faturamento Projetado (por desenho) e Positivação (inativos).
- Cache em memória 60 s (`cache: true`). Consultas do painel em paralelo no pool próprio do módulo (max 10); cards com o mesmo SQL rodam uma vez.
- Validação `scripts/comparar-com-metabase.ts` (set/2026): ATACADO (1 vendedor) 28 iguais; SUPERVISAO_ATACADO (3) 28 iguais; GERENCIA 31 iguais + "Faturamento Projetado" diferente por desenho (no Metabase, vendedor vazio zera esse card; com `--mb-todos`, que passa todos os nomes como a rota antiga fazia, fica igual); VAREJO (1 vendedor) 23 iguais. (Os cenários de canal foram medidos e descartados com o painel do canal em 08/10.) Os cards de orçamento (2 por painel) e "Entregas" não são comparáveis (abaixo).
- "Positivação de Carteira" (08/10/2026) reescrita à mão em `sql/positivacao-de-carteira.sql`: período em `dt_emissao_convertida` (índice `IX_fav_dt`) e marcadores direto na coluna, sem varrer `f_analise_vendas` para normalizar nomes (a lista é normalizada no Node, em `montarConsulta`). Canal VAREJO caiu de 14–16 s para 0,2–0,5 s; 1 vendedor, de ~1,2 s para ~15 ms.
- Regra nova de negócio nesse card: o denominador (carteira na última foto do período) soma só representantes ativos (`dbo.ComissaoRepresentante.inativo = 0`), nos 4 hubs; o numerador continua com todo vendedor do filtro. Por isso o card nativo difere do Metabase quando a lista inclui inativo com carteira (set/2026: gerência 594 → 540, canal ATACADO 556 → 533, canal VAREJO 38 → 7). Sem o filtro de ativos, a reescrita bateu com o Metabase em todos os cenários.
- Catálogo: `sqlManual: true` na entrada desse card nos 4 hubs. O extrator mantém o arquivo e a marca de todo dashcard com `sqlManual` (não apaga nem regrava; o nome do arquivo fica reservado). O `.sql` manual começa com `-- MANUAL:`; o teste do catálogo exige a marca em todo dashcard que usa um arquivo assim.
- Comparação após a regra de ativos (set/2026): ATACADO (1), SUPERVISAO_ATACADO (3) e VAREJO (KENEDY) iguais; gerência e canais diferem só na Positivação, pela carteira de inativos.
- Desempenho (08/10/2026), sem mudar regra: `mapa-de-calor` (Vendas - Mato Grosso), `comissao-por-mix-e-faixa` e `-420`, `meta-valor-venda-diaria` e `-367`, `taxa-de-conversao-de-orcamento` e `taxa-convercao-orcamentos` viraram `-- MANUAL:` com `sqlManual: true` em todos os dashcards (22 no total com a Positivação). Período por intervalo em `dt_emissao_convertida` (`IX_fav_dt`) no lugar de `CAST(dt_emissao AS date)`; nas taxas, intervalo `@ini`–`@fim` dos meses comissionais tocados; na comissão, venda agregada uma vez em `@base` (a CTE era reavaliada a cada referência). Normalização de nome contra `d_cadastro_representantes` mantida como no Metabase.
- Isolado (set/2026, CPU no servidor, pior dos cenários ALISSON / 3 vendedores / sem filtro): comissão 1,2 s → 50 ms; mapa 650 → 60 ms; meta 540 → 105 ms; taxas 500–830 → 120–370 ms (o resto é a varredura de `Stage_Orcamentos`, que não tem índice). Painel inteiro (mediana de 3, SQLs em paralelo, pool 10): ATACADO 5,0 → 2,8 s; SUPERVISAO_ATACADO 5,0 → 2,7 s; GERENCIA 3,3 → 2,9 s; VAREJO 3,1 → 1,5 s. Os mais lentos agora: saldo-projetado, relatório por item com comissão, média de vendas diárias, mix-faixa-*, vendas-x-meta-diaria-total.
- `comparar-com-metabase.ts` depois da reescrita: ATACADO (1) 28 iguais, SUPERVISAO_ATACADO (3) 28 iguais, VAREJO (KENEDY) 23 iguais, GERENCIA 30 iguais + Faturamento Projetado e Positivação (diferenças já conhecidas). As taxas de conversão batem vazias dos dois lados (`vw_orcamentos` desatualizada); com a view refeita inline (`Stage_Orcamentos` + cadastro) o SQL novo deu o mesmo valor do original nos 3 cenários (ex.: 0,3148 / 0,3235 / 0,6377 e 0,3339 / 0,2892 / 0,3635).
- Layout por hub (seção 11, 08/10/2026): tabela `ven_painel_layout` (DDL manual `sql/2026-10-08_painel_layout.sql`, PENDENTE de aplicar; sem ela o painel segue no layout do catálogo e loga o erro). `GET /paineis/vendedor` aplica os ajustes do hub por cima do catálogo (posição, tamanho, `oculto`, `titulo`), ordena por (row, col) e devolve todos os cards com `oculto` e `tituloPadrao`; card oculto não roda SQL e vem com `data: null`.
- `PUT /paineis/vendedor/layout?hub=` (body `{ itens: [{ dashcard, row, col, size_x, size_y, oculto, titulo }] }`, `x-user-id` em `atualizado_por`) substitui todos os ajustes do hub numa transação, com validação 400 (dashcard do catálogo do hub, sem repetido, grade de 24 colunas, título até 120, vazio ou igual ao do catálogo = nulo); `DELETE` na mesma rota = "Restaurar padrão". Respostas `{ ok: true, itens: n }` e `{ ok: true }`.
- Sem autenticação no serviço: a rota Next confere `editar` em `/vendas`. Gravar ou restaurar derruba o cache de 60 s só do hub (chave com prefixo do hub; painel montado com layout anterior à gravação não entra no cache). Testes em `src/paineis/paineis.service.spec.ts`.

### Pendente

- `sql/2026-10-07_bi_refresh_vw_orcamentos_sqlserver.sql` (aplicação manual no BI): `vw_orcamentos` desatualizada faz Total Orçamento / Quantidade de Orçamentos falharem com filtro de vendedor e as duas taxas de conversão saírem vazias — hoje, no Metabase também.
- Card "Entregas" (dash 5, card 368) lê o Postgres de entregas pelo Metabase; o vendas-service não tem essa conexão. Volta com `erro`.
- Rota Next com `PAINEL_FONTE_VENDAS` (cotacao-frontend).

## 11. Fase 3 (proposta 08/10/2026): editar o layout do painel pela tela

Pedido: a gestão ajusta posição, tamanho e visibilidade dos cards de cada painel direto na tela, sem deploy. Hoje o layout (`row`, `col`, `size_x`, `size_y`) vem do catálogo JSON extraído do Metabase e é fixo.

### Como funciona
1. **O catálogo continua sendo o padrão.** Por cima dele entra uma tabela de ajustes no Postgres da intranet, mantida pelo vendas-service:
   `ven_painel_layout (painel, dashcard, row, col, size_x, size_y, oculto, titulo, atualizado_por, atualizado_em)`, chave `(painel, dashcard)`; `titulo` nulo = título do catálogo; `painel` = hub (`VAREJO`, `ATACADO`, `SUPERVISAO_ATACADO`, `GERENCIA`). DDL manual em `sql/`.
2. **`GET /paineis/vendedor`** mescla os ajustes no layout antes de responder (um `SELECT` por chamada, cacheado junto). Card `oculto` não roda SQL.
3. **`PUT /paineis/vendedor/layout?hub=`** recebe a lista completa `[{dashcard,row,col,size_x,size_y,oculto,titulo}]` e grava tudo numa transação. **`DELETE`** na mesma rota apaga os ajustes do hub (= "Restaurar padrão"). As duas exigem usuário com `editar` em `/vendas` na `sis_permissoes` (coluna já existe); a rota Next confere pela sessão e repassa.
4. **Tela Painel:** botão "Editar layout" (só para quem tem `editar`) liga o modo de edição: os cards ficam arrastáveis e redimensionáveis na mesma grade de 24 colunas × 46 px que já existe, com ícone de olho para ocultar e lápis para renomear o título; rodapé com "Salvar", "Cancelar" e "Restaurar padrão". Fora do modo de edição, nada muda. No celular não há edição (a grade empilhada segue a ordem `row`/`col`).
5. **Biblioteca:** `react-grid-layout` (dependência nova; é a referência para grade com arrastar/redimensionar e usa o mesmo modelo de colunas/linhas do Metabase). Carregada só no cliente e só no modo de edição.
6. **Compras e estoque** entram depois com a mesma tabela no compras-service (`com_painel_layout`) e o mesmo componente de edição, parametrizado pelo painel.

### Fora da v1
Criar card, trocar tipo de gráfico, layout por usuário (é por hub), histórico de versões (o "Restaurar padrão" cobre o arrependimento).

### Pontos
13 (uma tarefa): vendas-service tabela + três rotas (5), frontend modo de edição com a biblioteca (8).

### Decisões a confirmar
- Layout por hub: **decidido 08/10** — todos os usuários do hub veem o mesmo layout.
- Quem edita: **decidido 08/10** — quem tem `editar` em `/vendas` na permissão do usuário.
- Renomear título: **decidido 08/10** — entra na v1.
