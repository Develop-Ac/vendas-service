# Encomenda de Peças → pedido de compra ("E-")

Quando a encomenda entra em **Comprado**, o vendas-service gera o pedido de compra no
compras-service e passa a mostrar, na tela da encomenda, os pedidos, as NF-e vinculadas
e o rastreio SSW de cada uma.

## Regras

- **Peça encomendada precisa existir no Celta.** `POST /encomenda-pecas` exige `pro_codigo`
  em cada item de `pecas` e confere o código no ERP (`/erp/encomenda-pecas/produtos/:cod`);
  inexistente → 400. `peca` e `referencia` continuam gravados como a tela manda (lá os
  campos são travados e preenchidos pela busca do código). O sentinela 99999 não é mais usado.
- **Fornecedor do item cotado é código, obrigatório.** `for_codigo` (ou `fornecedor` só com
  dígitos) precisa existir no Celta (`/erp/encomenda-pecas/fornecedores/:cod?empresa=3`);
  o nome vem da API e é gravado em `fornecedor`. Texto livre dá 400. Na edição, sem os
  dois campos o fornecedor gravado é mantido. A tela busca o nome em
  `GET /encomenda-pecas/fornecedores/:cod`. Cotações antigas (fornecedor só texto) podem
  ganhar o código por `PATCH /encomenda-pecas/item_cotado/:id/fornecedor` em qualquer
  etapa até "Liberado para comprar" (na tela, setor Compras).
- **Item cotado diz de qual peça é** (`pro_codigo`, precisa ser uma das `pecas`). Se a
  encomenda tem uma peça só, o pedido assume essa peça quando a cotação não informou.
- **Comprado gera o pedido antes de mudar o status.** Itens = cotados com
  `autorizado = true`. Um pedido por fornecedor, todos com o mesmo número (`E-100001`),
  gravado em `ven_encomenda_pecas.pedido_compras`. Item selecionado sem fornecedor ou sem
  produto do Celta → 400 listando todos; compras-service fora → 502. Nos dois casos o
  status não muda.
- Item do pedido: produto/descrição/referência/quantidade da peça encomendada; custo
  (`custo`) como valor unitário; marca, frete, prazo e transportadora da cotação.

## Rotas

| Rota | O que muda |
| --- | --- |
| `PUT /encomenda-pecas/status/:id` | `status: "Comprado"` gera o pedido; `usuario` opcional vai ao log. |
| `GET /encomenda-pecas/:id` | traz `pedido_compras_formatado` e, depois do Comprado, `pedidos` (compras-service) ou `pedidos_erro`. |
| `GET /encomenda-pecas/pedidos/:id` | só o bloco `pedidos`/`pedidos_erro`, para atualizar o rastreio. |
| `GET /encomenda-pecas` | cada encomenda traz `pedido_compras` e `pedido_compras_formatado` (sem consultar o compras). |

`pedidos` é a resposta de `GET /compras/pedido/encomenda/:id` do compras-service: por
pedido, fornecedor (código e nome), status, número no Celta, itens, `pdf_url` e `notas`;
por nota, `numero_nf`, emitente, `situacao` (Entregue / Em Trânsito / Sem rastreio /
Pendente) e `rastreio` (transportadora, frete por nossa conta, domínio SSW, previsão,
atualizado em, eventos com data, código SSW, ocorrência, descrição, cidade e filial).

## Config

```
COMPRAS_SERVICE_URL=http://compras-service.acacessorios.local
COMPRAS_SERVICE_TIMEOUT_MS=30000
```

## Banco

`sql/2026-10-06_encomenda_pecas_pedido_compras.sql`: `for_codigo` e `pro_codigo` em
`ven_encomenda_pecas_itens_cotados`, `pedido_compras` em `ven_encomenda_pecas`. No
compras-service: `origem` e `encomenda_pecas_id` em `com_pedido`
(`sql/2026-10-06_com_pedido_encomenda_pecas.sql` de lá). Aplicar o SQL **antes** do
`prisma db pull`.
