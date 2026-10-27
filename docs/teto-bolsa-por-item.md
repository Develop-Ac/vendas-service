# Bolsa de desconto — teto por item

Spec de 27/10/2026. Regra aprovada com a diretoria (documento "Atacado - Bolsa - Regra do teto por item - Diretoria", Analises/Atacado).

## A regra

Cada linha de venda (e cada item do orçamento) só pode colocar na bolsa até um teto:

| Classificação do item (preço de tabela PRECO2) | Teto da bolsa da linha |
|---|---|
| tabela ≤ R$ 100 | 40% do valor líquido praticado da linha |
| tabela > R$ 100 | o custo da bolsa da linha (custo × quantidade; custo do lote de oportunidade quando houver) |
| custo da bolsa ≤ 0 | zero |

- Só vale para o lado positivo: `saldo_linha = liquido − custo_bolsa × piso`; se `saldo_linha > teto`, a diferença é o **excedente** da linha. Linha negativa, devolução, serviço e promoção não mudam nada (absorção e ajuste continuam como hoje).
- A classificação usa o preço de tabela do item, não o praticado: subir o preço nunca troca a regra do item; o 40% é calculado sobre o praticado.
- Três parâmetros, por env, no mesmo lugar do piso: `ORCAMENTO_TETO_CORTE` (R$ 100), `ORCAMENTO_TETO_PCT` (0,40) e `ORCAMENTO_TETO_DESDE` (data de vigência, yyyy-mm-dd). `ORCAMENTO_TETO_CORTE=0` desliga a regra (comportamento de hoje).
- **Venda já feita não muda.** O excedente só é calculado em linhas emitidas a partir de `ORCAMENTO_TETO_DESDE`; linha anterior entra como hoje. Sem a data (ou data inválida) a regra fica desligada e o serviço avisa no log: nunca retroage por engano. No fechamento do orçamento o teto só vale se a data do fechamento for igual ou posterior à vigência; fechados antigos recalculados ficam como estavam. Na tela, o teto só entra na conta de orçamento aberto; fechado em modo leitura mostra o que foi gravado.
- **Nada novo aparece para o vendedor.** Cartão da bolsa, "bolsa depois", bolsa por cliente, bolsa do canal, extrato por NF e a bolsa gravada no orçamento já saem com o teto aplicado. Sem coluna, selo, tooltip ou texto. A API pode devolver o excedente somado (`excedente_mtd`, `excedente_orc`) para conferência da gestão, mas o front não renderiza.

## Como entra no código (mesmo molde da absorção de promoção: um termo a mais na conta)

Bolsa hoje: `saldo = receita − custo × piso + absorvido + ajuste` (`calcularBolsa`, regua.ts). Entra um termo: `− excedente`. O excedente é somado linha a linha em cada leitura.

### vendas-service

1. **regua.ts** — `tetoLinha({ liquido, custo_bolsa, preco_tabela }, corte, pct)` pura: devolve `{ teto, excedente }`. `calcularBolsa` recebe `excedente_mtd` e `excedente_orc` e subtrai em `saldo`, `saldo_apos`, `orcamento`, `acima_linha` e `acima_linha_apos` (o prêmio também não vê o excedente). Teste unitário com os três casos (barato no teto, caro no teto, custo zero) e um negativo (não mexe).
2. **orcamento.bi.repository.ts** — `bolsaVendedor`, `bolsaPorCliente`, `bolsaClienteMensal` e a leitura do canal ganham a coluna `excedente`: `LEFT JOIN dbo.Stage_Produtos p ON p.EMPRESA = 3 AND p.PRO_CODIGO = v.PRO_CODIGO` e

   ```sql
   SUM(CASE WHEN v.OPF_CODIGO <> 2 AND v.liquido_produto > 0 AND ({custo}) > 0
            AND v.liquido_produto - ({custo}) * @piso >
                CASE WHEN COALESCE(p.PRECO2, 0) <= @corte THEN @pct * v.liquido_produto ELSE ({custo}) END
       THEN v.liquido_produto - ({custo}) * @piso
            - CASE WHEN COALESCE(p.PRECO2, 0) <= @corte THEN @pct * v.liquido_produto ELSE ({custo}) END
       WHEN v.OPF_CODIGO <> 2 AND v.liquido_produto > 0 AND ({custo}) <= 0
            AND v.liquido_produto - ({custo}) * @piso > 0
       THEN v.liquido_produto - ({custo}) * @piso
       ELSE 0 END) AS excedente
   ```

   `{custo}` é o mesmo `custoBolsaSql().custo` (lote de oportunidade). Serviços já ficam fora pelo filtro existente. Parâmetros `@corte` e `@pct` entram junto com `@piso`; com `@corte = 0` a expressão devolve zero para tudo.
3. **orcamento.service.ts** — `parametros()` lê os dois envs; `bolsa()` passa `excedente_mtd` (do BI) e `excedente_orc` ao `calcularBolsa`. `excedente_orc`: a tela calcula por linha (mesma conta, em comum.tsx `excedenteLinha`) e manda o agregado no query `excedente_orc`, como já manda `absorvido`; o serviço só o aceita com a regra ativa. O laço de `saldoAbertos` (enviados que fecharem) aplica `tetoLinha` por item. `canalMtd` usa a mesma coluna do BI.
4. **extrato-bolsa.ts** — `valoresLinha` recebe `preco_tabela` e devolve `saldo` já com o teto (`saldo − excedente`); `bolsaDoOrcamento` (o que grava `bolsa_orcamento` no fechamento) aplica `tetoLinha` por item. O extrato por NF precisa do PRECO2: vem na mesma consulta das linhas (`Stage_Produtos`), sem chamada nova.
5. **ajuste-bolsa.ts** — sem mudança (só linhas negativas).

### cotacao-frontend

6. **EditorOrcamento.tsx / comum.tsx** — a coluna Bolsa de cada linha e a soma do orçamento usam a mesma conta do teto (função espelho de `tetoLinha` em comum.tsx, com `preco_tabela` do item), para "bolsa depois" bater com o serviço. Sem elemento novo na tela. A chamada da bolsa manda o agregado `excedente_orc` ao lado de `absorvido`. O teto só entra em orçamento aberto (rascunho, enviado, aprovação); fechado, perdido ou cancelado em leitura fica como hoje. Nota: no mês (BI) a linha com custo zero tem saldo igual ao preço e vira excedente inteira; no orçamento o item sem custo já entra neutro e dá excedente zero. Os dois caminhos contam zero.
7. **page.tsx (cartão e lista)** — nada: lê `saldo`, `saldo_apos`, `premio_estimado` que já vêm com o teto.

### Fora do código

- `.env` do vendas-service (produção): `ORCAMENTO_TETO_CORTE=100`, `ORCAMENTO_TETO_PCT=0.40` e `ORCAMENTO_TETO_DESDE=<data da virada>`. Sem SQL manual: não há tabela nova.
- Scripts de acompanhamento (`Analises/Atacado/acompanha_bolsa.py`, skill `bolsa-atacado` do assistente) passam a conciliar com o teto; o assistente lê a API, então já sai certo.

## Critérios de aceite

- Conferência em teste com vigência retroativa (`ORCAMENTO_TETO_DESDE=2026-09-26`, só no ambiente de teste): mês comissional out/26, piso 1,538, corte 100, pct 0,40, antes do ajuste da bolsa negativa e sem tirar serviços: excedente do canal R$ 2.907 em 74 linhas (Alisson 1.881, Cristiano 500, Fernando 498, Deyvid 28); bolsa do canal R$ 14.607 → R$ 11.700. A data de emissão no BI não tem hora, então a vigência é sempre um dia inteiro: deploy em 27/10/2026 com `ORCAMENTO_TETO_DESDE=2026-10-28`; nenhuma venda de 27/10 ou anterior muda, e a regra (inclusive a projeção do orçamento em edição) liga à meia-noite. O serviço só considera a regra ativa quando a data de hoje é igual ou posterior à vigência; antes disso devolve corte e percentual zero para a tela.
- Linha emitida antes da vigência não gera excedente (teste unitário).
- Soma das linhas do extrato por NF = cartão da bolsa, ao centavo (como hoje).
- `ORCAMENTO_TETO_CORTE=0` reproduz os valores atuais.
- Orçamento com item de tabela ≤ R$ 100 vendido a markup 3: a coluna Bolsa da linha mostra 40% do valor da linha; item de tabela > R$ 100 a markup 3: mostra o custo da linha. Nenhum texto novo na tela.
- Teste unitário de `tetoLinha` e de `calcularBolsa` com excedente.

## Pontuação

8 pontos (agregação: um termo a mais no mesmo molde da absorção de promoção, em quatro consultas, duas funções puras e a coluna do editor).
