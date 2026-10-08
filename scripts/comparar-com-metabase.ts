/**
 * Critério de aceite dos painéis nativos: para cada card do painel, executa o card no
 * Metabase (mesmos filtros) e o SQL de src/paineis/sql, e compara as linhas
 * (tolerância 0,01 em números).
 *
 * Rodar na raiz do repo (lê o .env do repo para o SQL Server BI):
 *   node --experimental-strip-types scripts/comparar-com-metabase.ts            (cenários padrão)
 *   node --experimental-strip-types scripts/comparar-com-metabase.ts --hub ATACADO --vendedores "ALISSON" --de 2026-09-01 --ate 2026-09-30
 *   node --experimental-strip-types scripts/comparar-com-metabase.ts --hub GERENCIA --mb-todos
 *
 * --mb-todos (gerência): passa ao Metabase todos os nomes do cadastro em vez de nenhum,
 * como a rota antiga do frontend fazia.
 */
import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { type FiltroPainel, montarConsulta, resultadoMetabase } from '../src/paineis/painel-sql.ts';
import { DASH_POR_HUB, PARAM_DATA, PARAM_VENDEDOR, RAIZ, mbPost } from './metabase.ts';

const envRepo = path.join(RAIZ, '.env');
if (fs.existsSync(envRepo)) process.loadEnvFile(envRepo);
const env = (...nomes: string[]) => nomes.map((n) => process.env[n]).find((v) => v);

const pool = new sql.ConnectionPool({
  server: env('BI_SQL_SERVER', 'SQL_HOST', 'MSSQL_HOST') ?? '192.168.1.146',
  database: env('BI_SQL_DATABASE', 'SQL_DATABASE', 'MSSQL_DATABASE') ?? 'BI',
  user: env('BI_SQL_USER', 'SQL_USER', 'MSSQL_USER') ?? '',
  password: env('BI_SQL_PASSWORD', 'SQL_PASSWORD', 'MSSQL_PASSWORD') ?? '',
  port: Number(env('BI_SQL_PORT', 'SQL_PORT', 'MSSQL_PORT') ?? 1433),
  options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  pool: { max: Number(process.env.POOL_MAX ?? 10), min: 0 },
  requestTimeout: 120_000,
});

async function consultar(texto: string, params: Record<string, unknown>) {
  const req = pool.request();
  req.arrayRowMode = true;
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  const r: any = await req.query(texto);
  return { colunas: r.columns?.[0] ?? [], linhas: (r.recordset ?? []) as unknown[][] };
}

const iguais = (a: unknown, b: unknown) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 : a === b || String(a) === String(b);
const linhasIguais = (a: unknown[][], b: unknown[][]) =>
  a.length === b.length && a.every((l, i) => l.length === b[i].length && l.every((v, j) => iguais(v, b[i][j])));
const ordenar = (rows: unknown[][]) => [...rows].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
const curto = (v: unknown) => {
  const s = JSON.stringify(v) ?? "(sem linha)";
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

interface Cenario {
  nome: string;
  hub: string; // catálogo
  filtro: FiltroPainel;
  vendedoresMetabase: string[] | null; // null = sem filtro de vendedor no Metabase
}

async function todosDoCadastro() {
  const r = await consultar(
    'SELECT DISTINCT nome_representante FROM dbo.d_cadastro_representantes WHERE nome_representante IS NOT NULL',
    {},
  );
  return r.linhas.map((l) => String(l[0]));
}

async function rodar(c: Cenario) {
  const catalogo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'src/paineis/catalogo', `${c.hub.toLowerCase()}.json`), 'utf8'));
  const dash = DASH_POR_HUB[c.hub];
  const sqls = new Map<string, string>();
  console.log(`\n=== ${c.nome} — dash ${dash}, ${c.filtro.de} a ${c.filtro.ate}`);
  if (c.vendedoresMetabase) console.log(`Metabase recebe Vendedor = ${c.vendedoresMetabase.length} nome(s): ${c.vendedoresMetabase.slice(0, 15).join(', ')}${c.vendedoresMetabase.length > 15 ? '…' : ''}`);

  // Nativo: todos os cards juntos (como o serviço), medindo o tempo da abertura.
  const t0 = Date.now();
  const nativos = await Promise.all(
    catalogo.cards.map(async (card: any) => {
      if (!card.sql) return null;
      if (!sqls.has(card.sql)) sqls.set(card.sql, fs.readFileSync(path.join(RAIZ, 'src/paineis/sql', card.sql), 'utf8'));
      const { texto, params } = montarConsulta(sqls.get(card.sql)!, c.filtro);
      try {
        const t = Date.now();
        const r = await consultar(texto, params);
        return { ...resultadoMetabase(r.colunas, r.linhas, card.cols), ms: Date.now() - t };
      } catch (e) {
        return { erro: (e as Error).message };
      }
    }),
  );
  console.log(`SQL nativo: ${catalogo.cards.length} cards em ${Date.now() - t0} ms (em paralelo, pool ${pool.config.pool?.max})`);

  const resumo = { igual: 0, diferente: 0, naoComparavel: 0 };
  let msMetabase = 0;
  for (const [i, card] of catalogo.cards.entries()) {
    const nat: any = nativos[i];
    const rotulo = `dc ${card.dashcard} / card ${card.card} ${card.titulo}${nat?.ms !== undefined ? ` [${nat.ms} ms]` : ''}`;
    if (!nat) {
      resumo.naoComparavel++;
      console.log(`  NÃO COMPARÁVEL  ${rotulo}: ${card.indisponivel}`);
      continue;
    }
    const parameters: any[] = [{ id: PARAM_DATA, value: `${c.filtro.de}~${c.filtro.ate}` }];
    if (c.vendedoresMetabase) parameters.push({ id: PARAM_VENDEDOR, value: c.vendedoresMetabase });
    let mb: any;
    try {
      const t = Date.now();
      const resp = await mbPost(`/api/dashboard/${dash}/dashcard/${card.dashcard}/card/${card.card}/query`, { parameters });
      msMetabase += Date.now() - t;
      if (resp?.status === 'failed') throw new Error(resp.error);
      mb = resp.data;
    } catch (e) {
      resumo.naoComparavel++;
      const nativo = nat.erro ? `nativo também falhou (${nat.erro})` : `nativo=${curto(nat.rows)}`;
      console.log(`  NÃO COMPARÁVEL  ${rotulo}: Metabase falhou (${(e as Error).message}); ${nativo}`);
      continue;
    }
    if (nat.erro) {
      resumo.diferente++;
      console.log(`  DIFERENTE       ${rotulo}: SQL nativo falhou: ${nat.erro}`);
      continue;
    }
    const mbRows: unknown[][] = mb?.rows ?? [];
    const nomesMb = (mb?.cols ?? []).map((x: any) => x.name).join(',');
    const nomesNat = nat.cols.map((x: any) => x.name).join(',');
    const obsCols = nomesMb === nomesNat ? '' : ` [colunas: metabase=${nomesMb} | nativo=${nomesNat}]`;
    if (linhasIguais(nat.rows, mbRows)) {
      resumo.igual++;
      console.log(`  IGUAL           ${rotulo} (${mbRows.length} linha(s))${obsCols}`);
    } else if (linhasIguais(ordenar(nat.rows), ordenar(mbRows))) {
      resumo.igual++;
      console.log(`  IGUAL (ordem)   ${rotulo} (${mbRows.length} linha(s), ordem diferente)${obsCols}`);
    } else {
      resumo.diferente++;
      const j = nat.rows.findIndex((l: unknown[], k: number) => !mbRows[k] || !l.every((v, m) => iguais(v, mbRows[k][m])));
      const k = j < 0 ? nat.rows.length : j;
      console.log(
        `  DIFERENTE       ${rotulo}: linhas metabase=${mbRows.length} nativo=${nat.rows.length}; ` +
          `1ª divergência (linha ${k}): metabase=${curto(mbRows[k])} nativo=${curto(nat.rows[k])}${obsCols}`,
      );
    }
  }
  console.log(`Metabase: soma de ${msMetabase} ms nas chamadas card a card (uma por vez)`);
  console.log(`Resumo ${c.nome}: ${resumo.igual} igual, ${resumo.diferente} diferente, ${resumo.naoComparavel} não comparável`);
}

function arg(nome: string) {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  await pool.connect();
  const de = arg('de') ?? '2026-09-01';
  const ate = arg('ate') ?? '2026-09-30';
  const hub = arg('hub')?.toUpperCase();
  const cenarios: Cenario[] = [];

  const cenarioHub = async (h: string, vendedores: string[]): Promise<Cenario> => ({
    nome: `hub ${h}${vendedores.length ? ` (${vendedores.join(', ')})` : ' (sem vendedor)'}`,
    hub: h,
    filtro: { de, ate, vendedores },
    vendedoresMetabase: vendedores.length ? vendedores : process.argv.includes('--mb-todos') ? await todosDoCadastro() : null,
  });

  if (hub) {
    const vs = (arg('vendedores') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    cenarios.push(await cenarioHub(hub, vs));
  } else {
    cenarios.push(await cenarioHub('ATACADO', ['ALISSON']));
    cenarios.push(await cenarioHub('SUPERVISAO_ATACADO', ['ALISSON', 'FERNANDO', 'CRISTIANO BIASOTTO SANTOS ALVES']));
    cenarios.push(await cenarioHub('GERENCIA', []));
  }
  for (const c of cenarios) await rodar(c);
  await pool.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
