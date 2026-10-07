# Extrato da bolsa por NF e bolsa do orçamento fechado

A bolsa do vendedor no card é uma soma sobre as linhas de NF do mês no BI. O extrato abre essa soma
NF a NF, liga cada linha ao orçamento da intranet que a gerou e confere o total com o card. No
orçamento FECHADO, a bolsa prometida (congelada no fechamento) aparece ao lado da bolsa que as NFs
casadas com ele de fato geraram.

Módulo puro: `src/orcamento/extrato-bolsa.ts` (+ `extrato-bolsa.spec.ts`).

## Bolsa de uma linha de NF

Valores com sinal (devolução negativa), piso de **hoje** (`pisoVigente`), como o card:

```
custo_piso = custo_bolsa × piso          custo_bolsa = custo do lote de oportunidade na data (custoBolsaSql), senão custo_produto
absorvido  = promoção (PROMOCAO='S') e custo_produto > 0 e custo_produto × piso > líquido → (custo_produto × piso − líquido) / 2
ajuste     = efetivo do ajuste da bolsa negativa que casarAjustes atribuiu à NF + produto (estorno da devolução negativo)
saldo      = líquido − custo_piso + absorvido + ajuste
```

A metade da promoção usa o custo do **produto** (não o do lote) e só vale na venda (na devolução o
custo vem negativo) — exatamente a conta de `bolsaVendedor`, para fechar ao centavo. Serviço
(`codigosDeServico()` do ERP) fica fora: `custo_piso`, `saldo`, `absorvido` e `ajuste` zerados, fora
dos totais e da venda líquida da NF; só contado em `servicos_fora`.

## Conciliação com o card

`conciliar(linhas, piso)` soma as linhas: `saldo = Σ(líquido − custo_piso) + Σ absorvido + Σ ajuste`.
`totais.card_saldo` é `calcularBolsa().saldo` do mesmo mês pela mesma leitura do card
(`mesDaBolsa`: `bolsaVendedor` + efetivo dos ajustes com NF no mês) e `diferenca = saldo − card_saldo`,
esperado 0. Diferença ≠ 0 aponta o que o card conta e o extrato não mostra — por exemplo, ajuste
casado (pela NF gravada no orçamento ou do condicional) com uma NF lançada em nome de outro vendedor.

## Casamento orçamento → NF (`casarOrcamentos`)

Orçamentos FECHADOS do vendedor com desfecho nos últimos 8 meses (`CASAMENTO_MESES`), por item,
na ordem — a primeira que tiver linha do produto vale (igual ao ajuste da bolsa):

1. `celta_orcamento` → `ORCAMENTOS.NFS`;
2. `ORCAMENTOS.CONDICIONAL` → `CONDICIONAIS.NFS` (erp-firebird-api, tabela `condicionais`);
3. mesmo cliente + vendedor + produto, emissão do dia do início até início + 30 dias (fim do dia).
   Início = `celta_importado_em`, ou `desfecho_em` se não foi importado.

**Sem condição de preço** (o ajuste exige preço ≥ o do orçamento; aqui a NF abaixo do orçamento é
justamente o que se quer ver). Consumo por unidade e por item, NFs por ordem de emissão; cada unidade
de NF casa com um orçamento só — na disputa, quem começou antes leva. Vários NFs por orçamento e uma
NF cobrindo vários orçamentos são normais. **Devolução** não consome: volta para o orçamento que levou
a venda do mesmo cliente + produto emitida até a data da devolução, até a quantidade vendida a ele;
devolução sem venda casada antes fica "sem orçamento".

Linhas de NF: `linhasNfAjuste` (atacado, empresa 3, pares cliente + produto dos itens, desde o menor
início). Recalculado a cada leitura, **cache de 5 minutos por vendedor** (`casamentoDoRep`, a mesma
leitura para lista, orçamento e extrato); nada gravado. erp-firebird-api sem `CONDICIONAL`/
`condicionais` (versão anterior ao deploy) → casa só pela NF do orçamento e pela janela, com warn.

## Bolsa do orçamento fechado

- `POST /orcamento/:id/desfecho` com FECHADO grava `piso_bolsa` (piso em vigor no dia) e
  `bolsa_orcamento` = `calcularBolsa().orcamento` dos itens gravados: receita sem serviço − custo da
  bolsa (`custo_ref`) × piso, item sem custo neutro, + metade da promoção absorvida + ajuste da bolsa
  negativa (`assumido_unit × quantidade`). BI fora no fechamento → fecha com as colunas nulas.
  `POST /:id/reabrir` limpa as duas.
- Fechados antes da coluna (nulas): calculados na leitura com o **piso de hoje** a partir de
  `ven_orcamento_item` → `bolsa_aprox: true`. Sem backfill.
- `bolsa_nf` = Σ do saldo (fórmula acima, piso de hoje) da fração casada de cada linha de NF, em
  qualquer mês; `null` = nenhuma NF casada, orçamento fora dos 8 meses ou BI indisponível.

## Rotas

`GET /orcamento/:id` e `GET /orcamento` (lista): todo orçamento ganha
`bolsa_orcamento: number|null`, `piso_bolsa: number|null`, `bolsa_aprox: boolean`, `bolsa_nf: number|null`
(preenchidos só nos FECHADOS). Na lista, `bolsa_nf` sai de uma leitura por vendedor presente entre
os FECHADOS da página (cache de 5 min por vendedor). Falha do BI/ERP nunca quebra a lista: campos
nulos + warn.

`GET /orcamento/vendedor/:rep/bolsa/extrato?ano=&mes=` — um dos últimos 6 meses comissionais
(padrão: o atual; fora disso, 400):

```ts
{ periodo: { ano, mes }, piso: number, rep_codigo: number,
  nfs: Array<{ empresa, serie, nfs, nota_fiscal: number|null, chave_nfe: string|null, emissao: 'YYYY-MM-DD', devolucao: boolean,
    cli_codigo, cli_nome, orcamentos: Array<{ id, numero }>,
    venda_liquida, custo_piso, saldo, absorvido, ajuste,
    itens: Array<{ item, pro_codigo, pro_descricao, quantidade, unitario, liquido, custo, custo_oportunidade: boolean, custo_nf, custo_piso, saldo, promocao: boolean, absorvido, ajuste, servico: boolean,
      orcamento: { id, numero, preco_unit, custo_ref } | null }> }>,
  totais: { venda_liquida, custo_piso, saldo_linhas, absorvido, ajuste, saldo, servicos_fora: number,
            card_saldo: number, diferenca: number } }
```

- Valores com sinal: devolução negativa em `quantidade`, `liquido`, `custo`, `custo_nf`, `custo_piso`, `saldo`.
- `custo` (o usado na bolsa: lote de oportunidade ou do produto), `custo_nf` (`custo_produto` da view)
  e `custo_piso` são da **linha inteira** (quantidade × unitário), não por unidade. `custo_oportunidade`
  = a linha usou o custo do lote. `unitario` é o da NF; `orcamento.preco_unit`/`custo_ref` são por unidade.
- `saldo` do item e da NF já somam `absorvido` e `ajuste`; `totais.saldo_linhas` = Σ(líquido − custo_piso),
  `totais.saldo` = saldo_linhas + absorvido + ajuste.
- `orcamentos` da NF = todos os orçamentos casados com alguma linha dela; `orcamento` do item = o
  primeiro casado com a linha (a linha pode se dividir entre orçamentos).
- `servicos_fora` = quantas linhas de serviço o mês teve.
- NFs por emissão desc (empate: NFS desc), itens por ITEM.
- `nota_fiscal` e `chave_nfe`: a `vw_analise_vendas` os traz nulos em toda linha (o Stage_Vendas só
  carrega NFS/SERIE). O serviço completa os vazios pela erp-firebird-api (`nf-saida`, empresa 3, por
  NFS, lotes de 200); ERP fora → continuam `null` e o extrato sai mesmo assim (warn no log).

**Papel**: o vendas-service não identifica o usuário nas rotas (só o token do app); como
`/orcamento/ajustes-bolsa` e as demais, a restrição à gestão fica na tela (`gestaoVendas`).

## Banco

SQL manual `sql/2026-10-02_bolsa_fechado_postgres.sql`: `ven_orcamento.piso_bolsa numeric(8,4)` e
`ven_orcamento.bolsa_orcamento numeric(14,2)`.
