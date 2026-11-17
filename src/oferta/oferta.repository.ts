import { Injectable } from '@nestjs/common';
import type { ven_oferta, ven_oferta_item } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { contaNoPeriodo } from './ganhos';
import type { ItemEditavel, ItemExistente, MotivoEncerramento, StatusOfertaItem, TipoOferta } from './oferta';
import { premioDe, type FaixaPremio, type OrigemOferta } from './premio';

/* =============================================================================
   OFERTAS DO ATACADO — acesso ao Postgres (ven_oferta, ven_oferta_item).
   Datas DATE saem como 'AAAA-MM-DD' e Decimal como number.
   ============================================================================= */

const nn = (v: unknown) => (v == null ? null : Number(v));
/** Coluna DATE (meia-noite UTC) → 'AAAA-MM-DD'. */
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** 'AAAA-MM-DD' → valor da coluna DATE. */
const dataDb = (s: string) => new Date(`${s}T00:00:00Z`);

export type OfertaItem = ReturnType<OfertaRepository['mapItem']>;
export type Oferta = ReturnType<OfertaRepository['mapOferta']>;

@Injectable()
export class OfertaRepository {
  constructor(private readonly prisma: PrismaService) {}

  mapOferta(r: ven_oferta) {
    return {
      id: r.id,
      nome: r.nome,
      tipo: r.tipo as TipoOferta,
      origem: r.origem as OrigemOferta | null,
      fornecedor_codigo: r.fornecedor_codigo,
      fornecedor_nome: r.fornecedor_nome,
      premio_tipo: r.premio_tipo,
      premio_valor: nn(r.premio_valor),
      premio_faixas: Array.isArray(r.premio_faixas) ? (r.premio_faixas as unknown as FaixaPremio[]) : [],
      criado_por: r.criado_por,
      criado_em: r.criado_em,
    };
  }

  mapItem(r: ven_oferta_item) {
    return {
      id: r.id,
      oferta_id: r.oferta_id,
      pro_codigo: r.pro_codigo,
      descricao: r.descricao,
      preco_t2: nn(r.preco_t2),
      preco_t5: nn(r.preco_t5),
      inicio: ymd(r.inicio),
      fim: ymd(r.fim),
      limite_qtd: nn(r.limite_qtd),
      status: r.status as StatusOfertaItem,
      encerrado_motivo: r.encerrado_motivo as MotivoEncerramento | null,
      enviado_por: r.enviado_por,
      enviado_em: r.enviado_em,
      aprovado_por: r.aprovado_por,
      aprovado_em: r.aprovado_em,
      encerrado_por: r.encerrado_por,
      encerrado_em: r.encerrado_em,
    };
  }

  /** Usuário da intranet pelo id com as permissões nas telas informadas. */
  permissoes(userId: string | null | undefined, telas: string[]) {
    const r = (userId ?? '').trim();
    if (!r) return Promise.resolve(null);
    return this.prisma.sis_usuarios.findFirst({
      where: { trash: 0, id: r },
      select: { id: true, nome: true, sis_permissoes: { where: { tela: { in: telas } }, select: { tela: true, visualizar: true, editar: true, criar: true } } },
    });
  }

  /**
   * De onde o orçamento do atacado tira a promoção: `intranet` false (padrão, sem linha gravada)
   * = promoções do Celta; true = só as ofertas da intranet. Linha única em ven_oferta_config.
   */
  async fonte() {
    const r = await this.prisma.$queryRaw<{ fonte_intranet: boolean; alterado_por: string | null; alterado_em: Date | null }[]>`
      SELECT fonte_intranet, alterado_por, alterado_em FROM ven_oferta_config WHERE id = 1`;
    return { intranet: !!r[0]?.fonte_intranet, alterado_por: r[0]?.alterado_por ?? null, alterado_em: r[0]?.alterado_em ?? null };
  }

  async fonteIntranet() {
    return (await this.fonte()).intranet;
  }

  async definirFonte(intranet: boolean, por: string | null) {
    await this.prisma.$executeRaw`
      INSERT INTO ven_oferta_config (id, fonte_intranet, alterado_por, alterado_em) VALUES (1, ${intranet}, ${por}, now())
      ON CONFLICT (id) DO UPDATE SET fonte_intranet = EXCLUDED.fonte_intranet, alterado_por = EXCLUDED.alterado_por, alterado_em = EXCLUDED.alterado_em`;
  }

  /** Todos os grupos com a contagem de itens por situação, o período mínimo–máximo e os ids dos itens. */
  async grupos() {
    const [ofertas, itens] = await Promise.all([
      this.prisma.ven_oferta.findMany({ orderBy: { id: 'desc' } }),
      this.prisma.ven_oferta_item.findMany({ select: { id: true, oferta_id: true, status: true, inicio: true, fim: true } }),
    ]);
    return ofertas.map((o) => {
      const meus = itens.filter((i) => i.oferta_id === o.id);
      const conta = (s: StatusOfertaItem) => meus.filter((i) => i.status === s).length;
      const inicios = meus.map((i) => ymd(i.inicio)).sort();
      const fins = meus.map((i) => ymd(i.fim)).sort();
      return {
        ...this.mapOferta(o),
        itens: { rascunho: conta('RASCUNHO'), pendente: conta('PENDENTE'), aprovado: conta('APROVADO'), encerrado: conta('ENCERRADO') },
        inicio_min: inicios[0] ?? null,
        fim_max: fins[fins.length - 1] ?? null,
        item_ids: meus.map((i) => i.id),
      };
    });
  }

  async detalhe(id: number) {
    const o = await this.prisma.ven_oferta.findUnique({ where: { id } });
    if (!o) return null;
    const itens = await this.prisma.ven_oferta_item.findMany({ where: { oferta_id: id }, orderBy: { id: 'asc' } });
    return { ...this.mapOferta(o), itens: itens.map((i) => this.mapItem(i)) };
  }

  /** Liquidação nasce com prêmio de 5% sobre o custo; campanha grava origem, fornecedor e prêmio informados; promoção, sem prêmio. */
  async criar(d: {
    nome: string;
    tipo: TipoOferta;
    criado_por: string | null;
    campanha?: { origem: OrigemOferta; fornecedor_codigo: number | null; fornecedor_nome: string | null; premio_tipo: string; premio_valor: number; premio_faixas: FaixaPremio[] };
  }) {
    const premio =
      d.tipo === 'LIQUIDACAO'
        ? { premio_tipo: 'PCT_CUSTO', premio_valor: 0.05 }
        : d.tipo === 'CAMPANHA' && d.campanha
          ? { ...d.campanha, premio_faixas: d.campanha.premio_faixas.map((f) => ({ a_partir_de: f.a_partir_de, valor: f.valor })) }
          : {};
    const r = await this.prisma.ven_oferta.create({ data: { nome: d.nome, tipo: d.tipo, criado_por: d.criado_por, ...premio } });
    return this.mapOferta(r);
  }

  async renomear(id: number, nome: string) {
    const r = await this.prisma.ven_oferta.update({ where: { id }, data: { nome, atualizado_em: new Date() } });
    return this.mapOferta(r);
  }

  async alterarPremio(id: number, p: { premio_tipo: string; premio_valor: number; premio_faixas: FaixaPremio[] }) {
    const premio_faixas = p.premio_faixas.map((f) => ({ a_partir_de: f.a_partir_de, valor: f.valor }));
    const r = await this.prisma.ven_oferta.update({ where: { id }, data: { premio_tipo: p.premio_tipo, premio_valor: p.premio_valor, premio_faixas, atualizado_em: new Date() } });
    return this.mapOferta(r);
  }

  /**
   * Unidades e valor vendidos por item da oferta: linhas de orçamento FECHADO que
   * levaram o preço da oferta (fora_promocao = false).
   */
  async vendidas(itemIds: number[]) {
    const saida = new Map<number, { qtd: number; valor: number }>();
    if (!itemIds.length) return saida;
    const rows = await this.prisma.ven_orcamento_item.groupBy({
      by: ['oferta_item_id'],
      where: { oferta_item_id: { in: itemIds }, fora_promocao: false, ven_orcamento: { status: 'FECHADO' } },
      _sum: { quantidade: true, total: true },
    });
    for (const r of rows) if (r.oferta_item_id != null) saida.set(r.oferta_item_id, { qtd: Number(r._sum.quantidade ?? 0), valor: Number(r._sum.total ?? 0) });
    return saida;
  }

  /**
   * Liquidações e campanhas com os itens; o período do grupo vai do menor início
   * ao maior fim dos itens que já saíram do rascunho (ver `contaNoPeriodo`).
   */
  async gruposComPremio() {
    const ofertas = await this.prisma.ven_oferta.findMany({ where: { tipo: { in: ['LIQUIDACAO', 'CAMPANHA'] } }, orderBy: { id: 'asc' } });
    if (!ofertas.length) return [];
    const itens = await this.prisma.ven_oferta_item.findMany({
      where: { oferta_id: { in: ofertas.map((o) => o.id) } },
      select: { id: true, oferta_id: true, pro_codigo: true, descricao: true, inicio: true, fim: true, status: true },
    });
    return ofertas.map((o) => {
      const meus = itens
        .filter((i) => i.oferta_id === o.id)
        .map((i) => ({ id: i.id, pro_codigo: i.pro_codigo, descricao: i.descricao, inicio: ymd(i.inicio), fim: ymd(i.fim), status: i.status as StatusOfertaItem }));
      const valeram = meus.filter(contaNoPeriodo);
      const inicios = valeram.map((i) => i.inicio).sort();
      const fins = valeram.map((i) => i.fim).sort();
      return { ...this.mapOferta(o), premio: premioDe(o), inicio: inicios[0] ?? null, fim: fins[fins.length - 1] ?? null, itens: meus };
    });
  }

  /** Vendedores com orçamento FECHADO que levou o preço de algum desses itens (fora_promocao = false). */
  async repsComOferta(itemIds: number[]): Promise<number[]> {
    if (!itemIds.length) return [];
    const rows = await this.prisma.ven_orcamento.findMany({
      where: { status: 'FECHADO', rep_codigo: { not: null }, itens: { some: { oferta_item_id: { in: itemIds }, fora_promocao: false } } },
      select: { rep_codigo: true },
      distinct: ['rep_codigo'],
    });
    return rows.map((r) => r.rep_codigo!);
  }

  /**
   * Trava por item de oferta (advisory lock do Postgres, preso a uma transação aberta) enquanto
   * `fn` roda: dois fechamentos do mesmo item correm um depois do outro, e o segundo lê o
   * vendido já com o primeiro FECHADO. Ids em ordem crescente para não travar em ciclo.
   */
  async comTrava<T>(itemIds: number[], fn: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        for (const id of [...new Set(itemIds)].sort((a, b) => a - b)) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ven_oferta_item'), ${id}::int)`;
        }
        return fn();
      },
      { maxWait: 30_000, timeout: 60_000 },
    );
  }

  private async nomesDosGrupos(ids: number[]) {
    const rows = ids.length ? await this.prisma.ven_oferta.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, nome: true, tipo: true, premio_tipo: true, premio_valor: true, premio_faixas: true } }) : [];
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Itens não encerrados dos produtos, com o nome do grupo — a conferência de sobreposição. */
  async naoEncerradosDosProdutos(codigos: number[]): Promise<ItemExistente[]> {
    if (!codigos.length) return [];
    const rows = await this.prisma.ven_oferta_item.findMany({ where: { pro_codigo: { in: codigos }, status: { not: 'ENCERRADO' } } });
    const grupos = await this.nomesDosGrupos(rows.map((r) => r.oferta_id));
    return rows.map((r) => {
      const i = this.mapItem(r);
      return { id: i.id, pro_codigo: i.pro_codigo, status: i.status, inicio: i.inicio, fim: i.fim, grupo: grupos.get(r.oferta_id)?.nome ?? '' };
    });
  }

  /** Itens aprovados dos produtos, com tipo e nome do grupo — o que o orçamento pode aplicar. */
  async aprovadosDosProdutos(codigos: number[]) {
    if (!codigos.length) return [];
    const rows = await this.prisma.ven_oferta_item.findMany({ where: { pro_codigo: { in: codigos }, status: 'APROVADO' } });
    const grupos = await this.nomesDosGrupos(rows.map((r) => r.oferta_id));
    return rows.map((r) => ({ ...this.mapItem(r), tipo: (grupos.get(r.oferta_id)?.tipo ?? 'PROMOCAO') as TipoOferta, grupo: grupos.get(r.oferta_id)?.nome ?? '', premio: premioDe(grupos.get(r.oferta_id) ?? { premio_tipo: null, premio_valor: null }) }));
  }

  async item(id: number) {
    const r = await this.prisma.ven_oferta_item.findUnique({ where: { id } });
    return r ? this.mapItem(r) : null;
  }

  async incluirItens(ofertaId: number, rows: Array<{ pro_codigo: number; descricao: string | null } & ItemEditavel>) {
    if (!rows.length) return;
    await this.prisma.ven_oferta_item.createMany({
      data: rows.map((r) => ({ oferta_id: ofertaId, ...r, inicio: dataDb(r.inicio), fim: dataDb(r.fim), status: 'RASCUNHO' })),
    });
  }

  /** Grava as mudanças dos itens juntas; aprovado que volta a PENDENTE perde aprovado_por/em. */
  async alterarItens(rows: Array<{ id: number; dados: Partial<ItemEditavel>; voltaPendente?: boolean }>) {
    if (!rows.length) return;
    await this.prisma.$transaction(
      rows.map(({ id, dados, voltaPendente }) =>
        this.prisma.ven_oferta_item.update({
          where: { id },
          data: {
            ...dados,
            inicio: dados.inicio ? dataDb(dados.inicio) : undefined,
            fim: dados.fim ? dataDb(dados.fim) : undefined,
            ...(voltaPendente ? { status: 'PENDENTE', aprovado_por: null, aprovado_em: null } : {}),
          },
        }),
      ),
    );
  }

  async removerItem(id: number) {
    await this.prisma.ven_oferta_item.delete({ where: { id } });
  }

  /** Itens APROVADO de todos os grupos — a apuração do encerramento. */
  async aprovados() {
    const rows = await this.prisma.ven_oferta_item.findMany({ where: { status: 'APROVADO' } });
    return rows.map((r) => this.mapItem(r));
  }

  /**
   * Avança os itens de etapa (RASCUNHO → PENDENTE grava enviado_por/em; PENDENTE → APROVADO
   * grava aprovado_por/em). Só muda o item que ainda está na etapa de origem.
   */
  async avancar(ids: number[], para: 'PENDENTE' | 'APROVADO', por: string | null) {
    if (!ids.length) return;
    const agora = new Date();
    const de = para === 'PENDENTE' ? 'RASCUNHO' : 'PENDENTE';
    const quem = para === 'PENDENTE' ? { enviado_por: por, enviado_em: agora } : { aprovado_por: por, aprovado_em: agora };
    await this.prisma.ven_oferta_item.updateMany({ where: { id: { in: ids }, status: de }, data: { status: para, ...quem } });
  }

  async encerrar(rows: Array<{ id: number; motivo: MotivoEncerramento; por?: string | null }>) {
    if (!rows.length) return;
    const agora = new Date();
    await this.prisma.$transaction(
      rows.map((r) =>
        this.prisma.ven_oferta_item.update({
          where: { id: r.id },
          data: { status: 'ENCERRADO', encerrado_motivo: r.motivo, encerrado_por: r.por ?? null, encerrado_em: agora },
        }),
      ),
    );
  }
}
