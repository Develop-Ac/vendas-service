# vendas-service

API NestJS + Prisma (Postgres) do módulo de vendas da intranet da AC Acessórios:
orçamento do atacado, bloqueio/comprovante, tributação interestadual (DIFAL/ST),
integração com o ERP Celta via api-vendas. Specs em `docs/`, DDL manual em `sql/`.

Regras que valem aqui: nunca rodar migrations, entregar SQL para aplicação manual.
Nunca comitar; o commit é do usuário.

## Agent skills

### Issue tracker

Trello, quadros Sprint Back Log e Sprint (cartão `Módulo: descrição`). See `docs/agents/issue-tracker.md`.

### Triage labels

Listas do Trello carregam o estado; só `needs-info` e `ready-for-agent` são etiquetas. See `docs/agents/triage-labels.md`.

### Domain docs

single-context: `CONTEXT.md` na raiz e ADRs em `docs/adr/`. See `docs/agents/domain.md`.
