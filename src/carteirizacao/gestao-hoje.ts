/**
 * Listas de clientes da tela inicial do gestor do atacado (GET gestao/hoje):
 * recuperação A/B, curva A sem compra no mês e clientes em risco. Funções puras;
 * o item é montado campo a campo para custo, margem e lucro do `ClienteCarteira`
 * nunca saírem na resposta.
 */
import { BadRequestException } from '@nestjs/common';
import { REP_DISPONIVEL, RESGATE_DIAS, type ClienteCarteira } from './carteirizacao.service';
import { montarRetornar } from './painel-vendedor';

/** Teto de itens por lista; `total` e `valor_total` são sempre da lista inteira. */
export const TETO = 200;

export function lista<T>(itens: T[], valor: (i: T) => number) {
  return { total: itens.length, valor_total: itens.reduce((s, i) => s + valor(i), 0), itens: itens.slice(0, TETO) };
}

type Curva = ClienteCarteira['curva_abc'];

/**
 * Campos comuns de cliente; rep nulo = "Sem vendedor" (fora da carteira ou no pool de
 * disponíveis). `compra_mes` = faturamento_12m / 12.
 */
function itemCliente(
  c: ClienteCarteira | undefined,
  base: { cli_codigo: number; cli_nome: string | null; rep_codigo: number | null; rep_nome: string | null },
) {
  const semVendedor = base.rep_codigo === REP_DISPONIVEL;
  return {
    cli_codigo: base.cli_codigo,
    cli_nome: c?.cli_nome ?? base.cli_nome,
    rep_codigo: semVendedor ? null : base.rep_codigo,
    rep_nome: semVendedor ? null : base.rep_nome,
    dias_sem_compra: c?.dias_sem_compra ?? null,
    fone: c?.fone ?? null,
    compra_mes: (c?.faturamento_12m ?? 0) / 12,
  };
}

const porCliente = (clientes: ClienteCarteira[]) => new Map(clientes.map((c) => [c.cli_codigo, c]));
const compraMes = <T extends { compra_mes: number }>(i: T) => i.compra_mes;
const ehAB = (curva: string | null | undefined): curva is 'A' | 'B' => curva === 'A' || curva === 'B';

/**
 * Clientes A/B ativos, em carteira de vendedor, que passaram do prazo de resgate da curva
 * (RESGATE_DIAS: A 30 d, B 45 d) sem comprar, mais dias sem comprar primeiro. Orçamento e
 * mensagem recentes NÃO tiram o cliente desta lista: a esteira de resgate e o prêmio seguem
 * exigindo os três sinais, mas o gestor precisa ver quem parou de comprar e está só em
 * negociação (`dias_sem_orcamento` vai junto). `estagio` = episódio aberto na esteira
 * (linhas de `resgatesAbertos()`, só leitura), null sem episódio. `fechados`/`recuperados`
 * vêm do detalhe do KPI RECUPERACAO_AB_PCT.
 */
export function montarRecuperacao(p: {
  abertos: Array<{ cli_codigo: number; estagio: string }>;
  clientes: ClienteCarteira[];
  detalhe: { fechados?: number | null; recuperados?: number | null } | null | undefined;
}) {
  const estagio = new Map(p.abertos.map((r) => [r.cli_codigo, r.estagio]));
  const itens = p.clientes
    .filter((c) => {
      const limite = RESGATE_DIAS[c.curva_abc];
      return (
        limite != null &&
        c.status === 'ATIVO' &&
        c.em_carteira &&
        c.rep_codigo != null &&
        c.rep_codigo !== REP_DISPONIVEL &&
        !c.revisao &&
        c.dias_sem_compra != null &&
        c.dias_sem_compra >= limite
      );
    })
    .map((c) => ({
      ...itemCliente(c, c),
      curva: c.curva_abc as 'A' | 'B',
      estagio: estagio.get(c.cli_codigo) ?? null,
      dias_sem_orcamento: c.dias_sem_orcamento,
    }))
    .sort((a, b) => (b.dias_sem_compra ?? -1) - (a.dias_sem_compra ?? -1));
  return { ...lista(itens, compraMes), fechados: p.detalhe?.fechados ?? 0, recuperados: p.detalhe?.recuperados ?? 0 };
}

/**
 * Curva A sem faturamento no mês (mesma base do KPI CURVA_A_COMPRANDO_PCT), maior
 * faturamento_12m primeiro.
 */
export function montarCurvaASemCompra(p: { clientes: ClienteCarteira[]; faturamento: Map<number, number> }) {
  const base = p.clientes.filter((c) => c.curva_abc === 'A');
  const semCompra = base.filter((c) => !((p.faturamento.get(c.cli_codigo) ?? 0) > 0));
  const itens = semCompra
    .sort((a, b) => b.faturamento_12m - a.faturamento_12m)
    .map((c) => ({ ...itemCliente(c, c), cidade: c.cidade }));
  return { ...lista(itens, compraMes), curva_a: base.length, comprando: base.length - semCompra.length };
}

/**
 * Clientes em risco sem repetir: resgate escalado prevalece; depois os fora do ciclo
 * de compra (serviço de análise) que estão na carteira e são curva A/B. `ciclo` nulo
 * (serviço fora) = só escalados. Maior compra por mês primeiro.
 */
export function montarEmRisco(p: {
  clientes: ClienteCarteira[];
  ciclo: Array<{ cli: number; dias_sem_compra: number | null; intervalo_dias: number | null }> | null;
  escaladas: Array<{ cli_codigo: number; cli_nome: string | null; rep_codigo: number | null; rep_nome: string | null; curva: string | null }>;
}) {
  const mapa = porCliente(p.clientes);
  const vistos = new Set<number>();
  const itens: Array<
    ReturnType<typeof itemCliente> & { curva: Curva; motivo: 'FORA_DO_CICLO' | 'ESCALADO'; cidade: string | null; intervalo_dias: number | null }
  > = [];
  for (const t of p.escaladas) {
    if (vistos.has(t.cli_codigo)) continue;
    vistos.add(t.cli_codigo);
    const c = mapa.get(t.cli_codigo);
    itens.push({
      ...itemCliente(c, c ?? t),
      curva: (c?.curva_abc ?? t.curva ?? 'C') as Curva,
      motivo: 'ESCALADO',
      cidade: c?.cidade ?? null,
      intervalo_dias: null,
    });
  }
  for (const a of p.ciclo ?? []) {
    const c = mapa.get(a.cli);
    if (!c?.em_carteira || vistos.has(a.cli) || !ehAB(c.curva_abc)) continue;
    vistos.add(a.cli);
    itens.push({
      ...itemCliente(c, c),
      dias_sem_compra: c.dias_sem_compra ?? a.dias_sem_compra,
      curva: c.curva_abc,
      motivo: 'FORA_DO_CICLO',
      cidade: c.cidade,
      intervalo_dias: a.intervalo_dias,
    });
  }
  return lista(
    itens.sort((a, b) => b.compra_mes - a.compra_mes),
    compraMes,
  );
}

/**
 * Orçamentos para retornar da equipe toda (RETORNO, VENCE e SEM_DESFECHO, sem repetir,
 * pela mesma regra do painel do vendedor), com o vendedor de cada um, maior total
 * primeiro. A ordem por data de `montarRetornar` fica para o painel do vendedor.
 */
export function montarOrcamentosEquipe(p: {
  intranet: Array<Parameters<typeof montarRetornar>[0]['intranet'][number] & { rep_codigo: number | null; rep_nome: string | null }>;
  semDesfecho: Parameters<typeof montarRetornar>[0]['semDesfecho'];
  hoje: Date;
}) {
  const doVendedor = new Map(p.intranet.map((o) => [o.id, o]));
  const itens = montarRetornar({ ...p, fonePorCliente: new Map() })
    .map((o) => {
      const rep = 'sem_desfecho' in o ? o.sem_desfecho : doVendedor.get(o.id as string);
      return {
        id: o.id,
        numero: o.numero,
        cli_codigo: o.cli_codigo,
        cli_nome: o.cli_nome,
        rep_codigo: rep?.rep_codigo ?? null,
        rep_nome: rep?.rep_nome ?? null,
        total: o.total,
        motivo: o.motivo,
        dias: o.dias,
      };
    })
    .sort((a, b) => b.total - a.total);
  return lista(itens, (o) => o.total);
}

/** Resumo dos perdidos do mês (saída de `resumirMotivosPerda`): só o principal motivo, sem a lista. */
export function resumoPerdidos(r: { mes: string; quantidade: number; valor: number; motivos: Array<{ motivo: string; pct: number | null }> }) {
  return {
    mes: r.mes,
    quantidade: r.quantidade,
    valor: r.valor,
    principal_motivo: r.motivos[0]?.motivo ?? null,
    pct: r.motivos[0]?.pct ?? null,
  };
}

/**
 * Comissão do período pela consulta do card 420: a linha TOTAL GERAL (mix 99). A
 * consulta devolve detalhe + subtotal por mix + total geral; somar tudo triplica.
 */
export function totalComissao(colunas: Array<{ name: string }>, linhas: unknown[][]): number | null {
  const iMix = colunas.findIndex((c) => c.name === 'mix');
  const iValor = colunas.findIndex((c) => c.name === 'valor_comissao');
  const geral = linhas.find((l) => Number(l[iMix]) === 99);
  const v = geral?.[iValor];
  return v == null ? null : Number(v);
}

/** Só a supervisão do atacado vê comissão (testa o hub: admin com outro hub e gerência ficam de fora). */
export const recebeComissao = (u: { vendas_hub_inicial?: string | null }) =>
  (u.vendas_hub_inicial ?? '').toUpperCase() === 'SUPERVISAO_ATACADO';

const CANAIS_AVISO = ['badge', 'whatsapp'] as const;
type CanalAviso = (typeof CANAIS_AVISO)[number];

/**
 * Corpo do POST gestao/avisar-vendedor (sem ValidationPipe global: validação aqui).
 * Link só interno (começa com "/" e não com "//" nem tem "\", que o navegador lê como
 * "/"), para o aviso não levar a outro site.
 */
export function validarAviso(corpo: unknown): { rep_codigo: number; texto: string; canais: CanalAviso[]; link?: string } {
  const b = (corpo ?? {}) as Record<string, unknown>;
  const rep = Number(b.rep_codigo);
  if (b.rep_codigo == null || b.rep_codigo === '' || !Number.isInteger(rep)) throw new BadRequestException('Informe o vendedor (rep_codigo).');
  const texto = typeof b.texto === 'string' ? b.texto.trim() : '';
  if (!texto || texto.length > 500) throw new BadRequestException('O aviso precisa ter de 1 a 500 caracteres.');
  const canais = b.canais;
  if (
    !Array.isArray(canais) ||
    !canais.length ||
    new Set(canais).size !== canais.length ||
    !canais.every((c) => (CANAIS_AVISO as readonly unknown[]).includes(c))
  )
    throw new BadRequestException('Escolha o canal do aviso: badge e/ou whatsapp, sem repetir.');
  const link = b.link == null || b.link === '' ? undefined : b.link;
  if (link !== undefined && (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || link.includes('\\')))
    throw new BadRequestException('Link do aviso precisa ser uma tela da intranet (começa com /).');
  return { rep_codigo: rep, texto, canais: canais as CanalAviso[], link };
}
