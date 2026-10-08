/**
 * Extrai do Metabase os cards da aba "Painel de Vendas" dos dashboards do painel do
 * vendedor e grava:
 *   src/paineis/catalogo/<hub>.json  metadados por dashcard + arquivo SQL
 *   src/paineis/sql/<slug>.sql       um por SQL distinto (cards iguais entre dashboards
 *                                    compartilham o arquivo)
 *
 * Rodar na raiz do repo, uma vez e sempre que um card do painel mudar no Metabase:
 *   node --experimental-strip-types scripts/extrair-cards-metabase.ts   (ou: npx tsx ...)
 *
 * Conversão dos filtros: ver src/paineis/painel-sql.ts. Cards de pergunta "GUI" (MBQL,
 * sem SQL) são traduzidos aqui para as poucas formas que existem nesses painéis
 * (sum, distinct, count, divisão e filtro de igualdade); forma nova faz o script parar.
 *
 * Dashcard com `sqlManual: true` no catálogo atual (SQL reescrito à mão, ex.: Positivação
 * de Carteira) mantém o arquivo e a marca: o script não apaga nem regrava esse `.sql`.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { condicaoPeriodo, sqlsManuais, type ColunaPainel } from '../src/paineis/painel-sql.ts';
import { DASH_POR_HUB, PARAM_DATA, PARAM_VENDEDOR, RAIZ, mbGet } from './metabase.ts';

const DIR_CATALOGO = path.join(RAIZ, 'src/paineis/catalogo');
const DIR_SQL = path.join(RAIZ, 'src/paineis/sql');
const BANCO_BI = 4; // database do Metabase que aponta para o SQL Server BI (192.168.1.146)

const TAG = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;
const BLOCO_OPCIONAL = /\[\[([\s\S]*?)\]\]/g;

// --- metadados do Metabase (com cache) -------------------------------------
const campos = new Map<number, string>();
async function colunaDoCampo(id: number): Promise<string> {
  if (!campos.has(id)) {
    const f = await mbGet(`/api/field/${id}`);
    campos.set(id, `${f.table.schema}.${f.table.name}.${f.name}`);
  }
  return campos.get(id)!;
}
const tabelas = new Map<number, { nome: string; banco: number }>();
async function tabela(id: number) {
  if (!tabelas.has(id)) {
    const t = await mbGet(`/api/table/${id}`);
    tabelas.set(id, { nome: `${t.schema}.${t.name}`, banco: t.db_id });
  }
  return tabelas.get(id)!;
}

/** Mesma limpeza de título que a rota do frontend fazia (app/api/vendas/painel). */
function limparNome(s: string): string {
  let n = (s || '').replace(/\s*-\s*Duplicar\s*$/i, '').trim();
  if (n.includes('_')) {
    n = n
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .map((w) =>
        /^[A-ZÀ-Ý]+$/.test(w) || /^[a-zà-ÿ]+$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w,
      )
      .join(' ');
  }
  return n;
}

const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Para cada parâmetro do dashboard ligado ao dashcard: o alvo (tag do SQL ou campo). */
function mapeamentos(dc: any) {
  return (dc.parameter_mappings ?? []).map((pm: any) => {
    const qual = pm.parameter_id === PARAM_DATA ? 'data' : pm.parameter_id === PARAM_VENDEDOR ? 'vendedor' : null;
    if (!qual) throw new Error(`dashcard ${dc.id}: parâmetro ${pm.parameter_id} desconhecido`);
    return { qual, alvo: pm.target?.[1] as any[] };
  });
}

const filtroPara = (qual: string, coluna: string) =>
  qual === 'data' ? condicaoPeriodo(coluna) : `{{vendedor:${coluna}}}`;

/** SQL nativo: tags com valor viram filtro; sem valor seguem a regra do Metabase. */
async function converterNativo(card: any, dc: any): Promise<string> {
  const q = card.dataset_query.native;
  const tags: Record<string, any> = q['template-tags'] ?? {};
  const valor = new Map<string, string>();
  for (const m of mapeamentos(dc)) {
    if (m.alvo?.[0] !== 'template-tag') throw new Error(`card ${card.id}: mapeamento fora de template-tag`);
    const tag = tags[m.alvo[1]];
    if (tag?.type !== 'dimension') throw new Error(`card ${card.id}: tag ${m.alvo[1]} não é field filter`);
    valor.set(m.alvo[1], filtroPara(m.qual, await colunaDoCampo(tag.dimension[1])));
  }
  for (const [nome, t] of Object.entries(tags)) {
    if (t.type !== 'dimension') throw new Error(`card ${card.id}: tag ${nome} do tipo ${t.type} não suportada`);
  }
  // Bloco [[ ]] só fica quando todas as tags dele têm valor; tag solta sem valor vira 1 = 1.
  return (q.query as string)
    .replace(BLOCO_OPCIONAL, (_m, dentro: string) =>
      [...dentro.matchAll(TAG)].every((t) => valor.has(t[1])) ? dentro : '',
    )
    .replace(TAG, (_m, nome: string) => valor.get(nome) ?? '1 = 1');
}

/** Pergunta GUI (MBQL) → SQL, com aliases iguais aos nomes de coluna do Metabase. */
async function converterGui(card: any, dc: any): Promise<string | null> {
  const q = card.dataset_query.query;
  const t = await tabela(q['source-table']);
  if (t.banco !== BANCO_BI) return null; // fonte fora do SQL Server BI
  const extras = Object.keys(q).filter((k) => !['source-table', 'aggregation', 'filter'].includes(k));
  if (extras.length) throw new Error(`card ${card.id}: MBQL com ${extras.join(', ')} não suportado`);

  const col = async (f: any[]) => {
    if (f[0] !== 'field' || typeof f[1] !== 'number' || f[2]?.['source-field']) {
      throw new Error(`card ${card.id}: referência de campo não suportada ${JSON.stringify(f)}`);
    }
    return colunaDoCampo(f[1]);
  };
  const expr = async (a: any[]): Promise<string> => {
    switch (a[0]) {
      case 'sum':
        return `SUM(${await col(a[1])})`;
      case 'distinct':
        return `COUNT(DISTINCT ${await col(a[1])})`;
      case 'count':
        return 'COUNT(*)';
      case '/':
        return `CAST(${await expr(a[1])} AS float) / NULLIF(${await expr(a[2])}, 0)`;
      default:
        throw new Error(`card ${card.id}: agregação ${a[0]} não suportada`);
    }
  };
  if (q.aggregation?.length !== 1) throw new Error(`card ${card.id}: esperada 1 agregação`);
  let ag = q.aggregation[0];
  let nome = ag[0] === 'sum' ? 'sum' : 'count';
  if (ag[0] === 'aggregation-options') {
    nome = ag[2].name;
    ag = ag[1];
  }
  const onde: string[] = [];
  if (q.filter) {
    if (q.filter[0] !== '=' || q.filter.length !== 3) throw new Error(`card ${card.id}: filtro não suportado`);
    const v = q.filter[2];
    onde.push(`${await col(q.filter[1])} = ${v === true ? 1 : v === false ? 0 : typeof v === 'number' ? v : `'${v}'`}`);
  }
  for (const m of mapeamentos(dc)) onde.push(filtroPara(m.qual, await col(m.alvo)));
  return `SELECT ${await expr(ag)} AS [${nome}]\nFROM ${t.nome}${onde.length ? `\nWHERE ${onde.join('\n  AND ')}` : ''};\n`;
}

async function main() {
  fs.mkdirSync(DIR_CATALOGO, { recursive: true });
  fs.mkdirSync(DIR_SQL, { recursive: true });
  const manuais = sqlsManuais(
    fs.readdirSync(DIR_CATALOGO).map((f) => JSON.parse(fs.readFileSync(path.join(DIR_CATALOGO, f), 'utf8'))),
  );
  const arquivosManuais = new Set(manuais.values());
  for (const f of fs.readdirSync(DIR_SQL)) {
    if (f.endsWith('.sql') && !arquivosManuais.has(f)) fs.unlinkSync(path.join(DIR_SQL, f));
  }

  const arquivoPorHash = new Map<string, string>();
  // Nome de arquivo manual fica reservado: SQL extraído com o mesmo slug ganha o sufixo -<card>.
  const usados = new Set([...arquivosManuais].map((f) => f.replace(/\.sql$/, '')));
  const cards = new Map<number, any>();

  for (const [hub, dashId] of Object.entries(DASH_POR_HUB)) {
    const dash = await mbGet(`/api/dashboard/${dashId}`);
    const aba = (dash.tabs ?? []).find((t: any) => /painel de vendas/i.test(t.name ?? ''));
    // Dashboard sem abas (varejo) = tudo é painel de vendas.
    const dcs = (dash.dashcards ?? [])
      .filter((dc: any) => dc.card?.id && (!aba || dc.dashboard_tab_id === aba.id))
      .sort((a: any, b: any) => a.row - b.row || a.col - b.col);

    const itens: any[] = [];
    for (const dc of dcs) {
      if (!cards.has(dc.card.id)) cards.set(dc.card.id, await mbGet(`/api/card/${dc.card.id}`));
      const card = cards.get(dc.card.id);
      const tipo = card.dataset_query?.type;
      const manual = manuais.get(`${hub}:${dc.id}`) ?? null;
      const sql = manual
        ? null
        : tipo === 'native' && card.dataset_query.database === BANCO_BI
          ? await converterNativo(card, dc)
          : tipo === 'query'
            ? await converterGui(card, dc)
            : null;

      let arquivo: string | null = manual;
      if (sql) {
        const hash = crypto.createHash('sha1').update(sql).digest('hex');
        arquivo = arquivoPorHash.get(hash) ?? null;
        if (!arquivo) {
          const base = slugify(limparNome(card.name)) || `card-${card.id}`;
          arquivo = `${usados.has(base) ? `${base}-${card.id}` : base}.sql`;
          usados.add(arquivo.replace(/\.sql$/, ''));
          arquivoPorHash.set(hash, arquivo);
          fs.writeFileSync(path.join(DIR_SQL, arquivo), sql.endsWith('\n') ? sql : `${sql}\n`);
        }
      }

      const dcViz = dc.visualization_settings ?? {};
      const cols: ColunaPainel[] = (card.result_metadata ?? []).map((m: any) => ({
        name: m.name,
        display_name: m.display_name,
        base_type: m.base_type,
      }));
      itens.push({
        dashcard: dc.id,
        card: dc.card.id,
        titulo: limparNome((dcViz['card.title'] as string) || dc.card.name),
        display: dc.card.display,
        row: dc.row,
        col: dc.col,
        size_x: dc.size_x,
        size_y: dc.size_y,
        // Override do dashcard por cima do card, como o Metabase faz.
        visualization_settings: { ...(card.visualization_settings ?? {}), ...dcViz },
        sql: arquivo,
        ...(manual ? { sqlManual: true } : {}),
        ...(arquivo ? {} : { indisponivel: `card ${card.id} lê banco ${card.dataset_query?.database} do Metabase, fora do SQL Server BI` }),
        cols,
      });
    }

    // Mapas de calor repetidos (mesmo card): fica o mais à esquerda, esticado na
    // largura do grupo — mesma regra da rota do frontend.
    const porCard = new Map<number, any[]>();
    for (const c of itens) if (c.display === 'map') porCard.set(c.card, [...(porCard.get(c.card) ?? []), c]);
    const remover = new Set<number>();
    for (const g of porCard.values()) {
      if (g.length < 2) continue;
      const minCol = Math.min(...g.map((x) => x.col));
      const maxDir = Math.max(...g.map((x) => x.col + x.size_x));
      const principal = g.reduce((a, b) => (a.col <= b.col ? a : b));
      principal.col = minCol;
      principal.size_x = maxDir - minCol;
      g.filter((x) => x !== principal).forEach((x) => remover.add(x.dashcard));
    }
    const finais = itens.filter((c) => !remover.has(c.dashcard)).sort((a, b) => a.row - b.row || a.col - b.col);

    const saida = { hub, dashboard: dashId, aba: aba?.name ?? null, cards: finais };
    fs.writeFileSync(path.join(DIR_CATALOGO, `${hub.toLowerCase()}.json`), `${JSON.stringify(saida, null, 2)}\n`);
    const fora = finais.filter((c) => !c.sql).map((c) => `${c.dashcard}/${c.card}`);
    console.log(`${hub} (dash ${dashId}): ${finais.length} cards${fora.length ? `; sem SQL nativo: ${fora.join(', ')}` : ''}`);
  }
  console.log(`${arquivoPorHash.size} arquivos SQL extraídos em src/paineis/sql (+ ${arquivosManuais.size} manual mantido)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
