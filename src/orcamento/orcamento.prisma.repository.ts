import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExcecaoItem, FaixaVolume, RegraFaixa, REGUA_PADRAO, VOLUME_PADRAO } from './regua';

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

/** Uma chegada prevista de um produto: pedido de compra em aberto, com a data e de onde ela veio. */
export interface ChegadaPrevista {
  pro_codigo: number;
  descricao: string | null;
  marca: string | null;
  /** nº do pedido de compra (pedido_cotacao) */
  pedido: number;
  status: string | null;
  quantidade: number;
  /** YYYY-MM-DD */
  data: string;
  /** RASTREIO = CT-e da carga em trânsito; PEDIDO = previsão informada pelo compras */
  origem: 'RASTREIO' | 'PEDIDO';
  /** último evento do rastreio SSW, quando há */
  ult_evento: string | null;
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

  /** Escala de desconto por volume; sem linhas no banco, a escala padrão do código. */
  async volume(): Promise<FaixaVolume[]> {
    const rows = await this.prisma.ven_regua_volume.findMany({ where: { ativo: true }, orderBy: { qtd_min: 'asc' } });
    if (!rows.length) return VOLUME_PADRAO;
    return rows.map((r) => ({ qtd_min: r.qtd_min, fracao: Number(r.fracao) }));
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

  /**
   * EQUIVALENTES = mesmo grupo de similares da análise de estoque, com a MESMA
   * regra que o worker usa para consolidar demanda: mesma descrição + mesma
   * linha de marca (com_fifo_completo da última execução: group_id, pro_descricao,
   * marca_linha). Só o group_id não basta: grupos mesclados à mão viraram
   * "grupões" (o do para-brisa AMAROK 17 tem 46 vidros de veículos diferentes),
   * e sem o filtro de descrição a tela oferecia HILUX como substituto de AMAROK.
   */
  async equivalentes(proCodigo: number): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<Array<{ pro_codigo: string }>>`
      WITH ult AS (SELECT MAX(data_processamento) AS d FROM com_fifo_completo),
      eu AS (
        SELECT f.group_id, UPPER(TRIM(f.pro_descricao)) AS descr, COALESCE(f.marca_linha, 2) AS linha
        FROM com_fifo_completo f, ult WHERE f.pro_codigo = ${String(proCodigo)} AND f.data_processamento = ult.d
      )
      SELECT f.pro_codigo
      FROM com_fifo_completo f, ult, eu
      WHERE f.data_processamento = ult.d
        AND f.group_id = eu.group_id
        AND UPPER(TRIM(f.pro_descricao)) = eu.descr
        AND COALESCE(f.marca_linha, 2) = eu.linha
        AND f.pro_codigo <> ${String(proCodigo)}
    `;
    return rows.map((r) => Number(r.pro_codigo)).filter((c) => Number.isFinite(c));
  }

  /**
   * Grupo de similares de cada código (mesma regra de `equivalentes`) e todos
   * os membros desses grupos, numa consulta só — para a pesquisa mostrar o
   * principal com os similares encadeados abaixo. `chave` identifica o grupo.
   */
  async gruposDe(codigos: number[]): Promise<Array<{ pro_codigo: number; chave: string }>> {
    if (!codigos.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ pro_codigo: string; chave: string }>>`
      WITH ult AS (SELECT MAX(data_processamento) AS d FROM com_fifo_completo),
      eu AS (
        SELECT DISTINCT f.group_id, UPPER(TRIM(f.pro_descricao)) AS descr, COALESCE(f.marca_linha, 2) AS linha
        FROM com_fifo_completo f
        JOIN ult ON f.data_processamento = ult.d
        WHERE f.pro_codigo IN (${Prisma.join(codigos.map(String))})
      )
      SELECT f.pro_codigo, (eu.group_id || '|' || eu.descr || '|' || eu.linha) AS chave
      FROM com_fifo_completo f
      JOIN ult ON f.data_processamento = ult.d
      JOIN eu ON eu.group_id = f.group_id
             AND UPPER(TRIM(f.pro_descricao)) = eu.descr
             AND COALESCE(f.marca_linha, 2) = eu.linha
    `;
    // Junção explícita em todas as fontes: com "FROM f, ult JOIN eu ON ... f.x" o Postgres
    // não enxerga `f` dentro do ON (invalid reference to FROM-clause entry) e a pesquisa
    // devolvia tudo como grupo de um só.
    return rows.map((r) => ({ pro_codigo: Number(r.pro_codigo), chave: r.chave })).filter((r) => Number.isFinite(r.pro_codigo));
  }

  /** Quais destes códigos têm ao menos um equivalente (mesma regra de `equivalentes`). */
  async temGrupo(codigos: number[]): Promise<Set<number>> {
    if (!codigos.length) return new Set();
    const rows = await this.prisma.$queryRaw<Array<{ pro_codigo: string }>>`
      WITH ult AS (SELECT MAX(data_processamento) AS d FROM com_fifo_completo)
      SELECT a.pro_codigo
      FROM com_fifo_completo a, ult
      WHERE a.data_processamento = ult.d
        AND a.pro_codigo IN (${Prisma.join(codigos.map(String))})
        AND EXISTS (
          SELECT 1 FROM com_fifo_completo b
          WHERE b.data_processamento = ult.d
            AND b.group_id = a.group_id
            AND b.pro_codigo <> a.pro_codigo
            AND UPPER(TRIM(b.pro_descricao)) = UPPER(TRIM(a.pro_descricao))
            AND COALESCE(b.marca_linha, 2) = COALESCE(a.marca_linha, 2)
        )
    `;
    return new Set(rows.map((r) => Number(r.pro_codigo)));
  }

  /**
   * Previsão de chegada dos produtos em pedido de compra ainda não entregue — o que o
   * vendedor responde quando o item está sem saldo. Por item de pedido, a data vem:
   *   1. do CT-e da NF vinculada que traz o produto, enquanto a carga está em trânsito
   *      (previsão gravada pelo rastreio SSW; sem ela, a previsão de entrega do próprio CT-e);
   *   2. senão, da previsão de chegada que o compras pôs no pedido.
   * Pedido "Entregue parcialmente" só entra pelo caminho 1: sem carga em trânsito não dá
   * para saber se aquele item já chegou. Data vencida há mais de 30 dias é descartada
   * (pedido velho que ninguém encerrou). Ficam de fora o item marcado `nao_atendido` e o
   * pedido ainda em análise (não foi comprado: prometer a data dele seria chute).
   */
  async chegadasPrevistas(codigos: number[]): Promise<ChegadaPrevista[]> {
    if (!codigos.length) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{ pro_codigo: number; descricao: string | null; marca: string | null; pedido: number; status: string | null; quantidade: unknown; data: string; origem: string; ult_evento: string | null }>
    >`
      SELECT x.pro_codigo, x.descricao, x.marca, x.pedido, x.status, x.quantidade,
             COALESCE(x.prev_cte, x.prev_pedido) AS data,
             CASE WHEN x.prev_cte IS NOT NULL THEN 'RASTREIO' ELSE 'PEDIDO' END AS origem,
             x.ult_evento
      FROM (
        SELECT i.pro_codigo, i.pro_descricao AS descricao, i.mar_descricao AS marca, p.pedido_cotacao AS pedido, p.status, i.quantidade,
               to_char(p.previsao_chegada AT TIME ZONE 'America/Cuiaba', 'YYYY-MM-DD') AS prev_pedido,
               r.prev AS prev_cte, r.ult_evento
        FROM com_pedido_itens i
        JOIN com_pedido p ON p.id = i.pedido_id
        LEFT JOIN LATERAL (
          SELECT MIN(COALESCE(to_char(c.rastreio_previsao, 'YYYY-MM-DD'), NULLIF(LEFT(c.dados_json->>'prevEntrega', 10), ''))) AS prev,
                 MAX(c.rastreio_ult_evento) AS ult_evento
          FROM com_pedido_nfe_vinculo v
          JOIN com_pedido_nfe_vinculo_item vi ON vi.vinculo_id = v.id AND vi.pro_codigo = i.pro_codigo
          JOIN com_cte_documento c ON c.dados_json->'documentosNFe' @> to_jsonb(v.chave_nfe::text)
          WHERE v.pedido_id = p.id AND v.confirmado AND NOT v.rejeitado
            AND c.rastreio_entregue_em IS NULL AND c.status <> 'LANCADA'
        ) r ON true
        WHERE i.pro_codigo IN (${Prisma.join(codigos)})
          AND i.quantidade > 0
          AND COALESCE(i.status_item, '') <> 'nao_atendido'
          AND COALESCE(p.status, '') NOT IN ('Entregue', 'Cancelado', 'Aguardando analise')
      ) x
      WHERE COALESCE(x.prev_cte, CASE WHEN x.status = 'Entregue parcialmente' THEN NULL ELSE x.prev_pedido END) IS NOT NULL
        AND COALESCE(x.prev_cte, x.prev_pedido) >= to_char(now() - interval '30 days', 'YYYY-MM-DD')
      ORDER BY x.pro_codigo, 7
    `;
    return rows.map((r) => ({
      pro_codigo: Number(r.pro_codigo),
      descricao: r.descricao,
      marca: r.marca,
      pedido: Number(r.pedido),
      status: r.status,
      quantidade: Number(r.quantidade),
      data: r.data,
      origem: r.origem === 'RASTREIO' ? 'RASTREIO' : 'PEDIDO',
      ult_evento: r.ult_evento,
    }));
  }

  /**
   * Itens de NF de compra JÁ LANÇADA na empresa fiscal (`com_nfe_conciliacao.status_erp`),
   * vinculada a pedido e com o produto — candidatos a "aguardando liberação": a nota entra
   * na empresa 1 quando chega, mas só vai para a empresa 3 (onde está o saldo de venda) quando
   * a conferência do recebimento termina. Quem decide se já foi é o ERP (ver o serviço).
   * Janela de 45 dias pela entrada: nota mais velha que isso sem ir para a 3 é caso de cadastro.
   */
  async itensDeNfLancada(codigos: number[]): Promise<Array<{ pro_codigo: number; chave_nfe: string; pedido: number; quantidade: number; dt_entrada: string | null }>> {
    if (!codigos.length) return [];
    const rows = await this.prisma.$queryRaw<Array<{ pro_codigo: number; chave_nfe: string; pedido: number; quantidade: unknown; dt_entrada: string | null }>>`
      SELECT vi.pro_codigo, v.chave_nfe, p.pedido_cotacao AS pedido,
             SUM(COALESCE(vi.quantidade_alocada, vi.quantidade_xml, 0)) AS quantidade,
             to_char(n.dt_entrada, 'YYYY-MM-DD') AS dt_entrada
      FROM com_pedido_nfe_vinculo v
      JOIN com_pedido_nfe_vinculo_item vi ON vi.vinculo_id = v.id
      JOIN com_pedido p ON p.id = v.pedido_id
      JOIN com_nfe_conciliacao n ON n.chave_nfe = v.chave_nfe
      WHERE vi.pro_codigo IN (${Prisma.join(codigos)})
        AND v.confirmado AND NOT v.rejeitado
        AND n.status_erp = 'LANCADA'
        AND COALESCE(n.dt_entrada, n.updated_at) >= now() - interval '45 days'
      GROUP BY vi.pro_codigo, v.chave_nfe, p.pedido_cotacao, n.dt_entrada
    `;
    return rows.map((r) => ({ pro_codigo: Number(r.pro_codigo), chave_nfe: r.chave_nfe, pedido: Number(r.pedido), quantidade: Number(r.quantidade), dt_entrada: r.dt_entrada }));
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

  /** Vendem juntos no nível do SUBGRUPO (o que sai junto com qualquer item dele). */
  async relacionadosSubgrupo(subgrpCodigo: number, limite = 15) {
    const rows = await this.prisma.ven_subgrupo_relacionado.findMany({
      where: { subgrp_codigo: subgrpCodigo },
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

  async gravarRelacionadosSubgrupo(
    pares: Array<{ subgrp_codigo: number; pro_relacionado: number; juntos: number; base: number; suporte_pct: number }>,
  ): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      await tx.ven_subgrupo_relacionado.deleteMany({});
      for (let i = 0; i < pares.length; i += 2000) {
        await tx.ven_subgrupo_relacionado.createMany({ data: pares.slice(i, i + 2000) });
      }
    });
    return pares.length;
  }

  async relacionadosCalculadoEm(): Promise<Date | null> {
    const r = await this.prisma.ven_produto_relacionado.findFirst({ orderBy: { calculado_em: 'desc' } });
    return r?.calculado_em ?? null;
  }

  /** Orçamentos do Celta que já têm motivo de perda registrado (CRM fase 1). */
  async celtaComDesfecho(orcamentos: number[]): Promise<Set<number>> {
    if (!orcamentos.length) return new Set();
    const rows = await this.prisma.ven_orcamento_desfecho.findMany({
      where: { empresa: 3, orcamento: { in: orcamentos } },
      select: { orcamento: true },
    });
    return new Set(rows.map((r) => r.orcamento));
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
      promocao_codigo: i.promocao_codigo ?? null,
      promocao_fim: i.promocao_fim ? new Date(i.promocao_fim).toISOString().slice(0, 10) : null,
      qtd_encomenda: n(i.qtd_encomenda),
      fora_promocao: !!i.fora_promocao,
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
      cp_codigo: o.cp_codigo ?? null,
      cp_descricao: o.cp_descricao ?? null,
      fp_codigo: o.fp_codigo ?? null,
      fp_descricao: o.fp_descricao ?? null,
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
      celta_orcamento: o.celta_orcamento ?? null,
      celta_importado_em: o.celta_importado_em ?? null,
      usuario_id: o.usuario_id,
      usuario_nome: o.usuario_nome,
      created_at: o.created_at,
      updated_at: o.updated_at,
      comparado: o.comparado ?? null,
      liberadogerencia: o.liberadogerencia ?? false,
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

  /**
   * Fila do cron do comparativo: orçamentos já importados no Celta (têm nº) que
   * ainda não bateram. Quem bate vira comparado = true e sai daqui sozinho.
   */
  pendentesComparacao() {
    return this.prisma.ven_orcamento.findMany({
      where: { celta_orcamento: { not: null }, comparado: false },
      select: { id: true, numero: true, empresa: true, cli_codigo: true, cli_nome: true, rep_codigo: true, rep_nome: true, celta_orcamento: true, liberadogerencia: true },
      orderBy: { celta_importado_em: 'asc' },
    });
  }

  /**
   * Trava de orçamento NOVO do vendedor: `orcamentoBloqueado` no cadastro E ao
   * menos um orçamento divergente (importado, comparado = false) que a gerência
   * NÃO liberou (`liberadogerencia` ≠ true). Liberado pela gerência não trava,
   * mesmo que o comparativo continue divergindo.
   */
  async travaDoRep(rep_codigo: number) {
    const [usuarios, pendentes] = await Promise.all([
      this.prisma.sis_usuarios.findMany({ where: { vendas_rep_codigo: rep_codigo, trash: 0 }, select: { orcamentoBloqueado: true } }),
      this.prisma.ven_orcamento.findMany({
        where: { rep_codigo, comparado: false, celta_orcamento: { not: null }, NOT: { liberadogerencia: true } },
        select: { id: true, numero: true, celta_orcamento: true, cli_nome: true },
        orderBy: { celta_importado_em: 'asc' },
      }),
    ]);
    const bloqueado = usuarios.some((u) => u.orcamentoBloqueado === true);
    return { rep_codigo, bloqueado, pendentes, travado: bloqueado && pendentes.length > 0 };
  }

  /** Comparativo bateu em tudo: comparado = true. */
  async marcarComparado(id: string) {
    await this.prisma.ven_orcamento.update({ where: { id }, data: { comparado: true } });
  }

  /**
   * Divergência: orcamentoBloqueado = true para quem tem o vendas_rep_codigo.
   * Devolve quantos MUDARAM de estado (já bloqueado não conta) — é o que decide
   * se vale emitir aviso, para o cron não avisar de novo a cada 30 s.
   */
  async bloquearRep(rep_codigo: number): Promise<number> {
    const { count } = await this.prisma.sis_usuarios.updateMany({
      // A coluna é nula para quem nunca foi bloqueado: `NOT (x = true)` no SQL pularia os nulos.
      where: { vendas_rep_codigo: rep_codigo, OR: [{ orcamentoBloqueado: false }, { orcamentoBloqueado: null }] },
      data: { orcamentoBloqueado: true },
    });
    return count;
  }

  /**
   * Grava o resultado do comparativo; divergência bloqueia o vendedor
   * (sis_usuarios.vendas_rep_codigo = rep_codigo), salvo se a gerência já liberou
   * este orçamento (`liberadoGerencia`).
   */
  async gravarComparacao(id: string, comparado: boolean, rep_codigo: number | null, liberadoGerencia = false) {
    await this.prisma.$transaction(async (tx) => {
      await tx.ven_orcamento.update({ where: { id }, data: { comparado } });
      if (!comparado && rep_codigo != null && !liberadoGerencia) {
        await tx.sis_usuarios.updateMany({ where: { vendas_rep_codigo: rep_codigo }, data: { orcamentoBloqueado: true } });
      }
    });
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

  /**
   * Venda perdida por falta de saldo ao concluir o orçamento: uma linha por item
   * e orçamento (reabrir e decidir de novo atualiza a quantidade, não duplica).
   */
  async registrarVendaPerdida(
    o: { id: string; numero: number; cli_codigo: number; rep_codigo: number | null },
    linhas: Array<{ pro_codigo: number; descricao: string | null; quantidade: number; similar_disponivel?: string | null; justificativa?: string | null }>,
    usuario?: { usuario_id?: string; usuario_nome?: string },
  ) {
    for (const l of linhas) {
      const extras = { similar_disponivel: l.similar_disponivel ?? null, justificativa: l.justificativa ?? null };
      await this.prisma.ven_venda_perdida.upsert({
        where: { orcamento_id_pro_codigo: { orcamento_id: o.id, pro_codigo: l.pro_codigo } },
        create: {
          orcamento_id: o.id,
          orcamento_numero: o.numero,
          pro_codigo: l.pro_codigo,
          descricao: l.descricao,
          quantidade: l.quantidade,
          cli_codigo: o.cli_codigo,
          rep_codigo: o.rep_codigo,
          usuario_id: usuario?.usuario_id ?? null,
          usuario_nome: usuario?.usuario_nome ?? null,
          ...extras,
        },
        update: { quantidade: l.quantidade, usuario_id: usuario?.usuario_id ?? null, usuario_nome: usuario?.usuario_nome ?? null, created_at: new Date(), ...extras },
      });
    }
  }

  /** Orçamentos abertos deste vendedor (ENVIADO/APROVACAO) — para a bolsa projetada. */
  async abertosDoVendedor(rep: number) {
    return this.prisma.ven_orcamento.findMany({
      where: { rep_codigo: rep, status: { in: ['ENVIADO', 'APROVACAO'] } },
      select: {
        id: true, numero: true, cli_nome: true, total: true, desconto_total: true, subtotal: true,
        itens: { select: { quantidade: true, custo_ref: true, total: true } },
      },
    });
  }
}
