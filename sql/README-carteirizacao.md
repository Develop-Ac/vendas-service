# Carteirização — passos de implantação

Feature: gestão de carteira de clientes (atacado) por vendedor.
Backend: módulo `carteirizacao` (`src/carteirizacao`). Leitura no SQL Server BI, escrita no PostgreSQL próprio.

## 1. Banco (PostgreSQL — aplicar manualmente)
Rodar o DDL no banco do vendas-service:

```
psql "$DATABASE_URL" -f sql/carteirizacao_postgres.sql
```

Cria: `ven_carteira_cliente`, `ven_carteira_historico`, `ven_carteira_vendedor_config`, `ven_meta_vendedor`.
> Não usar `prisma migrate`. O `schema.prisma` já reflete essas tabelas (para o Prisma Client).
> O arquivo é idempotente (IF NOT EXISTS) — re-rodar após a Fase 3 só cria a tabela nova `ven_meta_vendedor`.

## 2. Variáveis de ambiente
Adicionar ao `.env` (ver `.env.example`):

```
BI_SQL_SERVER=192.168.1.146
BI_SQL_DATABASE=BI
BI_SQL_USER=BI_READ_ONLY
BI_SQL_PASSWORD=********
BI_SQL_PORT=1433
```

A conexão ao BI é preguiçosa: se o BI estiver fora no boot, o serviço sobe e reconecta sob demanda.

## 3. Build / generate
```
npm install
npx prisma generate
npm run build
```

## 4. Carga / sincronização com o ERP (fonte da verdade)
A carteira é mantida **automaticamente pelo ERP**: o `rep_codigo` do cadastro é a fonte da verdade.
A sincronização lê a base atacado, compara com o overlay e aplica as diferenças (trocas de
vendedor, novos clientes), gravando histórico. Substitui o antigo `seed` para manutenção contínua.

```
# simulação (não grava) — mostra novos/alterados/sem_vendedor/revisao:
curl -X POST http://localhost:8000/carteirizacao/sincronizar -H "Content-Type: application/json" -d '{"dryRun":true}'

# aplicar:
curl -X POST http://localhost:8000/carteirizacao/sincronizar -H "Content-Type: application/json" -d '{}'
```

Regras da reconciliação (ERP sempre vence):
- ERP tem rep e overlay diverge/ausente → atribui/atualiza (`ATRIBUICAO`/`ALTERACAO`).
- ERP sem rep (cliente segue no atacado) → zera vendedor (`REMOCAO`).
- Cliente saiu do atacado (sumiu da base 2/5) → fica sem vendedor + `revisao=1` (`REVISAO`),
  aguardando confirmação manual da exclusão.

Universo = clientes atacado (tabela de preço 2 e 5). Inativação: 60 dias sem compra; 45 dias = risco.

### Carga diária automática
Cron interno (`@nestjs/schedule`), padrão 05:00 (fuso America/Sao_Paulo). Configurável por
`CARTEIRIZACAO_SYNC_CRON` no `.env` (formato cron de 5 campos).

## 5. Endpoints (carteira — intranet somente-leitura)
A atribuição/movimentação **manual foi desabilitada**. Restam consulta, histórico e a sincronização.
- `GET  /carteirizacao/clientes` — lista paginada + filtros (status, rep_codigo, uf, busca, semVendedor, risco, revisao, faturamentoMin/Max, ordenarPor, ordem, janelaDias).
- `GET  /carteirizacao/clientes/export` — CSV (mesmos filtros).
- `GET  /carteirizacao/vendedores` — vendedores do atacado + contagem da carteira.
- `GET  /carteirizacao/cliente/:cli/historico`.
- `POST /carteirizacao/sincronizar` — `{dryRun?}` carga/reconciliação com o ERP.
- `POST /carteirizacao/cliente/:cli/confirmar-exclusao` — confirma exclusão de cliente em revisão (única escrita manual).

## Endpoints (Fase 2 — acompanhamento)
- `GET /carteirizacao/indicadores/vendedores` · `GET /carteirizacao/indicadores/cliente/:cli`
- `GET /carteirizacao/alertas`
- `GET/PUT /carteirizacao/vendedores/:rep/config` · `POST /carteirizacao/redistribuir`

## Endpoints (Fase 3 — inteligência / metas)
- Score do cliente (0-100, RFM+margem) e curva ABC vêm embutidos em `GET /carteirizacao/clientes` (campos `score`, `score_faixa`, `curva_abc`, `margem_pct`).
- `GET /carteirizacao/metas?ano&mes` — metas x realizado por vendedor (todos os vendedores ativos das comissões; meta = override Postgres > `f_metas_vendedores` do DW).
- `PUT /carteirizacao/metas/:rep` — define/override meta `{ ano, mes, valor_meta, observacao? }` (gerencial).

> Telas/permissões: `/vendas/carteirizacao` (Clientes), `/vendas/carteirizacao/vendedores`, `/vendas/carteirizacao/alertas`, `/vendas/carteirizacao/metas` (gerencial). As abas são gateadas por permissão exata.

## Frontend
Tela em `cotacao-frontend/app/(private)/vendas/carteirizacao/page.tsx` (menu Vendas → Carteirização).
Requer `NEXT_PUBLIC_VENDAS_SERVICE_BASE` apontando para este serviço.
