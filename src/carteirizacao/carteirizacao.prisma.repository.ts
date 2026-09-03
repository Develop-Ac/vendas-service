import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface RegistrarHistoricoInput {
  cli_codigo: number;
  rep_codigo_anterior?: number | null;
  rep_nome_anterior?: string | null;
  rep_codigo_novo?: number | null;
  rep_nome_novo?: string | null;
  acao: string;
  motivo?: string | null;
  usuario_id?: string | null;
  usuario_nome?: string | null;
  lote_id?: string | null;
}

@Injectable()
export class CarteirizacaoPrismaRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Toda a carteira ativa (overlay). Universo pequeno -> carregamos tudo. */
  async listarCarteira() {
    return this.prisma.ven_carteira_cliente.findMany({ where: { trash: 0 } });
  }

  /** Todas as linhas do overlay (inclusive trash=1) — usado na sincronização (diff/reativação). */
  async listarTodos() {
    return this.prisma.ven_carteira_cliente.findMany();
  }

  /** Qtde de clientes na carteira (overlay) de um vendedor. */
  async contarCarteira(rep_codigo: number) {
    return this.prisma.ven_carteira_cliente.count({ where: { rep_codigo, trash: 0 } });
  }

  /** Qtde de clientes na carteira de um conjunto de vendedores (supervisão). */
  async contarCarteiraReps(reps: number[]) {
    if (!reps.length) return 0;
    return this.prisma.ven_carteira_cliente.count({ where: { rep_codigo: { in: reps }, trash: 0 } });
  }

  async obterCliente(cli_codigo: number) {
    return this.prisma.ven_carteira_cliente.findUnique({ where: { cli_codigo } });
  }

  async upsertAtribuicao(params: {
    cli_codigo: number;
    rep_codigo: number | null;
    rep_nome: string | null;
    canal?: string | null;
    origem: string;
    observacao?: string | null;
    atribuido_por?: string | null;
  }) {
    const { cli_codigo, ...rest } = params;
    // Atribuir/confirmar um vendedor encerra qualquer pendência de revisão.
    const limparRevisao = { revisao: 0, revisao_motivo: null, revisao_em: null };
    return this.prisma.ven_carteira_cliente.upsert({
      where: { cli_codigo },
      create: { cli_codigo, ...rest, ...limparRevisao, atribuido_em: new Date(), trash: 0 },
      update: { ...rest, ...limparRevisao, atribuido_em: new Date(), trash: 0 },
    });
  }

  /**
   * Sincronização ERP: cliente saiu do atacado (sumiu da base 2/5). Fica sem vendedor,
   * permanece na carteira (trash=0) e é marcado para revisão aguardando confirmação manual.
   */
  async marcarRevisao(cli_codigo: number, motivo: string) {
    return this.prisma.ven_carteira_cliente.update({
      where: { cli_codigo },
      data: {
        rep_codigo: null,
        rep_nome: null,
        origem: 'SYNC_ERP',
        revisao: 1,
        revisao_motivo: motivo,
        revisao_em: new Date(),
        updated_at: new Date(),
      },
    });
  }

  /**
   * Sincronização ERP: cliente está no atacado (na base) mas sem rep no ERP — zera
   * vendedor e limpa eventual flag de revisão (não saiu do atacado).
   */
  async zerarVendedor(cli_codigo: number) {
    return this.prisma.ven_carteira_cliente.update({
      where: { cli_codigo },
      data: {
        rep_codigo: null,
        rep_nome: null,
        origem: 'SYNC_ERP',
        revisao: 0,
        revisao_motivo: null,
        revisao_em: null,
        updated_at: new Date(),
      },
    });
  }

  /** Remoção lógica (preserva histórico). */
  async removerCliente(cli_codigo: number) {
    return this.prisma.ven_carteira_cliente.update({
      where: { cli_codigo },
      data: { rep_codigo: null, rep_nome: null, trash: 1, updated_at: new Date() },
    });
  }

  async registrarHistorico(input: RegistrarHistoricoInput) {
    return this.prisma.ven_carteira_historico.create({ data: input });
  }

  async registrarHistoricoMuitos(inputs: RegistrarHistoricoInput[]) {
    if (!inputs.length) return { count: 0 };
    return this.prisma.ven_carteira_historico.createMany({ data: inputs });
  }

  async listarHistoricoCliente(cli_codigo: number) {
    return this.prisma.ven_carteira_historico.findMany({
      where: { cli_codigo },
      orderBy: { created_at: 'desc' },
    });
  }

  // -------------------------------------------------------- config vendedor
  async listarConfigs() {
    return this.prisma.ven_carteira_vendedor_config.findMany();
  }

  async getConfig(rep_codigo: number) {
    return this.prisma.ven_carteira_vendedor_config.findUnique({ where: { rep_codigo } });
  }

  async upsertConfig(params: {
    rep_codigo: number;
    rep_nome?: string | null;
    capacidade_max?: number | null;
    canal?: string | null;
    ativo?: boolean;
    meta_faturamento?: number | null;
    observacao?: string | null;
  }) {
    const { rep_codigo, ...rest } = params;
    return this.prisma.ven_carteira_vendedor_config.upsert({
      where: { rep_codigo },
      create: { rep_codigo, ...rest },
      update: { ...rest, updated_at: new Date() },
    });
  }

  // --------------------------------------------------------- metas vendedor
  async listarMetasPeriodo(ano: number, mes: number) {
    return this.prisma.ven_meta_vendedor.findMany({ where: { ano, mes } });
  }

  /** Feriados de um mês (sis_feriados). Retorna os dias do mês (1-31) que são feriado. */
  async diasFeriadosDoMes(ano: number, mes: number): Promise<number[]> {
    const inicio = new Date(Date.UTC(ano, mes - 1, 1));
    const fim = new Date(Date.UTC(ano, mes, 1));
    const rows = await this.prisma.sis_feriados.findMany({
      where: { data: { gte: inicio, lt: fim } },
      select: { data: true },
    });
    return [...new Set(rows.map((r) => new Date(r.data).getUTCDate()))];
  }

  async upsertMeta(params: {
    rep_codigo: number;
    rep_nome?: string | null;
    ano: number;
    mes: number;
    valor_meta: number;
    observacao?: string | null;
    atualizado_por?: string | null;
  }) {
    const { rep_codigo, ano, mes, ...rest } = params;
    return this.prisma.ven_meta_vendedor.upsert({
      where: { rep_codigo_ano_mes: { rep_codigo, ano, mes } },
      create: { rep_codigo, ano, mes, ...rest },
      update: { ...rest, updated_at: new Date() },
    });
  }

  /** Para o seed: insere muitas atribuições de uma vez (ignora as já existentes). */
  async semearMuitos(
    rows: Array<{
      cli_codigo: number;
      rep_codigo: number | null;
      rep_nome: string | null;
      origem: string;
    }>,
  ) {
    if (!rows.length) return { count: 0 };
    return this.prisma.ven_carteira_cliente.createMany({
      data: rows.map((r) => ({ ...r, atribuido_em: new Date(), trash: 0 })),
      skipDuplicates: true,
    });
  }

  // ================================================== fila do dia (fase 1)
  /** Tarefas em andamento (ABERTA/ESCALADA), opcionalmente de um vendedor. */
  async tarefasEmAndamento(rep_codigo?: number) {
    return this.prisma.ven_fila_tarefa.findMany({
      where: {
        status: { in: ['ABERTA', 'ESCALADA'] },
        ...(rep_codigo != null ? { rep_codigo } : {}),
      },
      orderBy: { prazo_em: 'asc' },
    });
  }

  /** Tarefas concluídas a partir de um corte (feedback "fechou sozinha" na tela). */
  async tarefasConcluidasDesde(desde: Date, rep_codigo?: number) {
    return this.prisma.ven_fila_tarefa.findMany({
      where: {
        status: 'CONCLUIDA',
        concluida_em: { gte: desde },
        ...(rep_codigo != null ? { rep_codigo } : {}),
      },
      orderBy: { concluida_em: 'desc' },
    });
  }

  /**
   * Cria as tarefas geradas pela régua. O unique parcial do banco
   * (uq_ven_fila_tarefa_andamento) barra duplicata de cliente em andamento em
   * corrida; aqui o skipDuplicates não cobre índice parcial, então a geração
   * filtra antes por `tarefasEmAndamento`.
   */
  async criarTarefas(
    rows: Array<{
      tipo: string;
      cli_codigo: number;
      cli_nome: string | null;
      rep_codigo: number | null;
      rep_nome: string | null;
      curva: string | null;
      motivo_geracao: string;
      prazo_em: Date;
    }>,
  ) {
    if (!rows.length) return { count: 0 };
    return this.prisma.ven_fila_tarefa.createMany({ data: rows });
  }

  async concluirTarefa(id: string, sinal: string, quando: Date) {
    return this.prisma.ven_fila_tarefa.update({
      where: { id },
      data: { status: 'CONCLUIDA', concluida_em: quando, conclusao_sinal: sinal },
    });
  }

  async escalarTarefa(id: string) {
    return this.prisma.ven_fila_tarefa.update({
      where: { id },
      data: { status: 'ESCALADA', escalada_em: new Date() },
    });
  }

  async cancelarTarefa(id: string, obs: string) {
    return this.prisma.ven_fila_tarefa.update({
      where: { id },
      data: { status: 'CANCELADA', concluida_em: new Date(), conclusao_obs: obs },
    });
  }

  // ===================================== esteira de resgate (fase 1, S3)
  /** Episódios em andamento (tudo que não é RECUPERADO/PERDIDO). */
  async resgatesAbertos() {
    return this.prisma.ven_resgate.findMany({
      where: { estagio: { notIn: ['RECUPERADO', 'PERDIDO'] } },
    });
  }

  async abrirResgates(
    rows: Array<{
      cli_codigo: number;
      cli_nome: string | null;
      rep_codigo: number | null;
      rep_nome: string | null;
      curva: string | null;
      faturamento_total: number;
      dias_sem_compra_abertura: number | null;
      sla_em: Date | null;
    }>,
  ) {
    if (!rows.length) return { count: 0 };
    return this.prisma.ven_resgate.createMany({ data: rows });
  }

  async atualizarResgate(
    id: string,
    data: {
      estagio?: string;
      contatado_em?: Date;
      proposta_em?: Date;
      fechado_em?: Date;
      sla_cumprido?: boolean;
      rep_codigo?: number | null;
      rep_nome?: string | null;
    },
  ) {
    return this.prisma.ven_resgate.update({ where: { id }, data });
  }

  /** Fechados a partir de um corte — as colunas Recuperado/Perdido da esteira. */
  async resgatesFechadosDesde(desde: Date, rep_codigo?: number) {
    return this.prisma.ven_resgate.findMany({
      where: {
        estagio: { in: ['RECUPERADO', 'PERDIDO'] },
        fechado_em: { gte: desde },
        ...(rep_codigo != null ? { rep_codigo } : {}),
      },
      orderBy: { fechado_em: 'desc' },
    });
  }

  // ============================== painel esforço × resultado (fase 1, S3)
  /** Tarefas concluídas na janela, por vendedor e sinal que as fechou. */
  async tarefasConcluidasPorRepDesde(desde: Date) {
    return this.prisma.ven_fila_tarefa.groupBy({
      by: ['rep_codigo', 'conclusao_sinal'],
      where: { status: 'CONCLUIDA', concluida_em: { gte: desde } },
      _count: { _all: true },
    });
  }

  /** Escaladas em aberto agora, por vendedor — a pauta viva do supervisor. */
  async escaladasPorRep() {
    return this.prisma.ven_fila_tarefa.groupBy({
      by: ['rep_codigo'],
      where: { status: 'ESCALADA' },
      _count: { _all: true },
    });
  }

  /** SLA do resgate: episódios com prazo avaliado, abertos na janela. */
  async slaResgatePorRepDesde(desde: Date) {
    return this.prisma.ven_resgate.groupBy({
      by: ['rep_codigo', 'sla_cumprido'],
      where: { sla_em: { not: null }, sla_cumprido: { not: null }, aberto_em: { gte: desde } },
      _count: { _all: true },
    });
  }

  /** Desfechos por vendedor na janela (esforço da pesquisa de perda). */
  async desfechosPorRepDesde(desde: Date) {
    return this.prisma.ven_orcamento_desfecho.groupBy({
      by: ['rep_codigo'],
      where: { created_at: { gte: desde } },
      _count: { _all: true },
    });
  }

  // ================================== sensor WhatsApp (terceiro sinal da fila)
  /**
   * Última mensagem ENVIADA por cliente — o sensor WAHA alimentando a fila:
   * mensagem depois da geração conclui a tarefa como os outros dois sinais
   * (orçamento/venda). Sem a tabela (DDL do piloto ainda não aplicado) ou sem
   * dados, devolve vazio e a fila segue só com os sinais do ERP.
   */
  /**
   * Orçamentos feitos NA INTRANET, por cliente: contam como esforço do vendedor
   * assim que SALVOS (decisão 03/09/2026) — último orçamento (fila/resgate) e
   * quantidade/valor nos 90 dias (quadrante). Cancelados ficam de fora.
   */
  async orcamentosIntranetPorCliente(): Promise<Map<number, { ult_orcamento: Date; orcamentos_90d: number; valor_orcado_90d: number }>> {
    try {
      const ha90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const [ultimos, recentes] = await Promise.all([
        this.prisma.ven_orcamento.groupBy({
          by: ['cli_codigo'],
          where: { status: { not: 'CANCELADO' } },
          _max: { created_at: true },
        }),
        this.prisma.ven_orcamento.groupBy({
          by: ['cli_codigo'],
          where: { status: { not: 'CANCELADO' }, created_at: { gte: ha90 } },
          _count: { _all: true },
          _sum: { total: true },
        }),
      ]);
      const mapa = new Map<number, { ult_orcamento: Date; orcamentos_90d: number; valor_orcado_90d: number }>();
      for (const u of ultimos) {
        if (u._max.created_at) mapa.set(u.cli_codigo, { ult_orcamento: u._max.created_at, orcamentos_90d: 0, valor_orcado_90d: 0 });
      }
      for (const r of recentes) {
        const l = mapa.get(r.cli_codigo);
        if (!l) continue;
        l.orcamentos_90d = r._count._all;
        l.valor_orcado_90d = Number(r._sum.total ?? 0);
      }
      return mapa;
    } catch {
      return new Map();
    }
  }

  async ultimaMensagemEnviadaPorCliente(): Promise<Map<number, Date>> {
    try {
      const grupos = await this.prisma.ven_wa_mensagem.groupBy({
        by: ['cli_codigo'],
        where: { direcao: 'ENVIADA', cli_codigo: { not: null } },
        _max: { timestamp: true },
      });
      return new Map(
        grupos
          .filter((g) => g.cli_codigo != null && g._max.timestamp != null)
          .map((g) => [g.cli_codigo as number, g._max.timestamp as Date]),
      );
    } catch {
      return new Map();
    }
  }

  // ============================================ desfecho do orçamento (fase 1)
  /** Números de orçamento que JÁ têm motivo registrado (para filtrar a fila). */
  async orcamentosComDesfecho(empresa = 3): Promise<Set<number>> {
    const rows = await this.prisma.ven_orcamento_desfecho.findMany({
      where: { empresa },
      select: { orcamento: true },
    });
    return new Set(rows.map((r) => r.orcamento));
  }

  /** Marcar de novo corrige o motivo do mesmo orçamento — nunca duplica. */
  async upsertDesfecho(params: {
    empresa?: number;
    orcamento: number;
    emissao?: Date | null;
    cli_codigo: number;
    cli_nome?: string | null;
    rep_codigo?: number | null;
    rep_nome?: string | null;
    total?: number;
    motivo: string;
    observacao?: string | null;
    usuario_id?: string | null;
    usuario_nome?: string | null;
  }) {
    const { empresa = 3, orcamento, ...rest } = params;
    return this.prisma.ven_orcamento_desfecho.upsert({
      where: { empresa_orcamento: { empresa, orcamento } },
      create: { empresa, orcamento, ...rest },
      update: { ...rest, updated_at: new Date() },
    });
  }

  /** Contagem por motivo desde um corte — o placar da pesquisa de perda. */
  async resumoMotivosDesde(desde: Date, rep_codigo?: number) {
    const rows = await this.prisma.ven_orcamento_desfecho.groupBy({
      by: ['motivo'],
      where: {
        created_at: { gte: desde },
        ...(rep_codigo != null ? { rep_codigo } : {}),
      },
      _count: { _all: true },
      _sum: { total: true },
    });
    return rows.map((r) => ({
      motivo: r.motivo,
      quantidade: r._count._all,
      valor: Number(r._sum.total ?? 0),
    }));
  }
}
