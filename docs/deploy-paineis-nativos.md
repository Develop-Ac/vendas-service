# Deploy dos painéis nativos — passo a passo (08/10/2026)

Cinco repositórios, nada comitado. Ordem: banco → etl-worker → vendas-service → frontend → compras-service → pessoal-service. Um serviço por vez, fora do pico (o build do vendas-service, pessoal-service e etl-worker ainda roda na .144; frontend e compras-service vêm prontos do GHCR).

Rollback de qualquer tela = voltar a flag `PAINEL_FONTE_*` para `metabase` no EasyPanel do frontend e clicar Deploy (segundos, sem build).

## 0. Banco e permissão (antes de tudo)

| Onde | Arquivo | Efeito |
|---|---|---|
| SQL Server BI (login com ALTER VIEW; BI_AC não serve) | `vendas-service/sql/2026-10-07_bi_refresh_vw_orcamentos_sqlserver.sql` | só `sp_refreshview`; conserta 4 cards de orçamento que já estão quebrados hoje no Metabase |
| Postgres intranet (.144:5555/intranet) | `vendas-service/sql/2026-10-08_painel_layout.sql` | cria `ven_painel_layout` (edição do layout) |
| Sistema → Usuários | — | dar **editar** em Vendas a quem vai editar o layout do painel |

## 1. etl-worker (branch `deploy`, build no EasyPanel)

1. Commit `0.0.26` com tudo que está alterado (posCarga, rotina removida, `scripts/extrair-procs.js`, `sql/procs/` com 40 arquivos, `test/`, docs). Push.
2. EasyPanel → `etl-worker` → Variables: tirar `analise-vendas` de `ROTINAS_ATIVAS`; apagar `ROTINA_ANALISE_VENDAS_CRON`.
3. Deploy.
4. Conferir: tela `/sistema/etl` sem a rotina `analise-vendas`; na próxima carga `vendas` com delta, `f_analise_vendas` renova (no BI: `select max(dt_emissao_convertida) from dbo.f_analise_vendas`).

## 2. vendas-service (branch `main`, build no EasyPanel)

1. Commit `1.1.119` com tudo que está alterado (módulo `src/paineis/`, catálogos e SQLs dos cards, scripts, `prisma/schema.prisma`, `nest-cli.json`, `tsconfig.build.json`, `.env.example`, docs e os dois `sql/`). Push.
2. Deploy no EasyPanel (fora do pico; é build na .144).
3. Conferir de uma máquina da rede:
   ```bash
   curl -sk "https://vendas-service.acacessorios.local/paineis/vendedor?hub=ATACADO&vendedores=ALISSON" | head -c 300
   ```
   Esperado: JSON com `"painel":"vendedor"` e `cards`. Segunda chamada em até 60 s vem com `"cache":true`.

## 3. cotacao-frontend (branch `Deploy`, imagem no GHCR)

1. **Atenção ao commit:** `app/(private)/financeiro/contas-a-receber/_shared.tsx` (endereços do SPC) NÃO é desta entrega; comitar separado ou deixar de fora. O resto é tudo dos painéis: `components/paineis/`, `components/vendas/*`, `app/api/vendas/painel/**`, `app/api/compras/painel/route.ts`, `app/api/pessoal/dre-kpis/route.ts`, `lib/vendas/*`, `lib/compras/paineis.ts`, `app/(private)/vendas/**`, `app/(private)/usuario/page.tsx`, `app/(private)/pessoal/comissoes/representantes/page.tsx`, `__tests__/**`, `package.json` + `package-lock.json` (react-grid-layout), `.env.example`, e as remoções de `app/(private)/atacado/vendas/page.tsx` e `app/api/metabase-embed/`.
2. Commit `1.21.105` (ou o próximo número que você usar). Push na `Deploy`.
3. GitHub → Actions → "Imagem Docker (GHCR)" verde.
4. EasyPanel → `cotacao-frontend` → Variables: `PAINEL_FONTE_VENDAS=servico` (deixar `PAINEL_FONTE_COMPRAS` e `PAINEL_FONTE_DRE` ausentes ou `metabase` por enquanto).
5. Deploy.
6. Conferir em `/vendas` (F12 → Network): uma chamada a `/api/vendas/painel` por abertura e nenhuma a `painel/card`. Testar os quatro hubs trocando o hub do seu usuário. Testar "Editar layout" (precisa do SQL do passo 0 e de `editar` em Vendas).

## 4. compras-service (branch `main`, imagem no GHCR)

1. Commit `1.1.167` com tudo que está alterado (`src/paineis/`, scripts, `.gitignore`, `nest-cli.json`, `tsconfig.build.json`, `src/app.module.ts`). Push.
2. Actions verde → EasyPanel → `compras-service` → Deploy.
3. Conferir que a `DATABASE_URL` de produção do compras-service aponta para o Postgres oficial `.144:5555/intranet` (19 dos 22 cards de estoque leem esse banco).
4. Teste: `curl -sk https://compras-service.acacessorios.local/paineis/estoque | head -c 200` → 200 com 22 cards.
5. Frontend → Variables: `PAINEL_FONTE_COMPRAS=servico` → Deploy (só reinicia; não constrói).
6. Conferir `/compras/painel` e `/estoque/analise` com filtro de período e de fornecedor.

## 5. pessoal-service (branch `main`, build no EasyPanel)

1. Commit `0.3.7` com `src/paineis/`, `scripts/`, `nest-cli.json`, `package.json` (script `test`), `src/app.module.ts`, `.env.example`. (`CLAUDE.md` e `docs/agents` já estavam sem commit antes; são de outra entrega.) Push.
2. Deploy no EasyPanel (fora do pico).
3. Conferir que `PESSOAL_SERVICE_TOKEN` do frontend é igual ao `APP_TOKEN` do serviço (já era assim; só confirmar).
4. Frontend → Variables: `PAINEL_FONTE_DRE=servico` → Deploy.
5. Conferir os KPIs de pessoal no DRE. Os cards de comparação anual passam a mostrar o período pedido (antes mostravam o ano anterior).

## 6. Semana de comparação e encerramento

- Deixar as três flags em `servico` por uma semana; se algum número divergir do Metabase, voltar só aquela flag.
- Depois: arquivar no Metabase os dashboards 6, 7, 9, 10, 11, 12, 13, 14, 15, 19, 23 e 87 (cópias por vendedor e os do iframe); manter 5 e 18.
- Fase 1 (independente): no EasyPanel do Metabase, `JAVA_OPTS=-Xmx1g` e teto de memória 1,5 GB. O cache de consulta já está ligado.
