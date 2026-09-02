# Orçamento do Atacado — tela de proposta com a régua v3 embutida

> Backend: `vendas-service` (módulo `src/orcamento`). Frontend: `cotacao-frontend`,
> `app/(private)/vendas/orcamento` (módulo Vendas, permissão estrita `/vendas/orcamento`).

## Para que serve

Dar ao vendedor do atacado **autonomia com trilho**. Na mesma tela ele vê, por item,
até onde pode ir sozinho (preço mínimo da régua) e, no mês, quanto de desconto ainda
cabe sem perder o bônus da comissão. Abaixo do mínimo o orçamento **não é proibido**:
vai para aprovação do supervisor. Abaixo do custo é recusado.

## De onde vem cada informação

| Pergunta | Fonte | Como |
|---|---|---|
| Saldo disponível/reservado **agora** | ERP (Celta) | `erp-firebird-api` → `PRODUTOS.ESTOQUE_DISPONIVEL/RESERVADO`, sem cache |
| Preço do item **para este cliente** | ERP | `CLIENTES.TABELA_PRECO` ('2' → `PRECO2`, '5' → `PRECO5`, … ) em `PRODUTOS`. Tabela zerada cai para PRECO2 → PRECO5 → PRECO_VENDA e a tela avisa |
| Classe, mix e faixa | Régua v3 sobre o custo ao vivo | `PRECO_CUSTO` (reposição) → faixa 1A..3D com os **mesmos cortes do ETL** (`sp_Load_Stage_Produtos_FromDelta`); classe PB = subgrupo 154 (ou descrição P/BRISA) |
| Markup e desconto máximo | Postgres `ven_regua_atacado` | seed = régua v3 aprovada (GERAL 2,85→1,42 / PB 2,30→1,38; desc. 3→10%) |
| Itens fora da régua | Postgres `ven_regua_item_excecao` | LANÇAMENTO/EXCLUSIVO e OPORTUNIDADE: markup atual congelado, desconto próprio |
| Equivalentes | Postgres `com_fifo_completo` (última execução) | mesmo `group_id` **e** mesma descrição **e** mesma `marca_linha` (a regra do worker). Só o `group_id` não basta: grupos mesclados à mão viraram "grupões" |
| Desconto por volume | Postgres `ven_regua_volume` | o máximo da faixa é o teto; a quantidade libera uma fração dele: 50% até 2 un, 75% de 3 a 5, 100% a partir de 6 (ex.: 1D 3% → 1,5% / 2,25% / 3%). A API devolve `escala_volume` por item |
| Vendem juntos | Postgres `ven_produto_relacionado` | pares apurados no BI (`vw_analise_vendas`, atacado, 12 meses, ≥3 notas juntos), cron semanal seg 04:30 |
| Bolsa de desconto do vendedor | BI | `vw_analise_vendas` no mês comissional (26→25), canal ATACADO: bruto, desconto, MIX1 |
| Crédito do cliente | BI + ERP | limite (ERP) − títulos em aberto (`Stage_ContasReceber_Titulos`), bloqueio de crediário |
| Último preço pago pelo cliente | BI | última nota do cliente com o item |

## Regra do preço mínimo (a que o vendedor decide sozinho)

O vendedor **nunca digita preço**: só quantidade e desconto (%). `preco = tabela × (1 − desc_pct)`;
`desc_max` da linha = máximo da faixa × fração liberada pela quantidade (nunca acima do máximo).

```
lista da régua = custo × markup(classe, faixa)
piso da régua  = lista × (1 − desc_max)
mínimo         = max( tabela × (1 − desc_max), piso da régua )
                 nunca acima da tabela, nunca abaixo do custo
```

Se a tabela do ERP ainda está **abaixo** da lista da régua (item que não subiu na Onda 1),
o desconto permitido encolhe até zero: não se dá desconto sobre preço que já está aquém.

Exceção (exclusivo/oportunidade): mínimo = tabela × (1 − desc. próprio), sem piso da régua.

## Bolsa de desconto (disciplina da comissão)

```
% do mês = desconto concedido / venda bruta (mês comissional, atacado)
saldo p/ bônus = 3% × bruto − desconto     (≤ 3%  → +0,15 p.p. na comissão MIX2/3)
saldo p/ teto  = 6% × bruto − desconto     (> 6%  → −0,15 p.p.)
```

A tela projeta o "% depois" com o orçamento em edição e mostra o semáforo
(verde ≤3%, amarelo ≤6%, vermelho >6%). Também mostra a participação MIX1 e o degrau
da escada (22/26/30% → ×1,25/×1,5/×2,0) — e quanto falta para o próximo.

## Ciclo do orçamento

`RASCUNHO` → `ENVIADO` (ou `APROVACAO`, se algum item ficou abaixo do mínimo) →
`FECHADO` (com referência do pedido/NF no Celta) | `PERDIDO` (motivo: PRECO, PRAZO_FRETE,
SEM_ESTOQUE, CONCORRENTE, CLIENTE_ADIOU, CREDITO_BLOQUEADO) | `CANCELADO`.

Editar um orçamento enviado o devolve a RASCUNHO. Ao salvar, preço de tabela, custo e saldo
são relidos do ERP — o que a tela mostrou pode ter mudado. `GET /orcamento/:id/conferir`
re-avalia um orçamento salvo (saldo que sumiu, tabela que mudou) sem gravar.

**O orçamento NÃO é gravado no Celta** (não existe escrita de orçamento no ERP; a única
porta é o `api-vendas-service`, restrita a REP_CODIGO). O vendedor fecha o pedido no Celta
como hoje e registra o número em "Fechado".

## Rotas (`/orcamento`)

| Método | Rota | O quê |
|---|---|---|
| GET | `/regua` | régua vigente, cortes de faixa, parâmetros |
| GET/PUT | `/regua/excecoes[/:pro_codigo]` | itens fora da régua |
| GET | `/clientes?q=&todos=` | busca (código, CNPJ/CPF, nome); padrão só atacado |
| GET | `/clientes/:cli` | cabeçalho: cadastro ao vivo + crédito + histórico |
| GET | `/vendedor/:rep/bolsa?bruto=&desconto=` | bolsa do mês (+ projeção) |
| GET | `/produtos?q=&tabela=&cli=` | busca já avaliada na régua |
| GET | `/produtos/:codigo[/equivalentes|/relacionados]` | detalhe, equivalentes, vendem juntos |
| POST | `/relacionados/recalcular` | reapura os pares no BI |
| GET/POST | `/` | lista / cria |
| GET/PUT/DELETE | `/:id` | obtém / regrava / cancela |
| POST | `/:id/enviar` · `/:id/aprovar` · `/:id/desfecho` | ciclo |

## Instalação

1. Aplicar `sql/orcamento_atacado_postgres.sql` no Postgres da intranet (manual, idempotente).
2. `npx prisma generate` (o schema já tem os modelos `ven_regua_*`, `ven_orcamento*`, `ven_produto_relacionado`).
3. Deploy da `erp-firebird-api` com `PRECO1..PRECO10`, `CUSTO_NOTA`, `DESCTO_MAXIMO`, `INATIVO`
   em `PRODUTOS` (catálogo `produtos.tabela.ts`).
4. Variáveis (opcionais, com padrão): `ORCAMENTO_DESC_BONUS_PCT`, `ORCAMENTO_DESC_PENA_PCT`,
   `ORCAMENTO_VALIDADE_DIAS`, `ORCAMENTO_RELACIONADOS_CRON`, `ORCAMENTO_RELACIONADOS_MESES`.
5. Rodar uma vez `POST /orcamento/relacionados/recalcular` (senão "vendem juntos" só aparece
   após o primeiro cron).
6. Liberar a tela por usuário em `sis_permissoes` (`tela = '/vendas/orcamento'`) — o módulo
   Vendas é estrito, não herda do Painel.

## Relação com o módulo `precificacao` do compras-service

O branch `teste` do compras-service tem uma régua anterior (`com_precificacao_faixa`, 67%/50%
fixos por tabela). A régua **v3** (2 classes × 11 faixas) substitui aquela para o atacado e
mora aqui, no vendas-service, porque quem a consome é a venda. Quando o módulo de compras for
mergeado, a fonte única deve ser esta tabela (`ven_regua_atacado`) ou uma migração explícita.
