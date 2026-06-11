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

  /** Qtde de clientes na carteira (overlay) de um vendedor. */
  async contarCarteira(rep_codigo: number) {
    return this.prisma.ven_carteira_cliente.count({ where: { rep_codigo, trash: 0 } });
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
    return this.prisma.ven_carteira_cliente.upsert({
      where: { cli_codigo },
      create: { cli_codigo, ...rest, atribuido_em: new Date(), trash: 0 },
      update: { ...rest, atribuido_em: new Date(), trash: 0 },
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
}
