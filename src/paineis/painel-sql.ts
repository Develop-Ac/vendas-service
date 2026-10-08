/**
 * Montagem e execução-agnóstica dos SQLs dos painéis nativos (cards que antes eram
 * consultados no Metabase). Módulo puro, sem dependências: é usado pelo PaineisService
 * e pelos scripts em `scripts/` (extração e comparação com o Metabase).
 *
 * Os arquivos em `sql/` são o SQL do card no Metabase com os filtros já convertidos:
 *   - período: `coluna >= CAST(@de AS date) AND coluna < DATEADD(day, 1, CAST(@ate AS date))`
 *     (o date/range do Metabase é inclusivo nas duas pontas; CAST(... AS date) porque a
 *     conversão implícita de 'YYYY-MM-DD' para datetime depende do idioma do login);
 *   - vendedor: marcador `{{vendedor:<schema.tabela.coluna>}}`, resolvido aqui por
 *     requisição — lista de vendedores (`coluna IN (@v0, @v1...)`) ou sem filtro (`1 = 1`).
 *
 * Lista vazia vira `1 = 1` (empresa toda), inclusive nos cards escritos como
 * `WHERE 1 = 2 [[OR {{vendedor}}]]`: no Metabase, filtro vazio ali zera o card; a
 * gerência sempre passava a lista inteira de vendedores para escapar disso.
 */

export interface FiltroPainel {
  de: string;
  ate: string;
  vendedores: string[];
}

export const MARCADOR_VENDEDOR = /\{\{vendedor:([A-Za-z0-9_.]+)\}\}/g;

/** Condição de período sobre uma coluna (date ou datetime). */
export const condicaoPeriodo = (coluna: string) =>
  `(${coluna} >= CAST(@de AS date) AND ${coluna} < DATEADD(day, 1, CAST(@ate AS date)))`;

/** Expande uma lista em parâmetros nomeados (@v0, @v1...); lista vazia vira NULL (casa com nada). */
function expandir(params: Record<string, unknown>, prefixo: string, valores: unknown[]): string {
  if (!valores.length) return 'NULL';
  return valores
    .map((v, i) => {
      params[`${prefixo}${i}`] = v;
      return `@${prefixo}${i}`;
    })
    .join(', ');
}

/** Troca os marcadores de vendedor e devolve o texto + parâmetros nomeados da lib mssql. */
export function montarConsulta(sql: string, f: FiltroPainel): { texto: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = { de: f.de, ate: f.ate };
  // Normaliza aqui, uma vez, para o SQL comparar a coluna crua (sem UPPER/TRIM por linha,
  // que impede o uso de índice). Caixa e acento não precisam: as colunas são _CI_.
  const lista = [...new Set(f.vendedores.map((v) => v.trim()).filter(Boolean))];
  const vendedores = lista.length ? expandir(params, 'v', lista) : null;
  const condicao = (coluna: string) => (vendedores ? `${coluna} IN (${vendedores})` : '1 = 1');
  return { texto: sql.replace(MARCADOR_VENDEDOR, (_m, coluna: string) => `(${condicao(coluna)})`), params };
}

/**
 * SQLs reescritos à mão (`sqlManual: true` no catálogo): `<hub>:<dashcard>` → arquivo.
 * O extrator (scripts/extrair-cards-metabase.ts) mantém esses arquivos e a marca em vez
 * de regravar o SQL vindo do Metabase.
 */
export function sqlsManuais(
  catalogos: { hub: string; cards: { dashcard: number; sql: string | null; sqlManual?: boolean }[] }[],
): Map<string, string> {
  return new Map(
    catalogos.flatMap((c) =>
      c.cards.filter((x) => x.sqlManual && x.sql).map((x) => [`${c.hub}:${x.dashcard}`, x.sql!] as [string, string]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Resultado no formato do Metabase (data.cols / data.rows)
// ---------------------------------------------------------------------------

export interface ColunaPainel {
  name: string;
  display_name: string;
  base_type: string;
}

/** Metadado de coluna da lib mssql (arrayRowMode). */
export interface ColunaMssql {
  name: string;
  type?: { declaration?: string };
}

/**
 * Fuso de relatório do Metabase: ele devolve date/datetime como hora local com
 * deslocamento fixo (ex.: "2026-09-01T00:00:00-03:00"). Repetir o formato mantém os
 * componentes do frontend iguais.
 */
const DESLOCAMENTO_METABASE = '-03:00';

/** O Metabase corta em 2000 linhas o resultado de card em dashboard (max-results-bare-rows). */
export const LIMITE_LINHAS = 2000;

const BASE_TYPE: Record<string, string> = {
  int: 'type/Integer',
  smallint: 'type/Integer',
  tinyint: 'type/Integer',
  bigint: 'type/BigInteger',
  decimal: 'type/Decimal',
  numeric: 'type/Decimal',
  money: 'type/Decimal',
  smallmoney: 'type/Decimal',
  float: 'type/Float',
  real: 'type/Float',
  date: 'type/Date',
  datetime: 'type/DateTime',
  datetime2: 'type/DateTime',
  smalldatetime: 'type/DateTime',
  datetimeoffset: 'type/DateTimeWithTZ',
  bit: 'type/Boolean',
};

function valorMetabase(v: unknown, declaracao: string): unknown {
  if (v instanceof Date) {
    // mssql com useUTC: os componentes UTC do Date são a hora gravada no banco.
    const iso = v.toISOString();
    if (declaracao === 'date') return `${iso.slice(0, 10)}T00:00:00${DESLOCAMENTO_METABASE}`;
    const ms = iso.slice(20, 23);
    return `${iso.slice(0, 19)}${ms === '000' ? '' : `.${ms}`}${DESLOCAMENTO_METABASE}`;
  }
  // bigint chega como string na lib mssql; o Metabase devolve número.
  if (declaracao === 'bigint' && typeof v === 'string') return Number(v);
  return v;
}

/**
 * Converte o resultado do mssql para `{ cols, rows }` do Metabase. Nome e tipo de
 * exibição vêm do metadado do card no Metabase (catálogo) quando existe.
 */
export function resultadoMetabase(
  colunas: ColunaMssql[],
  linhas: unknown[][],
  colsCatalogo: ColunaPainel[] = [],
): { cols: ColunaPainel[]; rows: unknown[][] } {
  const decl = colunas.map((c) => (c.type?.declaration ?? '').toLowerCase());
  const cols = colunas.map((c, i) => {
    const cat = colsCatalogo.find((x) => x.name === c.name);
    return {
      name: c.name,
      display_name: cat?.display_name ?? c.name,
      base_type: cat?.base_type ?? BASE_TYPE[decl[i]] ?? 'type/Text',
    };
  });
  const rows = linhas.slice(0, LIMITE_LINHAS).map((l) => l.map((v, i) => valorMetabase(v, decl[i])));
  return { cols, rows };
}
