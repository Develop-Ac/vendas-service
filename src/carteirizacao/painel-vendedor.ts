/**
 * Regras do painel do vendedor do atacado (tela inicial): período do mês
 * comissional e meta do vendedor. Funções puras com as mesmas contas da
 * gestão (`gestao.ts`), para os números baterem com /vendas/atacado.
 */
import { Veredito, contarDias, ritmoNecessario, ritmoPrevisao, veredito } from './gestao';
import { pct } from './supervisao.indicadores';
import type { ClienteCarteira } from './carteirizacao.service';
import type { OrcamentoSemDesfecho } from './carteirizacao.erp.repository';
import type { ProdutoOrcamento } from '../orcamento/orcamento.service';
import { foraDaBolsa } from '../oferta/oferta';

export function blocoPeriodo(p: { inicio: string; fim: string; diasUteis: string[]; hoje: string }) {
  const dias = contarDias(p.diasUteis, p.inicio, p.fim, p.hoje);
  return {
    inicio: p.inicio,
    fim: p.fim,
    dias_uteis_total: dias.total,
    dias_uteis_fechados: dias.fechados,
    dias_uteis_restantes: dias.restantes,
    hoje_dia_util: p.diasUteis.includes(p.hoje),
  };
}

/** Meta do vendedor: faturado = soma da série por dia (aaaa-mm-dd); o dia de hoje entra só no faturado. */
export function blocoMeta(p: {
  meta: number;
  serie: Array<{ dia: string; valor: number }>;
  diasUteis: string[];
  inicio: string;
  fim: string;
  hoje: string;
}) {
  const { meta, serie, diasUteis, inicio, fim, hoje } = p;
  const dias = contarDias(diasUteis, inicio, fim, hoje);
  const faturado = serie.reduce((s, d) => s + d.valor, 0);
  const ate_ontem = serie.filter((d) => d.dia < hoje).reduce((s, d) => s + d.valor, 0);
  const venda_hoje = faturado - ate_ontem;
  const { ritmo, previsao } = ritmoPrevisao({ faturado, faturado_hoje: venda_hoje, dias, encerrado: hoje > fim });
  const meta_dia = dias.total > 0 ? meta / dias.total : null;
  const porDia = new Map(serie.map((d) => [d.dia, d.valor]));
  return {
    sem_meta: false as const,
    meta,
    faturado,
    atingimento: pct(faturado, meta),
    falta: Math.max(0, meta - faturado),
    precisa_dia: ritmoNecessario(meta, faturado, dias.restantes),
    ritmo,
    previsao,
    previsao_pct: previsao == null ? null : pct(previsao, meta),
    // Sem piso por vendedor: o veredito nunca é ABAIXO_DO_PISO.
    veredito: veredito(previsao, meta) as Exclude<Veredito, 'ABAIXO_DO_PISO'> | null,
    venda_hoje,
    meta_dia,
    serie: diasUteis
      .filter((d) => d >= inicio && d <= fim && d <= hoje)
      .map((dia) => {
        const valor = porDia.get(dia) ?? 0;
        return { dia, valor, bateu: meta_dia != null && valor >= meta_dia };
      }),
  };
}

/** Auxiliar não tem meta própria: mostra só o valor fechado no mês. */
export function blocoMetaAuxiliar(fechado: number) {
  return { sem_meta: true as const, fechado_mes: fechado };
}

const DIA_MS = 86_400_000;
const diasEntre = (de: Date, ate: Date) => Math.round((ate.getTime() - de.getTime()) / DIA_MS);

/**
 * Orçamentos para retornar, nesta ordem e sem repetir: adiados com retorno hoje ou
 * atrasado (RETORNO), enviados que vencem em até 2 dias (VENCE) e os sem desfecho.
 * `hoje` é a coluna DATE do dia de Cuiabá. Sem desfecho do Celta não tem id (não abre
 * na intranet); o bloco `sem_desfecho` leva a chave para apontar o motivo de perda.
 */
export function montarRetornar(p: {
  intranet: Array<{
    id: string;
    numero: number;
    cli_codigo: number;
    cli_nome: string | null;
    total: number;
    status: string;
    retorno_em: Date | null;
    validade: Date | null;
  }>;
  semDesfecho: Array<OrcamentoSemDesfecho & { rep_nome?: string | null }>;
  fonePorCliente: Map<number, string | null>;
  hoje: Date;
}) {
  const { intranet, semDesfecho, fonePorCliente, hoje } = p;
  const daIntranet = (o: (typeof intranet)[number], motivo: 'RETORNO' | 'VENCE', data: Date) => ({
    id: o.id as string | null,
    numero: o.numero,
    cli_codigo: o.cli_codigo,
    cli_nome: o.cli_nome,
    fone: fonePorCliente.get(o.cli_codigo) ?? null,
    total: o.total,
    motivo,
    data,
    // RETORNO: dias de atraso; VENCE: dias até vencer.
    dias: motivo === 'RETORNO' ? diasEntre(data, hoje) : diasEntre(hoje, data),
  });
  const retorno = intranet
    .filter((o) => o.status === 'ADIADO' && o.retorno_em != null && o.retorno_em <= hoje)
    .sort((a, b) => a.retorno_em!.getTime() - b.retorno_em!.getTime())
    .map((o) => daIntranet(o, 'RETORNO', o.retorno_em!));
  const vence = intranet
    .filter((o) => o.status === 'ENVIADO' && o.validade != null)
    .sort((a, b) => a.validade!.getTime() - b.validade!.getTime())
    .map((o) => daIntranet(o, 'VENCE', o.validade!));
  const jaListados = new Set([...retorno, ...vence].map((o) => o.id));
  const sem = semDesfecho
    .filter((s) => s.intranet_id == null || !jaListados.has(s.intranet_id))
    .map((s) => ({
      id: s.intranet_id,
      numero: s.numero_intranet ?? s.orcamento,
      cli_codigo: s.cli_codigo,
      cli_nome: s.cli_nome,
      fone: fonePorCliente.get(s.cli_codigo) ?? null,
      total: s.total,
      motivo: 'SEM_DESFECHO' as const,
      data: s.emissao,
      dias: s.dias_desde_emissao,
      sem_desfecho: {
        orcamento: s.orcamento,
        origem: s.origem,
        intranet_id: s.intranet_id,
        numero_intranet: s.numero_intranet,
        emissao: s.emissao,
        rep_codigo: s.rep_codigo,
        rep_nome: s.rep_nome ?? null,
        dias_desde_emissao: s.dias_desde_emissao,
      },
    }));
  return [...retorno, ...vence, ...sem];
}

const ORDEM_CURVA = { A: 0, B: 1, C: 2 } as const;

/**
 * Carteira para atacar: quatro situações, cada uma com a contagem e os 5 primeiros
 * (curva A antes de B, depois quem mais comprava em 12 meses). Cliente em
 * `foraDaLista` (já nos contatos de hoje) conta no total mas não entra nos 5.
 * Item montado campo a campo: o ClienteCarteira traz margem e lucro.
 */
export function montarCarteira(p: { clientes: ClienteCarteira[]; rep: number; inicioMes: string; foraDaLista: Set<number> }) {
  const doRep = p.clientes
    .filter((c) => c.rep_codigo === p.rep)
    .sort((a, b) => ORDEM_CURVA[a.curva_abc] - ORDEM_CURVA[b.curva_abc] || b.faturamento_12m - a.faturamento_12m);
  const situacao = (regra: (c: ClienteCarteira) => boolean) => {
    const todos = doRep.filter(regra);
    return {
      total: todos.length,
      clientes: todos
        .filter((c) => !p.foraDaLista.has(c.cli_codigo))
        .slice(0, 5)
        .map((c) => ({
          cli_codigo: c.cli_codigo,
          cli_nome: c.cli_nome,
          curva: c.curva_abc,
          fone: c.fone,
          dias_sem_compra: c.dias_sem_compra,
          data_ult_compra: c.data_ult_compra,
          faturamento_3m: c.faturamento_3m,
        })),
    };
  };
  return {
    em_risco: situacao((c) => c.status === 'ATIVO' && c.risco_inativacao),
    perda_silenciosa: situacao((c) => c.quadrante === 'PERDA_SILENCIOSA'),
    inativos: situacao((c) => c.status === 'INATIVO'),
    // data_ult_compra é coluna DATE (meia-noite UTC): compara o dia em texto, sem fuso.
    sem_compra_mes: situacao(
      (c) => c.status === 'ATIVO' && (c.data_ult_compra == null || new Date(c.data_ult_compra).toISOString().slice(0, 10) < p.inicioMes),
    ),
  };
}

/**
 * Ofertas do atacado para o vendedor: `ganho` = liquidação e campanha (fora da bolsa,
 * pagam prêmio por unidade), maior ganho primeiro e, no empate, a que acaba antes;
 * `promocoes` = promoção, a que acaba antes primeiro. Entra a lista da tabela 2 e a da
 * tabela 5 (`produtosEmOferta`); item que só vale numa delas fica com o outro preço nulo.
 * Item montado campo a campo: o ProdutoOrcamento traz custo, custo da bolsa e a régua.
 */
export function montarOfertas(tabela2: ProdutoOrcamento[], tabela5: ProdutoOrcamento[]) {
  const t2 = new Map(tabela2.map((p) => [p.pro_codigo, p]));
  const t5 = new Map(tabela5.map((p) => [p.pro_codigo, p]));
  const itens = [...new Set([...t2.keys(), ...t5.keys()])].map((codigo) => {
    const p = (t2.get(codigo) ?? t5.get(codigo))!;
    const o = p.promocao!;
    const ganho = foraDaBolsa(o.tipo);
    return {
      pro_codigo: codigo,
      descricao: p.descricao,
      tipo: o.tipo ?? 'PROMOCAO',
      preco_atacado: t2.get(codigo)?.preco_tabela ?? null,
      preco_especial: t5.get(codigo)?.preco_tabela ?? null,
      ganho_unit: ganho ? (o.ganho_unit ?? null) : null,
      proxima_faixa: ganho ? (o.proxima_faixa ?? null) : null,
      restam: o.restam ?? null,
      limite_cliente: o.limite_cliente ?? null,
      fim: o.data_final,
    };
  });
  const porFim = (a: { fim: string }, b: { fim: string }) => a.fim.localeCompare(b.fim);
  return {
    ganho: itens
      .filter((i) => foraDaBolsa(i.tipo) && i.ganho_unit != null)
      .sort((a, b) => b.ganho_unit! - a.ganho_unit! || porFim(a, b)),
    promocoes: itens.filter((i) => i.tipo === 'PROMOCAO').sort(porFim),
  };
}

const PROIBIDA = /custo|markup|margem|lucr/i;

/** Chaves (em qualquer nível) que expõem custo, markup, margem ou lucro: a resposta do vendedor não pode ter nenhuma. */
export function chavesProibidas(obj: unknown): string[] {
  if (obj == null || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap(chavesProibidas);
  return Object.entries(obj).flatMap(([k, v]) => [...(PROIBIDA.test(k) ? [k] : []), ...chavesProibidas(v)]);
}
