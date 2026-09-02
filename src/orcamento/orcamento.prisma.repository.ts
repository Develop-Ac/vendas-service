import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcecaoItem, RegraFaixa, REGUA_PADRAO } from './regua';

/* =============================================================================
   ORÇAMENTO — persistência no Postgres da intranet.
   -----------------------------------------------------------------------------
   Régua e exceções (leitura), o orçamento em si (escrita), os grupos de
   similares da análise de estoque (com_relacionamento_itens — a fonte dos
   EQUIVALENTES) e os pares "vendem juntos" apurados no BI.
   ============================================================================= */

const n = (v: unknown): number => (v == null ? 0 : Number(v));
const nn = (v: unknown): number | null => (v == null ? null : Number(v));

export interface GiroItem {
  pro_codigo: number;
  curva_abc: string | null;
  categoria_saldo_atual: string | null;
  tempo_medio_saldo_atual: number | null;
  tendencia_label: string | null;
  group_id: string | null;
}

@Injectable()
export class OrcamentoPrismaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /* ------------------------------------------------------------- régua */

  /** Régua vigente; sem linhas no banco, a régua padrão do código. */
  async regua(): Promise<RegraFaixa[]> {
    const rows = await this.prisma.ven_regua_atacado.findMany({ where: { ativo: true } });
    if (!rows.length) return REGUA_PADRAO;
    return rows.map((r) => ({
      classe: r.classe as RegraFaixa['classe'],
      faixa: r.faixa as RegraFaixa['faixa'],
      markup: Number(r.markup),
      desc_max: Number(r.desc_max),
    }));
  }

  async excecoes(codigos: number[]): Promise<Map<number, ExcecaoItem>> {
    const saida = new Map<number, ExcecaoItem>();
    if (!codigos.length) return saida;
    const hoje = new Date();
    const rows = await this.prisma.ven_regua_item_excecao.findMany({
      where: {
        pro_codigo: { in: codigos },
        OR: [{ vigente_ate: null }, { vigente_ate: { gte: hoje } }],
      },
    });
    for (const r of rows) {
      saida.set(r.pro_codigo, {
        classe: r.classe as ExcecaoItem['classe'],
        desc_max: nn(r.desc_max),
        motivo: r.motivo,
      });
    }
    return saida;
  }

  async listarExcecoes() {
    const rows = await this.prisma.ven_regua_item_excecao.findMany({ orderBy: { updated_at: 'desc' } });
    return rows.map((r) => ({ ...r, desc_max: nn(r.desc_max) }));
  }

  async salvarExcecao(
    proCodigo: number,
    dto: { classe: 'EXCLUSIVO' | 'OPORTUNIDADE'; desc_max?: number | null; motivo?: string; vigente_ate?: string | null; criado_por?: string; remover?: boolean },
  ) {
    if (dto.remover) {
      await this.prisma.ven_regua_item_excecao.deleteMany({ where: { pro_codigo: proCodigo } });
      return { pro_codigo: proCodigo, removido: true };
    }
    const data = {
      classe: dto.classe,
      desc_max: dto.desc_max ?? null,
      motivo: dto.motivo ?? null,
      vigente_ate: dto.vigente_ate ? new Date(`${dto.vigente_ate}T00:00:00`) : null,
      criado_por: dto.criado_por ?? null,
    };
    const r = await this.prisma.ven_regua_item_excecao.upsert({
      where: { pro_codigo: proCodigo },
      create: { pro_codigo: proCodigo, ...data },
      update: data,
    });
    return { ...r, desc_max: nn(r.desc_max) };
  }

  /* ------------------------------------------------ equivalentes e giro */

  /** Quais destes códigos pertencem a algum grupo de similares (têm equivalente). */
  async temGrupo(codigos: number[]): Promise<Set<number>> {
    if (!codigos.length) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ pro_codigo: string }>>`
      SELECT r.pro_codigo FROM com_relacionamento_itens r
      WHERE r.pro_codigo IN (${Prisma.join(codigos.map(String))})
        AND (SELECT COUNT(*) FROM com_relacionamento_itens g WHERE g.group_id = r.group_id) > 1
    `;
    return new Set(rows.map((r) => Number(r.pro_codigo)));
  }


  /**
   * Os equivalentes de um produto = os outros membros do seu grupo de
   * similares (com_relacionamento_itens, mantido pelo analise-estoque-service:
   * mesma descrição + mesma linha de marca). Sem grupo, sem equivalente.
   */
  async equivalentes(proCodigo: number): Promise<number[]> {
    const eu = await this.prisma.com_relacionamento_itens.findUnique({
      where: { pro_codigo: String(proCodigo) },
    });
    if (!eu) return [];
    const membros = await this.prisma.com_relacionamento_itens.findMany({
      where: { group_id: eu.group_id, NOT: { pro_codigo: String(proCodigo) } },
    });
    return membros.map((m) => Number(m.pro_codigo)).filter((c) => Number.isFinite(c));
  }

  /** Curva, situação do saldo e tendência (última execução da análise de estoque). */
  async giro(codigos: number[]): Promise<Map<number, GiroItem>> {
    const saida = new Map<number, GiroItem>();
    if (!codigos.length) return saida;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT f.pro_codigo, f.curva_abc, f.categoria_saldo_atual, f.tempo_medio_saldo_atual,
             f.tendencia_label, f.group_id
      FROM com_fifo_completo f
      WHERE f.pro_codigo IN (${Prisma.join(codigos.map(String))})
        AND f.data_processamento = (SELECT MAX(data_processamento) FROM com_fifo_completo)
    `;
    for (const r of rows) {
      saida.set(Number(r.pro_codigo), {
        pro_codigo: Number(r.pro_codigo),
        curva_abc: r.curva_abc ?? null,
        categoria_saldo_atual: r.categoria_saldo_atual ?? null,
        tempo_medio_saldo_atual: nn(r.tempo_medio_saldo_atual),
        tendencia_label: r.tendencia_label ?? null,
        group_id: r.group_id ?? null,
      });
    }
    return saida;
  }

  /* ------------------------------------------------------ vendem juntos */

  async relacionados(proCodigo: number, limite = 8) {
    const rows = await this.prisma.ven_produto_relacionado.findMany({
      where: { pro_codigo: proCodigo },
      orderBy: [{ juntos: 'desc' }, { suporte_pct: 'desc' }],
      take: limite,
    });
    return rows.map((r) => ({
      pro_codigo: r.pro_relacionado,
      juntos: r.juntos,
      base: r.base,
      suporte_pct: Number(r.suporte_pct),
      calculado_em: r.calculado_em,
    }));
  }

  /** Troca a tabela inteira pela apuração nova, numa transação. */
  async gravarRelacionados(
    pares: Array<{ pro_codigo: number; pro_relacionado: number; juntos: number; base: number; suporte_pct: number }>,
  ): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ven_produto_relacionado.deleteMany({});
      for (let i = 0; i < pares.length; i += 2000) {
        await tx.ven_produto_relacionado.createMany({ data: pares.slice(i, i + 2000) });
      }
    });
    return pares.length;
  }

  async relacionadosCalculadoEm(): Promise<Date | null> {
    const r = await this.prisma.ven_produto_relacionado.findFirst({ orderBy: { calculado_em: 'desc' } });
    return r?.calculado_em ?? null;
  }

  /* ----------------------------------------------------------- orçamento */

  private mapItem(i: any) {
    return {
      id: i.id,
      item: i.item,
      pro_codigo: i.pro_codigo,
      descricao: i.descricao,
      referencia: i.referencia,
      unidade: i.unidade,
      quantidade: n(i.quantidade),
      preco_tabela: n(i.preco_tabela),
      tabela_coluna: i.tabela_coluna,
      preco_unit: n(i.preco_unit),
      desc_pct: n(i.desc_pct),
      total: n(i.total),
      custo_ref: nn(i.custo_ref),
      classe: i.classe,
      mix: i.mix,
      faixa: i.faixa,
      markup_regua: nn(i.markup_regua),
      desc_max_pct: nn(i.desc_max_pct),
      preco_minimo: nn(i.preco_minimo),
      acima_alcada: !!i.acima_alcada,
      estoque_disponivel: nn(i.estoque_disponivel),
      substituto_de: i.substituto_de,
      observacao: i.observacao,
    };
  }

  mapOrcamento(o: any) {
    return {
      id: o.id,
      numero: o.numero,
      empresa: o.empresa,
      cli_codigo: o.cli_codigo,
      cli_nome: o.cli_nome,
      tabela_preco: o.tabela_preco,
      rep_codigo: o.rep_codigo,
      rep_nome: o.rep_nome,
      status: o.status,
      validade: o.validade ? new Date(o.validade).toISOString().slice(0, 10) : null,
      observacao: o.observacao,
      subtotal: n(o.subtotal),
      desconto_total: n(o.desconto_total),
      total: n(o.total),
      desc_pct: n(o.desc_pct),
      acima_alcada: !!o.acima_alcada,
      bolsa_pct_antes: nn(o.bolsa_pct_antes),
      bolsa_pct_depois: nn(o.bolsa_pct_depois),
      aprovado_por: o.aprovado_por,
      aprovado_em: o.aprovado_em,
      enviado_em: o.enviado_em,
      desfecho_em: o.desfecho_em,
      desfecho_motivo: o.desfecho_motivo,
      desfecho_ref: o.desfecho_ref,
      usuario_id: o.usuario_id,
      usuario_nome: o.usuario_nome,
      created_at: o.created_at,
      updated_at: o.updated_at,
      itens: Array.isArray(o.itens) ? o.itens.map((i: any) => this.mapItem(i)) : undefined,
    };
  }

  async listar(f: { rep_codigo?: number; cli_codigo?: number; status?: string; page?: number; pageSize?: number }) {
    const where: Prisma.ven_orcamentoWhereInput = {};
    if (f.rep_codigo != null) where.rep_codigo = f.rep_codigo;
    if (f.cli_codigo != null) where.cli_codigo = f.cli_codigo;
    if (f.status) where.status = f.status;
    const page = Math.max(1, f.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.ven_orcamento.count({ where }),
      this.prisma.ven_orcamento.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, itens: rows.map((r) => this.mapOrcamento(r)) };
  }

  async obter(id: string) {
    const o = await this.prisma.ven_orcamento.findUnique({
      where: { id },
      include: { itens: { orderBy: { item: 'asc' } } },
    });
    return o ? this.mapOrcamento(o) : null;
  }

  async criar(cab: Prisma.ven_orcamentoUncheckedCreateInput, itens: Prisma.ven_orcamento_itemUncheckedCreateInput[]) {
    const o = await this.prisma.ven_orcamento.create({
      data: { ...cab, itens: { create: itens.map(({ orcamento_id: _o, ...i }) => i) } },
      include: { itens: { orderBy: { item: 'asc' } } },
    });
    return this.mapOrcamento(o);
  }

  /** Regrava cabeçalho e itens (os itens são substituídos por inteiro). */
  async atualizar(
    id: string,
    cab: Prisma.ven_orcamentoUncheckedUpdateInput,
    itens?: Prisma.ven_orcamento_itemUncheckedCreateInput[],
  ) {
    const o = await this.prisma.$transaction(async (tx) => {
      if (itens) {
        await tx.ven_orcamento_item.deleteMany({ where: { orcamento_id: id } });
        if (itens.length) await tx.ven_orcamento_item.createMany({ data: itens });
      }
      return tx.ven_orcamento.update({
        where: { id },
        data: cab,
        include: { itens: { orderBy: { item: 'asc' } } },
      });
    });
    return this.mapOrcamento(o);
  }

  /** Orçamentos abertos deste vendedor (ENVIADO/APROVACAO) — para a bolsa projetada. */
  async abertosDoVendedor(rep: number) {
    return this.prisma.ven_orcamento.findMany({
      where: { rep_codigo: rep, status: { in: ['ENVIADO', 'APROVACAO'] } },
      select: { id: true, numero: true, cli_nome: true, total: true, desconto_total: true, subtotal: true },
    });
  }
}
