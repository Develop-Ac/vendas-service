# Ajuste da bolsa negativa (orçamento do atacado)

Produto avariado, usado ou com embalagem danificada entra pelo custo normal e só vende com desconto
extra, deixando a linha do orçamento negativa na bolsa do vendedor. Quem tem a permissão
`/vendas/orcamento/ajustar-bolsa` reduz o valor que sai da bolsa naquela linha — no máximo zera,
nunca fica positivo — com motivo e justificativa. O ajuste só entra na bolsa quando a NF (empresa 3)
sai, casada com o orçamento importado no Celta.

## Regras

- Por item (chave: orçamento + `pro_codigo`). Valor digitado em R$ = quanto da linha AINDA sai da
  bolsa, entre o negativo da linha (`(preço − custo_bolsa × piso) × qtd`, com a absorção da
  promoção já descontada) e 0. Guardado por unidade: `assumido_unit` (> 0, o que a empresa assume).
- Motivo: `AVARIADO | USADO | EMBALAGEM | OUTRO` + justificativa obrigatória (≥ 10 caracteres).
- Permissão: `sis_permissoes.tela = '/vendas/orcamento/ajustar-bolsa'` com editar ou criar,
  conferida no backend. Ninguém recebe no SQL de instalação.
- Não ajusta o próprio orçamento: recusado se o usuário for o `usuario_id` do orçamento ou se o
  `sis_usuarios.vendas_rep_codigo` dele for o `rep_codigo` do orçamento.
- Só com status RASCUNHO / ENVIADO / APROVACAO (antes do fechamento). Serviço não.
- O ajuste conta como aprovação quando o orçamento está dentro da alçada: grava `aprovado_por/em/codigo`
  = quem ajustou (vira USU_LIBEROU do bloqueio no Celta em vez do INTRANET-ORÇ). Acima da alçada NÃO
  aprova: a aprovação normal (permissões liberar-bloqueio + desconto-excedido) continua exigida.
- Vendedor marca `pedir_ajuste` no item; `enviar` manda para APROVACAO também quando há item com
  `pedir_ajuste` sem ajuste. Ajustar todos os pedidos de um orçamento em APROVACAO que não está
  acima da alçada leva a ENVIADO (igual ao `aprovar`).
- Editar os itens derruba os ajustes junto com a aprovação (mesma regra que já limpa `aprovado_*`).
- Motivo + justificativa entram na observação enviada ao Celta (orçamento e bloqueio), junto do
  texto de alçada.
- Só vale para orçamento importado no Celta (`celta_importado_em` preenchido).

## Casamento com a venda e efeito na bolsa

A view de vendas do BI não traz orçamento nem condicional, e o Celta quase nunca grava a NF no
orçamento. Ordem, por ajuste:

1. `ORCAMENTOS.NFS` preenchida → essa NF;
2. `ORCAMENTOS.CONDICIONAL` → `CONDICIONAIS.NFS` (tabela `condicionais` da erp-firebird-api; sem ela, só NF e janela);
3. primeira NF do mesmo cliente + produto + vendedor, emissão ≥ importação e ≤ importação + 30 dias,
   preço unitário ≥ o do orçamento − R$ 0,01.

A quantidade do ajuste é consumida por ordem de emissão; cada unidade recebe ajuste uma vez.
Efetivo da linha de NF = min(`assumido_unit` × qtd casada, negativo real da linha na NF) — negativo
real = `custo × piso − líquido` (na promoção, metade disso, pois a outra metade já é absorvida);
nunca < 0. Devolução do mesmo cliente + produto depois da venda casada estorna
`assumido_unit` × qtd devolvida (até a qtd casada), no mês da devolução. O efetivo entra como termo
à parte no saldo da bolsa (como `absorvido`), no mês comissional da NF.

Situação do ajuste: `AGUARDANDO_NF` (sem NF, dentro de 30 dias) · `APLICADO` (qtd toda casada) ·
`PARCIAL` (parte casada, janela vencida ou em aberto) · `EXPIRADO` (nada casado em 30 dias) ·
`SEM_CELTA` (orçamento não importado).

## Módulo puro `src/orcamento/ajuste-bolsa.ts`

```ts
export type MotivoAjuste = 'AVARIADO' | 'USADO' | 'EMBALAGEM' | 'OUTRO';
export interface NfChave { empresa: number; serie: string; nfs: number }

// validação da entrada da tela
export function validarAjuste(e: {
  negativo_linha: number;   // R$ da linha na bolsa, < 0
  valor: number;            // R$ que ainda sai da bolsa, digitado: negativo_linha ≤ valor ≤ 0
  quantidade: number;
  motivo: string; justificativa: string;
  proprio: boolean; servico: boolean;
}): { ok: true; assumido_unit: number } | { ok: false; erro: string };

export interface AjusteParaCasar {
  id: string; pro_codigo: number; cli_codigo: number; rep_codigo: number;
  quantidade: number; assumido_unit: number; preco_unit: number;
  importado_em: Date | null;
  nf_orcamento: NfChave | null;   // ORCAMENTOS.NFS
  nfs_condicional: NfChave[];     // do condicional vinculado
}
export interface LinhaNf extends NfChave {
  pro_codigo: number; cli_codigo: number; rep_codigo: number;
  emissao: Date; devolucao: boolean; quantidade: number; // sempre positiva
  preco_unit: number; liquido: number; custo: number;    // positivos
  promocao: boolean;
}
export type SituacaoAjuste = 'AGUARDANDO_NF' | 'APLICADO' | 'PARCIAL' | 'EXPIRADO' | 'SEM_CELTA';

export function casarAjustes(ajustes: AjusteParaCasar[], linhas: LinhaNf[], o: { piso: number; hoje: Date; janela_dias?: number }): {
  ajustes: { id: string; qtd_casada: number; efetivo: number; situacao: SituacaoAjuste;
             nfs: (NfChave & { emissao: Date; quantidade: number; efetivo: number; devolucao: boolean })[] }[];
  // efetivo por linha de NF (estorno de devolução negativo), para somar no mês comissional
  linhas: (NfChave & { pro_codigo: number; cli_codigo: number; rep_codigo: number; emissao: Date; efetivo: number })[];
};
```

## API (vendas-service, prefixo `/orcamento`)

- `PUT /orcamento/:id/ajuste-bolsa/:pro_codigo` body `{ usuario_id, usuario_nome?, valor, motivo, justificativa }`
  → orçamento completo (mesmo formato do `GET /orcamento/:id`). 403 sem permissão / próprio; 400 fora dos limites.
- `DELETE /orcamento/:id/ajuste-bolsa/:pro_codigo?usuario_id=` → orçamento completo.
- `GET /orcamento/:id` passa a trazer `ajustes_bolsa: { pro_codigo, quantidade, assumido_unit, valor, negativo_linha, motivo, justificativa, ajustado_por, ajustado_em }[]`
  e cada item traz `pedir_ajuste: boolean` (gravado pelo `PUT /orcamento/:id` / `POST /orcamento` junto com os itens).
- `GET /orcamento/vendedor/:rep/bolsa` aceita `ajuste_orc` (R$ que a empresa assume no orçamento em edição, ≥ 0)
  e devolve `bolsa.ajuste_mtd` (efetivo do mês); o saldo já inclui os dois.
- `GET /orcamento/ajustes-bolsa?de=YYYY-MM-DD&ate=&rep=&ajustador=&motivo=&pro=` →
  `{ itens: { id, orcamento_id, orcamento_numero, celta_orcamento, cli_codigo, cli_nome, rep_codigo, rep_nome,
  pro_codigo, descricao, quantidade, valor_ajustado, efetivo, situacao, motivo, justificativa, ajustado_por,
  ajustado_em, nfs: {serie, nfs, emissao, quantidade, efetivo, devolucao}[] }[], totais: { ajustado, efetivo } }`.
  `valor_ajustado` = `assumido_unit × quantidade`. Período pela data do ajuste.

## Banco

SQL manual `sql/2026-09-30_ajuste_bolsa_postgres.sql` (nunca migration): tabela `ven_bolsa_ajuste`
(único por `orcamento_id + pro_codigo`, FK cascade para `ven_orcamento`) e coluna
`ven_orcamento_item.pedir_ajuste boolean not null default false`.
