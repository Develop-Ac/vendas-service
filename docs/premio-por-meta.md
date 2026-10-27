# Prêmio da bolsa por atingimento da meta

O prêmio do vendedor é uma fração do saldo retido (lucro acima da linha) **depois da reserva**
para o mês seguinte, e a **taxa** depende do atingimento da meta no mês comissional:

    saldo           = saldo_inicial + gerado      (a bolsa que o vendedor vê, com absorvido e ajuste)
    reserva         = min(reserva_pct × saldo, reserva_teto), ≥ 0
    premio_base     = max(0, acima_linha − reserva)
    premio_estimado = taxa × premio_base

    atingimento = venda líquida do mês ÷ meta do mês

| Atingimento        | Taxa |
|--------------------|------|
| abaixo de 100%     | 5%   |
| 100% a 109,99%     | 15%  |
| 110% ou mais       | 25%  |

As fronteiras entram no degrau de cima (100% → 15%, 110% → 25%). A venda líquida é a mesma
`receita_mtd` da bolsa (sem serviço). Vale para toda prévia de prêmio — card da bolsa,
orçamento em edição e qualquer valor que saia de `calcularBolsa` (`src/orcamento/regua.ts`).

## Reserva para o mês seguinte

30% do **saldo da bolsa** (limitado a R$ 3.000) fica de **reserva**: vira saldo inicial do mês
seguinte e não é premiada. O que carrega é a bolsa inteira (saldo inicial + gerado, com a metade da
promoção que a empresa absorve e o ajuste da bolsa negativa); o que premia é só o lucro acima da
linha (`acima_linha`), porque absorvido e ajuste são da empresa e nunca viraram lucro. Saldo ≤ 0 →
reserva 0 no card. A mesma conta vale para o "depois do orçamento" (`saldo_apos`, `acima_linha_apos`).

| Saldo (= acima da linha) | Reserva | Base do prêmio | 5%  | 15%   | 25%   |
|--------------------------|---------|----------------|-----|-------|-------|
| R$ 8.000                 | 2.400   | 5.600          | 280 | 840   | 1.400 |
| R$ 12.000                | 3.000   | 9.000          | 450 | 1.350 | 2.250 |

A reserva entra como saldo inicial do mês seguinte pelo fechamento do mês (abaixo).

## De onde vem a meta

Tabela Postgres `ven_meta_vendedor` (`rep_codigo`, `ano`, `mes`, `valor_meta`), cadastrada em
Carteirização. O mês dessa tabela já é o mês comissional, o mesmo da bolsa.

**Sem meta** (sem linha, `valor_meta` 0 ou leitura com erro): `atingimento` = null e o prêmio
cai no degrau mais baixo (5%).

## Configuração

- `ORCAMENTO_PREMIO_DEGRAUS` — escada `mínimo:taxa`, mínimo em fração da meta.
  Padrão: `0:0.05,1:0.15,1.10:0.25`. Entradas inválidas são ignoradas.
- `ORCAMENTO_PREMIO_DEGRAUS=` (vazio explícito, ou nada válido) desliga a escada e volta à taxa
  fixa `ORCAMENTO_PREMIO_PCT` (padrão 0,25), como era antes.
- `ORCAMENTO_RESERVA_PCT` — fração do saldo retido que fica de reserva. Padrão `0.30`; `0` = sem
  reserva (prêmio sobre o saldo inteiro). Limitado a 1.
- `ORCAMENTO_RESERVA_TETO` — teto da reserva em R$. Padrão `3000`; `0` = sem reserva.

## Campos novos em `GET /orcamento/vendedor/:rep/bolsa` (dentro de `bolsa`)

- `meta` — meta do mês em R$, ou null.
- `atingimento` / `atingimento_apos` — fração com 4 casas (1,0532 = 105,32%), hoje e com o
  orçamento em edição; null sem meta.
- `premio_pct` — taxa em vigor hoje (já existia; agora sai da escada).
- `premio_pct_apos` — taxa com o orçamento em edição: um orçamento que leva o vendedor a
  passar da meta muda só a taxa do "após".
- `premio_degraus` — a escada em vigor (`[{ minimo, pct }]`), ou null com a taxa fixa.
- `reserva` / `reserva_apos` — reserva do saldo retido para o mês seguinte, hoje e com o orçamento.
- `premio_base` / `premio_base_apos` — saldo retido − reserva: a base sobre a qual a taxa incide.
- `reserva_pct` / `reserva_teto` — parâmetros da reserva em vigor.

A bolsa do canal não tem prêmio e não muda.

## Fechamento e saldo inicial

No fim do mês comissional (26 → 25) o mês de cada vendedor do atacado (lista de
`GET /orcamento/vendedores`) é fechado e a reserva passa a ser o **saldo inicial** do mês seguinte:

    gerado      = bolsa do mês: receita − custo × piso + absorvido + ajuste − excedente
    saldo_final = saldo_inicial + gerado
    reserva     = saldo_final > 0 ? min(reserva_pct × saldo_final, reserva_teto)
                                  : reserva_pct × saldo_final        (negativo passa 30%, sem teto)
    premio_base = max(0, gerado_premio − reserva)
                  gerado_premio = receita − custo × linha − excedente   (= acima_linha do card)
    premio      = premio_pct × premio_base     (premio_pct pelo atingimento da meta do mês)

Exemplos sem promoção nem ajuste e com linha = piso (gerado = gerado_premio):

| Saldo inicial | Gerado  | Saldo final | Reserva (próx. mês) | Base do prêmio |
|---------------|---------|-------------|---------------------|----------------|
| 2.400         | 5.000   | 7.400       | 2.220               | 2.780          |
| −570          | 1.000   | 430         | 129                 | 871            |
| 2.400         | −1.000  | 1.400       | 420                 | 0              |
| 0             | −2.000  | −2.000      | −600                | 0              |

O mês é lido como o card lê (venda do BI, ajustes com NF no mês, promoção do portal, teto por
linha), sem orçamento em edição, com o piso em vigor na hora do fechamento (gravado em `piso`).
`fechamentoDaBolsa` e `reservaDoFechamento` em `src/orcamento/regua.ts`; `fecharMes` em
`orcamento.service.ts`.

**Card e fechamento usam a mesma conta:** carrega o saldo da bolsa (com absorvido e ajuste),
premia o lucro acima da linha menos a reserva. A única diferença é o saldo negativo: no card a
reserva fica 0; no fechamento 30% do negativo passa para o mês seguinte. Ex.: bolsa 6.000 com
1.000 absorvidos pela empresa → reserva 1.800, base 5.000 − 1.800 = 3.200.

### Tabela `ven_bolsa_mes`

SQL manual: `sql/2026-10-27_bolsa_mes_postgres.sql` (aplicar antes do deploy). Uma linha por
`(rep_codigo, ano, mes)` comissional: `saldo_inicial`, `gerado`, `saldo_final`, `reserva`, `meta`,
`atingimento`, `premio_pct`, `premio_base`, `premio`, `piso`, `fechado_em`, `fechado_por`,
`observacao`. Linha com `fechado_em` nulo = mês aberto, só com o saldo inicial que o fechamento
anterior criou. Sem a tabela, a bolsa sai com saldo inicial 0.

### Agendamento

`BolsaFechamentoScheduler` (`src/orcamento/bolsa-fechamento.scheduler.ts`), fuso America/Cuiaba:
dia 26, 00:30, fecha o mês comissional que terminou ontem, para todos. Não roda para mês anterior
ao início. Vendedor cuja leitura falhar fica sem linha (log de erro): refazer pelo endpoint com `rep`.

### Endpoints

- `POST /orcamento/bolsa/fechamento?ano&mes[&rep]` — só gestão de vendas (header `x-user-id` de
  supervisão, gerência ou direção; liberado no CORS). Fecha ou refaz o mês (todos ou só `rep`);
  `fechado_por` = nome do usuário do header (`agendamento` no cron). Reexecutar recalcula. Recusa
  (400) mês anterior ao início, mês ainda aberto e mês cujo seguinte já está fechado. Devolve
  `{ ano, mes, periodo, piso, linhas, falhas }`.
- `GET /orcamento/bolsa/fechamento?ano&mes[&rep]` — linhas do mês: `rep_codigo`, `rep_nome`, `ano`,
  `mes`, `saldo_inicial`, `gerado`, `saldo_final`, `reserva`, `meta`, `atingimento`, `premio_pct`,
  `premio_base`, `premio`, `piso`, `fechado_em`, `fechado_por`. Leitura sem exigir gestão: é o que a
  tela de comissões do RH lê (o mesmo dado que a tela de orçamento já mostra por vendedor).

### Campos novos em `bolsa` (`GET /orcamento/vendedor/:rep/bolsa`)

- `saldo_inicial` — reserva do fechamento anterior (0 sem fechamento).
- `gerado` / `gerado_apos` — a bolsa do mês sem o saldo inicial, hoje e com o orçamento.
- `saldo` / `saldo_apos` — agora saldo inicial + gerado.

### Configuração

- `ORCAMENTO_BOLSA_FECHAMENTO_DESDE` — 1º mês comissional fechado, `AAAA-MM`. Padrão `2026-11`.
- `ORCAMENTO_BOLSA_FECHAMENTO_CRON` — padrão `30 0 26 * *`; `off` desliga.
- A reserva usa `ORCAMENTO_RESERVA_PCT` e `ORCAMENTO_RESERVA_TETO` (acima).
