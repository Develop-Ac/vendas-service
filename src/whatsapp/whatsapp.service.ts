import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { WhatsappRepository, MensagemRow } from './whatsapp.repository';

/**
 * Sensor WhatsApp do CRM do Atacado (fase 1, piloto WAHA) — SÓ METADADOS.
 *
 * O WAHA (EasyPanel local, 1 container, 1 sessão por número corporativo) manda
 * cada evento de mensagem para o webhook daqui. O serviço registra o FATO do
 * contato (sessão/vendedor, interlocutor, direção, hora, tipo) e resolve o
 * cliente pela chave DDD + últimos 8 dígitos — nunca o conteúdo da conversa.
 *
 * Convenção de sessão: `rep-<codigo>` (ex.: rep-316). É dela que sai o vendedor
 * dono do contato; sessão fora do padrão é registrada sem rep.
 *
 * A mensagem ENVIADA é o terceiro sinal de auto-conclusão da fila do dia
 * (FilaService), ao lado do orçamento e da venda.
 */

/** Os grupos e listas de transmissão ficam FORA do sensor (decisão do plano). */
const CHATS_IGNORADOS = ['@g.us', '@broadcast', '@newsletter'];

const TABELAS_ATACADO = ['2', '5'];
const EMPRESA = 3;

/**
 * Chave de casamento: DDD + últimos 8 dígitos. Sobrevive ao 9º dígito (o mesmo
 * cliente casa com "(65) 9999-8888" do ERP e "55 65 9 9999 8888" do WhatsApp).
 * Número sem DDD não tem chave — impossível casar sem ambiguidade.
 */
export function chaveTelefone(bruto: string | null | undefined): string | null {
  if (!bruto) return null;
  let d = String(bruto).replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2); // tira o país
  d = d.replace(/^0+/, ''); // operadora/zero à esquerda
  if (d.length < 10 || d.length > 11) return null; // DDD + 8 ou DDD + 9 dígitos
  return d.slice(0, 2) + d.slice(-8);
}

interface WebhookWaha {
  event?: string;
  session?: string;
  payload?: {
    id?: string;
    timestamp?: number;
    from?: string;
    to?: string;
    fromMe?: boolean;
    ack?: number;
    // WAHA manda body/mídia junto — este serviço NÃO os grava (só metadados).
    [k: string]: unknown;
  };
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    private readonly repo: WhatsappRepository,
    private readonly erp: ErpApiService,
  ) {}

  private repDaSessao(sessao: string): number | null {
    const m = /^rep-(\d+)$/.exec(sessao.trim());
    return m ? Number(m[1]) : null;
  }

  // ------------------------------------------------------------- webhook
  async processarWebhook(body: WebhookWaha) {
    const evento = body.event ?? '';
    const sessao = body.session ?? '';
    const p = body.payload ?? {};

    if (!sessao || !p.id) return { ok: true, ignorado: 'sem sessão ou id' };

    if (evento === 'message.ack') {
      const r = await this.repo.atualizarAck(sessao, String(p.id), Number(p.ack ?? 0));
      return { ok: true, evento, atualizadas: r.count };
    }

    if (evento !== 'message' && evento !== 'message.any') {
      return { ok: true, ignorado: evento };
    }

    // fromMe define a direção e, com ela, qual lado do par é o interlocutor.
    const direcao: MensagemRow['direcao'] = p.fromMe ? 'ENVIADA' : 'RECEBIDA';
    const interlocutor = String((p.fromMe ? p.to : p.from) ?? '');
    if (!interlocutor || CHATS_IGNORADOS.some((s) => interlocutor.includes(s))) {
      return { ok: true, ignorado: 'grupo/broadcast' };
    }

    const telefone = interlocutor.replace(/@.*$/, '').replace(/\D/g, '');
    const chave = chaveTelefone(telefone);
    const cli_codigo = chave ? await this.repo.resolverChave(chave) : null;

    const gravada = await this.repo.gravarMensagem({
      message_id: String(p.id),
      sessao,
      rep_codigo: this.repDaSessao(sessao),
      chat_telefone: telefone,
      chave: chave ?? telefone, // sem chave válida, guarda o número cru p/ vínculo manual
      cli_codigo,
      direcao,
      tipo: typeof p.type === 'string' ? p.type : null,
      timestamp: p.timestamp ? new Date(Number(p.timestamp) * 1000) : new Date(),
      ack: p.ack != null ? Number(p.ack) : null,
    });

    return { ok: true, evento, gravada, casada: cli_codigo != null };
  }

  // ------------------------------------------------------ semente do ERP
  /**
   * Semente do vínculo: FONE e CELULAR do cadastro atual dos clientes do
   * atacado (medido: 1.173 de 1.178 têm telefone). Idempotente — chave já
   * vinculada (inclusive manualmente) não é tocada.
   */
  async seedContatos() {
    const clientes = await this.erp.consultar<Record<string, any>>('clientes', {
      empresa: EMPRESA,
      campos: ['CLI_CODIGO', 'CLI_NOME', 'FONE', 'CELULAR'],
      filtros: [{ campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO }],
      limite: 20_000,
    });

    const porChave = new Map<string, { telefone: string; cli: number; nome: string | null }>();
    for (const c of clientes) {
      for (const bruto of [c.CELULAR, c.FONE]) {
        const chave = chaveTelefone(bruto);
        if (!chave || porChave.has(chave)) continue; // 1ª ocorrência vence (celular antes do fixo)
        porChave.set(chave, {
          telefone: String(bruto).trim(),
          cli: Number(c.CLI_CODIGO),
          nome: c.CLI_NOME ?? null,
        });
      }
    }

    const r = await this.repo.semearContatos(
      [...porChave.entries()].map(([chave, v]) => ({
        chave,
        telefone: v.telefone,
        cli_codigo: v.cli,
        cli_nome: v.nome,
        origem: 'SEED_ERP',
      })),
    );
    this.logger.log(
      `Semente de contatos: ${porChave.size} chaves no ERP, ${r.count} inseridas (o resto já existia).`,
    );
    return { clientes: clientes.length, chaves: porChave.size, inseridas: r.count };
  }

  // ----------------------------------------------------- vínculo manual
  pendentes(limite?: number) {
    return this.repo.pendentesVinculo(limite);
  }

  /** 1 toque que aprende para sempre: vincula a chave e conserta o histórico. */
  async vincular(dto: {
    telefone: string;
    cli_codigo: number;
    cli_nome?: string;
    usuario_nome?: string;
  }) {
    if (!dto.telefone || dto.cli_codigo == null) {
      throw new BadRequestException('telefone e cli_codigo são obrigatórios.');
    }
    const chave = chaveTelefone(dto.telefone) ?? dto.telefone.replace(/\D/g, '');
    if (!chave) throw new BadRequestException('Telefone inválido.');
    return this.repo.vincular({
      chave,
      telefone: dto.telefone,
      cli_codigo: Number(dto.cli_codigo),
      cli_nome: dto.cli_nome ?? null,
      criado_por: dto.usuario_nome ?? null,
    });
  }

  // ------------------------------------------------- medições do piloto
  /** Taxa de casamento e atividade por sessão — os números que o piloto valida. */
  async medicoes() {
    const [m, contatos, pendentes] = await Promise.all([
      this.repo.medicoes(),
      this.repo.contarContatos(),
      this.repo.pendentesVinculo(1000),
    ]);
    const sessoes = new Map<
      string,
      { enviadas: number; recebidas: number; ultima_atividade: Date | null }
    >();
    for (const s of m.porSessao) {
      const atual = sessoes.get(s.sessao) ?? {
        enviadas: 0,
        recebidas: 0,
        ultima_atividade: null,
      };
      if (s.direcao === 'ENVIADA') atual.enviadas += s._count._all;
      else atual.recebidas += s._count._all;
      const ts = s._max.timestamp;
      if (ts && (!atual.ultima_atividade || ts > atual.ultima_atividade)) {
        atual.ultima_atividade = ts;
      }
      sessoes.set(s.sessao, atual);
    }
    return {
      mensagens: m.total,
      casadas: m.casadas,
      taxa_casamento_pct: m.total > 0 ? (m.casadas / m.total) * 100 : null,
      contatos_vinculados: contatos,
      chaves_pendentes: pendentes.length,
      sessoes: [...sessoes.entries()].map(([sessao, v]) => ({ sessao, ...v })),
    };
  }
}
