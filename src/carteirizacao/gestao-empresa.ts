/**
 * Tela inicial da gerência (GET gestao/empresa): vendedores, canais, empresa, kpis e série
 * diária da empresa toda, todos os canais. Funções puras sobre a venda por vendedor e dia;
 * previsão e veredito são as mesmas da gestão do atacado (`gestao.ts`), sem piso.
 *
 * Meta, universo, nome e inativo seguem a regra do quadro Meta & Performance
 * (`CarteirizacaoService.metasVendedores`): meta manual > DW > 0; universo = ativos da
 * comissão + quem tem meta + quem vendeu; inativo sai da lista e continua nos totais.
 */
import { type Dias, ritmoNecessario, ritmoPrevisao, veredito } from './gestao';
import { pct } from './supervisao.indicadores';

export type Canal = 'atacado' | 'varejo' | 'servico' | 'outros';
export type VereditoSimples = 'VAI_BATER' | 'EM_RISCO' | 'NAO_BATE' | null;

const CANAIS: Canal[] = ['atacado', 'varejo', 'servico', 'outros'];

/** Canal pelo papel na comissão; papel desconhecido, vazio ou rep sem cadastro = outros. */
export function canalDoPapel(papel: string | null | undefined): Canal {
  switch ((papel ?? '').trim().toUpperCase()) {
    case 'VENDEDOR_ATACADO':
      return 'atacado';
    case 'VENDEDOR':
      return 'varejo';
    case 'TECNICO':
      return 'servico';
    default:
      return 'outros';
  }
}

export interface LinhaVendaDia {
  rep: number | null;
  dia: string;
  nome: string | null;
  venda: number;
  custo: number;
  lucro: number;
  notas: number;
}

export function montarEmpresa(p: {
  linhas: LinhaVendaDia[];
  metasManuais: Array<{ rep_codigo: number; valor_meta: number }>;
  metasDw: Array<{ cod_vendedor: number; vendedor: string | null; valor_total: number }>;
  papeis: Array<{ rep_codigo: number; papel: string | null; inativo: boolean | number | null }>;
  ativos: Array<{ rep_codigo: number; nome: string }>;
  dias: Dias;
  encerrado: boolean;
  hoje: string;
}) {
  const { dias, encerrado, hoje } = p;
  const hojeConta = (dia: string) => !encerrado && dia === hoje;

  // Previsão, veredito e atingimento sobre uma soma (vendedor, canal ou empresa).
  const situacao = (meta: number, faturado: number, faturado_hoje: number) => {
    const { ritmo, previsao } = ritmoPrevisao({ faturado, faturado_hoje, dias, encerrado });
    return {
      meta,
      faturado,
      faturado_hoje,
      ritmo,
      previsao,
      atingimento: pct(faturado, meta),
      veredito: veredito(previsao, meta) as VereditoSimples,
    };
  };

  const porRep = new Map<number, { nome: string | null; venda: number; hoje: number; custo: number; lucro: number }>();
  const semVendedor = { venda: 0, hoje: 0 };
  const porDia = new Map<string, Record<Canal, number>>();
  const papelMap = new Map(p.papeis.map((x) => [Number(x.rep_codigo), x.papel ?? null]));
  const canalDoRep = (rep: number | null) => (rep == null ? 'outros' : canalDoPapel(papelMap.get(rep)));
  let custo = 0;
  let lucro = 0;
  let notas = 0;

  for (const l of p.linhas) {
    custo += l.custo;
    lucro += l.lucro;
    notas += l.notas;
    const dia = porDia.get(l.dia) ?? { atacado: 0, varejo: 0, servico: 0, outros: 0 };
    dia[canalDoRep(l.rep)] += l.venda;
    porDia.set(l.dia, dia);
    if (l.rep == null) {
      semVendedor.venda += l.venda;
      if (hojeConta(l.dia)) semVendedor.hoje += l.venda;
      continue;
    }
    const r = porRep.get(l.rep) ?? { nome: null, venda: 0, hoje: 0, custo: 0, lucro: 0 };
    r.nome = r.nome ?? (l.nome?.trim() ? l.nome.trim().toUpperCase() : null);
    r.venda += l.venda;
    r.custo += l.custo;
    r.lucro += l.lucro;
    if (hojeConta(l.dia)) r.hoje += l.venda;
    porRep.set(l.rep, r);
  }

  const manual = new Map(p.metasManuais.map((x) => [x.rep_codigo, Number(x.valor_meta)]));
  const dw = new Map(p.metasDw.map((x) => [x.cod_vendedor, x]));
  const nomeAtivo = new Map(p.ativos.map((x) => [x.rep_codigo, x.nome]));
  const inativos = new Set(p.papeis.filter((x) => !!x.inativo).map((x) => Number(x.rep_codigo)));
  const codigos = new Set<number>([
    ...p.ativos.map((x) => x.rep_codigo),
    ...p.metasDw.map((x) => x.cod_vendedor),
    ...p.metasManuais.map((x) => x.rep_codigo),
    // Todo rep com linha no mês, inclusive venda líquida zero ou negativa: os totais batem com kpis e série.
    ...porRep.keys(),
  ]);

  const todos = [...codigos].map((rep) => {
    const r = porRep.get(rep);
    const d = dw.get(rep);
    const meta = manual.get(rep) ?? (d ? Number(d.valor_total) : 0);
    const faturado = r?.venda ?? 0;
    const { ritmo: _ritmo, ...s } = situacao(meta, faturado, r?.hoje ?? 0);
    return {
      rep_codigo: rep,
      rep_nome: nomeAtivo.get(rep) ?? d?.vendedor ?? r?.nome ?? `Rep ${rep}`,
      nome_venda: r?.nome ?? null,
      papel: papelMap.get(rep) ?? null,
      canal: canalDoRep(rep),
      posicao: 0,
      ...s,
      margem: r ? pct(r.lucro, faturado) : null,
      markup: r ? pct(r.lucro, r.custo) : null,
    };
  });

  // Totais antes de tirar os inativos: a venda de quem saiu continua sendo da empresa.
  const soma = (f: (v: (typeof todos)[number]) => boolean) =>
    todos.filter(f).reduce((a, v) => ({ meta: a.meta + v.meta, faturado: a.faturado + v.faturado, hoje: a.hoje + v.faturado_hoje }), {
      meta: 0,
      faturado: 0,
      hoje: 0,
    });
  const canais = CANAIS.map((canal) => {
    const t = soma((v) => v.canal === canal);
    if (canal === 'outros') {
      t.faturado += semVendedor.venda;
      t.hoje += semVendedor.hoje;
    }
    const { ritmo: _ritmo, ...s } = situacao(t.meta, t.faturado, t.hoje);
    return { canal, ...s };
  }).filter((c) => c.canal !== 'outros' || c.faturado > 0 || c.meta > 0);

  const t = soma(() => true);
  const e = situacao(t.meta, t.faturado + semVendedor.venda, t.hoje + semVendedor.hoje);
  const empresa = {
    meta: e.meta,
    faturado: e.faturado,
    faturado_hoje: e.faturado_hoje,
    ritmo: e.ritmo,
    previsao: e.previsao,
    ritmo_para_meta: ritmoNecessario(e.meta, e.faturado, dias.restantes),
    veredito: e.veredito,
  };

  const vendedores = todos
    .filter((v) => !inativos.has(v.rep_codigo))
    .sort((a, b) => b.faturado - a.faturado)
    .map((v, i) => ({ ...v, posicao: i + 1 }));

  return {
    vendedores,
    canais,
    empresa,
    kpis: {
      lucro_bruto: lucro,
      margem: pct(lucro, empresa.faturado),
      markup: pct(lucro, custo),
      ticket_medio: notas > 0 ? empresa.faturado / notas : null,
      vendas: notas,
    },
    serie: {
      meta_diaria: empresa.meta > 0 && dias.total > 0 ? empresa.meta / dias.total : null,
      dias: [...porDia].sort(([a], [b]) => a.localeCompare(b)).map(([dia, v]) => ({ dia, ...v })),
    },
  };
}
