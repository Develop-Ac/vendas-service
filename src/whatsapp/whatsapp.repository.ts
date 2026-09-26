import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface ContatoSeedRow {
  chave: string;
  telefone: string;
  cli_codigo: number;
  cli_nome: string | null;
  origem: string;
}

export interface MensagemRow {
  message_id: string;
  sessao: string;
  rep_codigo: number | null;
  chat_telefone: string;
  chave: string;
  cli_codigo: number | null;
  direcao: 'ENVIADA' | 'RECEBIDA';
  tipo: string | null;
  timestamp: Date;
  ack: number | null;
  // Conteúdo — só preenchido para sessões em WA_CORPO_SESSOES.
  corpo?: string | null;
  midia_chave?: string | null;
  midia_mime?: string | null;
  /** PENDENTE entra junto com o áudio; OK/ERRO vêm do processador. */
  transcricao_status?: 'PENDENTE' | 'OK' | 'ERRO' | null;
}

export const TRANSCRICAO_MAX_TENTATIVAS = 3;

@Injectable()
export class WhatsappRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------- contatos
  /** Semente: insere só as chaves que ainda não existem (vínculo manual vence). */
  async semearContatos(rows: ContatoSeedRow[]) {
    if (!rows.length) return { count: 0 };
    return this.prisma.ven_wa_contato.createMany({ data: rows, skipDuplicates: true });
  }

  async resolverChave(chave: string): Promise<number | null> {
    const c = await this.prisma.ven_wa_contato.findUnique({ where: { chave } });
    return c?.cli_codigo ?? null;
  }

  /**
   * Vínculo manual: grava/corrige o dono da chave e re-resolve as mensagens já
   * recebidas dela — o toque de hoje conserta o histórico inteiro.
   */
  async vincular(params: {
    chave: string;
    telefone: string;
    cli_codigo: number;
    cli_nome?: string | null;
    criado_por?: string | null;
  }) {
    const { chave, ...resto } = params;
    const contato = await this.prisma.ven_wa_contato.upsert({
      where: { chave },
      create: { chave, ...resto, origem: 'MANUAL' },
      update: { ...resto, origem: 'MANUAL', updated_at: new Date() },
    });
    const msgs = await this.prisma.ven_wa_mensagem.updateMany({
      where: { chave },
      data: { cli_codigo: params.cli_codigo },
    });
    return { contato, mensagens_resolvidas: msgs.count };
  }

  async contarContatos() {
    return this.prisma.ven_wa_contato.count();
  }

  async contatoPorChave(chave: string) {
    try {
      return await this.prisma.ven_wa_contato.findUnique({ where: { chave } });
    } catch {
      return null;
    }
  }

  /**
   * Religa mensagens pendentes cujas chaves passaram a existir — cliente novo
   * no ERP (ou vínculo criado depois da conversa) ganha o histórico retroativo.
   */
  async religarPendentes(): Promise<number> {
    const pendentes = await this.prisma.ven_wa_mensagem.groupBy({
      by: ['chave'],
      where: { cli_codigo: null },
    });
    if (!pendentes.length) return 0;
    const contatos = await this.prisma.ven_wa_contato.findMany({
      where: { chave: { in: pendentes.map((p) => p.chave) } },
    });
    let religadas = 0;
    for (const c of contatos) {
      const r = await this.prisma.ven_wa_mensagem.updateMany({
        where: { chave: c.chave, cli_codigo: null },
        data: { cli_codigo: c.cli_codigo },
      });
      religadas += r.count;
    }
    return religadas;
  }

  // ------------------------------------------------------------ mensagens
  /** Grava um evento; reentrega do mesmo id (sessao+message_id) é ignorada. */
  async gravarMensagem(row: MensagemRow): Promise<boolean> {
    try {
      await this.prisma.ven_wa_mensagem.create({ data: row });
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return false; // duplicata — o webhook do WAHA pode reentregar
      }
      throw e;
    }
  }

  async atualizarAck(sessao: string, message_id: string, ack: number) {
    return this.prisma.ven_wa_mensagem.updateMany({
      where: { sessao, message_id },
      data: { ack },
    });
  }

  /** Chaves sem cliente (fila de vínculo), com contagem e última atividade. */
  async pendentesVinculo(limite = 100) {
    const grupos = await this.prisma.ven_wa_mensagem.groupBy({
      by: ['chave', 'chat_telefone', 'sessao'],
      where: { cli_codigo: null },
      _count: { _all: true },
      _max: { timestamp: true },
    });
    return grupos
      .map((g) => ({
        chave: g.chave,
        telefone: g.chat_telefone,
        sessao: g.sessao,
        mensagens: g._count._all,
        ultima_atividade: g._max.timestamp,
      }))
      .sort(
        (a, b) =>
          (b.ultima_atividade?.getTime() ?? 0) - (a.ultima_atividade?.getTime() ?? 0),
      )
      .slice(0, limite);
  }

  /**
   * A última mensagem (qualquer direção) de uma sessão — é o que faz o
   * cabeçalho da estação SEGUIR a conversa: quem escreveu ou recebeu por
   * último é o cliente em pauta. Traz o nome do vínculo quando existe.
   */
  async ultimaConversaDaSessao(sessao: string) {
    try {
      const m = await this.prisma.ven_wa_mensagem.findFirst({
        where: { sessao },
        orderBy: { timestamp: 'desc' },
      });
      if (!m) return null;
      const contato =
        m.cli_codigo != null
          ? await this.prisma.ven_wa_contato.findFirst({ where: { cli_codigo: m.cli_codigo } })
          : null;
      return {
        chat_telefone: m.chat_telefone,
        chave: m.chave,
        cli_codigo: m.cli_codigo,
        cli_nome: contato?.cli_nome ?? null,
        direcao: m.direcao,
        timestamp: m.timestamp,
      };
    } catch {
      return null; // tabela do piloto ainda ausente — a estação segue sem o sensor
    }
  }

  /** Mensagens na janela, por vendedor e direção — o painel esforço×resultado. */
  async mensagensPorRepDesde(desde: Date) {
    try {
      return await this.prisma.ven_wa_mensagem.groupBy({
        by: ['rep_codigo', 'direcao'],
        where: { timestamp: { gte: desde }, rep_codigo: { not: null } },
        _count: { _all: true },
      });
    } catch {
      return []; // sensor ainda sem tabela/piloto — painel segue sem WhatsApp
    }
  }

  // ---------------------------------------------------------- transcrição
  /** O áudio mais antigo ainda pendente (menos tentativas primeiro). */
  async proximoAudioPendente(soRecebidas: boolean) {
    return this.prisma.ven_wa_mensagem.findFirst({
      where: {
        transcricao_status: 'PENDENTE',
        midia_chave: { not: null },
        ...(soRecebidas ? { direcao: 'RECEBIDA' } : {}),
      },
      orderBy: [{ transcricao_tentativas: 'asc' }, { timestamp: 'asc' }],
      select: { id: true, midia_chave: true, midia_mime: true, transcricao_tentativas: true },
    });
  }

  async gravarTranscricao(id: string, texto: string) {
    return this.prisma.ven_wa_mensagem.update({
      where: { id },
      data: { transcricao: texto, transcricao_status: 'OK' },
    });
  }

  /** Conta a tentativa; na última vira ERRO e sai da fila (o áudio fica no MinIO). */
  async falharTranscricao(id: string, tentativasAtuais: number) {
    const n = tentativasAtuais + 1;
    return this.prisma.ven_wa_mensagem.update({
      where: { id },
      data: {
        transcricao_tentativas: n,
        transcricao_status: n >= TRANSCRICAO_MAX_TENTATIVAS ? 'ERRO' : 'PENDENTE',
      },
    });
  }

  /** Medições do piloto: volumes, taxa de casamento e atividade por sessão. */
  async medicoes() {
    const [total, casadas, porSessao, comCorpo, comMidia, audios] = await Promise.all([
      this.prisma.ven_wa_mensagem.count(),
      this.prisma.ven_wa_mensagem.count({ where: { cli_codigo: { not: null } } }),
      this.prisma.ven_wa_mensagem.groupBy({
        by: ['sessao', 'direcao'],
        _count: { _all: true },
        _max: { timestamp: true },
      }),
      this.prisma.ven_wa_mensagem.count({ where: { corpo: { not: null } } }),
      this.prisma.ven_wa_mensagem.count({ where: { midia_chave: { not: null } } }),
      this.prisma.ven_wa_mensagem.groupBy({
        by: ['transcricao_status'],
        where: { transcricao_status: { not: null } },
        _count: { _all: true },
      }),
    ]);
    return { total, casadas, porSessao, comCorpo, comMidia, audios };
  }
}
