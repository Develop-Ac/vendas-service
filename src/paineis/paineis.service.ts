import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MssqlService } from '../common/mssql/mssql.service';
import { PrismaService } from '../prisma/prisma.service';
import { CarteirizacaoService } from '../carteirizacao/carteirizacao.service';
import { type ColunaPainel, montarConsulta, resultadoMetabase } from './painel-sql';
import { CacheTtl } from './cache-ttl';

/** Dashcard do catálogo extraído do Metabase (scripts/extrair-cards-metabase.ts). */
export interface CardCatalogo {
  dashcard: number;
  card: number;
  titulo: string;
  display: string;
  row: number;
  col: number;
  size_x: number;
  size_y: number;
  visualization_settings: Record<string, unknown>;
  sql: string | null;
  /** SQL reescrito à mão; o extrator não o regrava (ver painel-sql.ts, sqlsManuais). */
  sqlManual?: boolean;
  indisponivel?: string;
  cols: ColunaPainel[];
}

export interface Catalogo {
  hub: string;
  dashboard: number;
  aba: string | null;
  cards: CardCatalogo[];
}

export const HUBS = ['VAREJO', 'ATACADO', 'SUPERVISAO_ATACADO', 'GERENCIA'] as const;
export type Hub = (typeof HUBS)[number];

const DIR_CATALOGO = path.join(__dirname, 'catalogo');
const DIR_SQL = path.join(__dirname, 'sql');

const DATA = /^\d{4}-\d{2}-\d{2}$/;
/** Grade do painel (a mesma do Metabase). */
const COLUNAS = 24;
const INT_MAX = 2_147_483_647;

/** Ajuste de layout de um card (tabela ven_painel_layout, sem as colunas de auditoria). */
export interface ItemLayout {
  dashcard: number;
  row: number;
  col: number;
  size_x: number;
  size_y: number;
  oculto: boolean;
  titulo: string | null;
}

/** Card do catálogo com os ajustes do hub aplicados por cima, na ordem (row, col) resultante. */
export function mesclarLayout(cards: CardCatalogo[], ajustes: ItemLayout[]) {
  const porDashcard = new Map(ajustes.map((a) => [a.dashcard, a]));
  return cards
    .map((c) => {
      const a = porDashcard.get(c.dashcard);
      const base = { ...c, tituloPadrao: c.titulo, oculto: a?.oculto ?? false };
      if (!a) return base;
      return { ...base, row: a.row, col: a.col, size_x: a.size_x, size_y: a.size_y, titulo: a.titulo ?? c.titulo };
    })
    .sort((x, y) => x.row - y.row || x.col - y.col);
}

/** Valida o body do PUT de layout contra o catálogo do hub; erro = 400 com o item culpado. */
export function validarLayout(body: unknown, catalogo: Catalogo): ItemLayout[] {
  const itens = (body as { itens?: unknown } | null)?.itens;
  if (!Array.isArray(itens)) throw new BadRequestException('body deve ser { "itens": [...] }.');
  const porDashcard = new Map(catalogo.cards.map((c) => [c.dashcard, c]));
  const vistos = new Set<number>();
  const inteiro = (v: unknown, min: number, max = INT_MAX): v is number =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

  return itens.map((item: unknown, n) => {
    const erro = (msg: string) => new BadRequestException(`itens[${n}]: ${msg}`);
    if (!item || typeof item !== 'object') throw erro('deve ser um objeto.');
    const { dashcard, row, col, size_x, size_y, oculto = false, titulo = null } = item as Record<string, unknown>;
    const card = inteiro(dashcard, 0) ? porDashcard.get(dashcard) : undefined;
    if (!card) throw erro(`dashcard ${String(dashcard)} não existe no painel ${catalogo.hub}.`);
    if (vistos.has(card.dashcard)) throw erro(`dashcard ${card.dashcard} repetido.`);
    vistos.add(card.dashcard);
    if (!inteiro(row, 0) || !inteiro(col, 0)) throw erro('row e col devem ser inteiros >= 0.');
    if (!inteiro(size_x, 1, COLUNAS) || col + size_x > COLUNAS) {
      throw erro(`size_x deve ser inteiro de 1 a ${COLUNAS}, com col + size_x <= ${COLUNAS}.`);
    }
    if (!inteiro(size_y, 1)) throw erro('size_y deve ser inteiro >= 1.');
    if (typeof oculto !== 'boolean') throw erro('oculto deve ser booleano.');
    if (titulo !== null && typeof titulo !== 'string') throw erro('titulo deve ser texto ou null.');
    const t = titulo?.trim() || null;
    if (t && t.length > 120) throw erro('titulo passa de 120 caracteres.');
    // Título igual ao do catálogo vira nulo: se o catálogo for reextraído com outro nome, o card acompanha.
    return { dashcard: card.dashcard, row, col, size_x, size_y, oculto, titulo: t === card.titulo ? null : t };
  });
}

export interface RespostaPainel {
  painel: 'vendedor';
  filtros: { hub: Hub; vendedores: string[]; de: string; ate: string };
  geradoEm: string;
  cache: boolean;
  cards: (Omit<CardCatalogo, 'sql' | 'sqlManual' | 'cols' | 'indisponivel'> & {
    /** Título do catálogo; `titulo` é o renomeado pelo hub, quando houver. */
    tituloPadrao: string;
    /** Oculto pelo ajuste do hub: vem na resposta (a edição reexibe), sem rodar SQL e com data null. */
    oculto: boolean;
    data: { cols: ColunaPainel[]; rows: unknown[][] } | null;
    erro?: string;
  })[];
}

/**
 * Painéis de vendas nativos: executa no SQL Server BI os SQLs dos cards que a
 * intranet antes buscava um a um no Metabase e devolve o painel inteiro numa chamada,
 * no formato de resultado do Metabase (data.cols / data.rows) por card.
 */
@Injectable()
export class PaineisService {
  private readonly logger = new Logger(PaineisService.name);
  private readonly catalogos = new Map<Hub, Catalogo>();
  private readonly sqls = new Map<string, string>();
  // 60 s < atraso do mart (~5 min): o cache nunca mostra dado mais velho que o próprio mart.
  private readonly cache = new CacheTtl<RespostaPainel>(60_000);
  /** Sobe a cada gravação de layout: painel montado com o layout antigo não entra no cache. */
  private readonly versaoLayout = new Map<Hub, number>();

  constructor(
    private readonly mssql: MssqlService,
    private readonly carteirizacao: CarteirizacaoService,
    private readonly prisma: PrismaService,
  ) {
    for (const hub of HUBS) {
      const cat = JSON.parse(
        fs.readFileSync(path.join(DIR_CATALOGO, `${hub.toLowerCase()}.json`), 'utf8'),
      ) as Catalogo;
      this.catalogos.set(hub, cat);
      for (const c of cat.cards) {
        if (c.sql && !this.sqls.has(c.sql)) {
          this.sqls.set(c.sql, fs.readFileSync(path.join(DIR_SQL, c.sql), 'utf8'));
        }
      }
    }
  }

  async vendedor(hub: string, vendedores: string[], de?: string, ate?: string) {
    const h = this.hub(hub);
    const periodo = await this.periodo(de, ate);
    return this.painel(this.catalogos.get(h)!, { hub: h, vendedores, ...periodo });
  }

  /** Substitui todos os ajustes de layout do hub (o que não vier volta ao padrão do catálogo). */
  async salvarLayout(hub: string, body: unknown, usuario?: string) {
    const h = this.hub(hub);
    const itens = validarLayout(body, this.catalogos.get(h)!);
    const atualizado_por = usuario?.trim().slice(0, 120) || null;
    await this.prisma.$transaction([
      this.prisma.ven_painel_layout.deleteMany({ where: { painel: h } }),
      this.prisma.ven_painel_layout.createMany({ data: itens.map((i) => ({ painel: h, ...i, atualizado_por })) }),
    ]);
    this.invalidar(h);
    return { ok: true, itens: itens.length };
  }

  /** Restaurar padrão: apaga os ajustes do hub. */
  async restaurarLayout(hub: string) {
    const h = this.hub(hub);
    await this.prisma.ven_painel_layout.deleteMany({ where: { painel: h } });
    this.invalidar(h);
    return { ok: true };
  }

  private hub(hub: string): Hub {
    if (!HUBS.includes(hub as Hub)) {
      throw new BadRequestException(`hub deve ser um de: ${HUBS.join(', ')}`);
    }
    return hub as Hub;
  }

  private invalidar(hub: Hub) {
    this.versaoLayout.set(hub, (this.versaoLayout.get(hub) ?? 0) + 1);
    this.cache.apagarPrefixo(`${hub}|`);
  }

  /** Período pedido ou, sem ele, o mês comissional vigente. */
  private async periodo(de?: string, ate?: string): Promise<{ de: string; ate: string }> {
    if (!de && !ate) {
      const p = await this.carteirizacao.periodoComissionalVigente();
      return { de: p.data_inicio, ate: p.data_fim };
    }
    if (!de || !ate || !DATA.test(de) || !DATA.test(ate) || de > ate) {
      throw new BadRequestException('de e ate devem vir juntos, em YYYY-MM-DD, com de <= ate.');
    }
    return { de, ate };
  }

  private async painel(catalogo: Catalogo, filtros: RespostaPainel['filtros']): Promise<RespostaPainel> {
    const hub = filtros.hub;
    // Prefixo do hub na chave: gravar o layout derruba só o cache daquele hub.
    const chave = `${hub}|${JSON.stringify(filtros)}`;
    const emCache = this.cache.get(chave);
    if (emCache) return { ...emCache, cache: true };
    const versao = this.versaoLayout.get(hub) ?? 0;
    // Falha ao ler os ajustes (ex.: tabela ainda não criada) não derruba o painel: vale o catálogo.
    const ajustes = await this.prisma.ven_painel_layout
      .findMany({
        where: { painel: hub },
        select: { dashcard: true, row: true, col: true, size_x: true, size_y: true, oculto: true, titulo: true },
      })
      .catch((e: Error) => {
        this.logger.error(`Painel ${hub}: layout do hub não lido, usando o catálogo: ${e.message}`);
        return [];
      });

    // Cards que compartilham o mesmo SQL (ex.: "Margem Bruta" em três dashcards) rodam
    // uma vez. As consultas entram juntas e o pool da MssqlService (max 10) enfileira.
    const execucoes = new Map<string, Promise<{ colunas: any[]; linhas: unknown[][] }>>();
    const executar = (arquivo: string) => {
      if (!execucoes.has(arquivo)) {
        const { texto, params } = montarConsulta(this.sqls.get(arquivo)!, filtros);
        execucoes.set(arquivo, this.mssql.queryLinhas(texto, params));
      }
      return execucoes.get(arquivo)!;
    };

    const cards = await Promise.all(
      mesclarLayout(catalogo.cards, ajustes).map(async ({ sql, sqlManual: _manual, cols, indisponivel, ...meta }) => {
        if (meta.oculto) return { ...meta, data: null };
        if (!sql) return { ...meta, data: null, erro: indisponivel ?? 'card sem SQL' };
        try {
          const r = await executar(sql);
          return { ...meta, data: resultadoMetabase(r.colunas, r.linhas, cols) };
        } catch (e) {
          // Um card com erro não derruba o painel inteiro.
          this.logger.error(`Painel ${catalogo.hub}: card ${meta.card} (${sql}) falhou: ${(e as Error).message}`);
          return { ...meta, data: null, erro: 'falha ao consultar o card' };
        }
      }),
    );

    const resposta: RespostaPainel = { painel: 'vendedor', filtros, geradoEm: new Date().toISOString(), cache: false, cards };
    if ((this.versaoLayout.get(hub) ?? 0) === versao) this.cache.set(chave, resposta);
    return resposta;
  }
}
