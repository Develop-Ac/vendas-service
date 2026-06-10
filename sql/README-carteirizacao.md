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

## 4. Carga inicial (seed)
Após subir o serviço, popular a carteira a partir do `rep_codigo` do ERP:

```
# simulação (não grava):
curl -X POST http://localhost:8000/carteirizacao/seed -H "Content-Type: application/json" -d '{"estrategia":"rep_codigo","dryRun":true}'

# aplicar:
curl -X POST http://localhost:8000/carteirizacao/seed -H "Content-Type: application/json" -d '{"estrategia":"rep_codigo"}'
```

Universo = clientes atacado (tabela de preço 2 e 5). ~433 clientes têm `rep_codigo` e serão carteirizados; os demais ficam "sem carteira" para distribuição manual na tela.

## 5. Endpoints (Fase 1)
- `GET  /carteirizacao/clientes` — lista paginada + filtros (status, rep_codigo, uf, busca, semVendedor, faturamentoMin/Max, ordenarPor, ordem, janelaDias).
- `GET  /carteirizacao/clientes/export` — CSV (mesmos filtros).
- `GET  /carteirizacao/vendedores` — vendedores do atacado + contagem da carteira.
- `POST /carteirizacao/atribuir` — `{cli_codigo, rep_codigo, motivo?}`.
- `POST /carteirizacao/atribuir-lote` — `{cli_codigos[], rep_codigo, motivo?}`.
- `POST /carteirizacao/transferir` — `{rep_origem, rep_destino, cli_codigos?[], motivo?}`.
- `DELETE /carteirizacao/cliente/:cli` — remove da carteira.
- `GET  /carteirizacao/cliente/:cli/historico`.

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
