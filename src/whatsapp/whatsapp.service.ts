import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { S3Service } from '../storage/s3.service';
import { WhatsappRepository, MensagemRow } from './whatsapp.repository';

/**
 * Sensor WhatsApp do CRM do Atacado (piloto WAHA).
 *
 * O WAHA (EasyPanel local, 1 container, 1 sessão por número corporativo) manda
 * cada evento de mensagem para o webhook daqui. O serviço registra o FATO do
 * contato (sessão/vendedor, interlocutor, direção, hora, tipo) e resolve o
 * cliente pela chave DDD + últimos 8 dígitos.
 *
 * CONTEÚDO (corpo, mídia no MinIO, áudio em texto) só para as sessões listadas
 * em WA_CORPO_SESSOES — os números são corporativos, a equipe foi comunicada e
 * a guarda é por prazo indefinido (decisão da diretoria). Sessão fora da lista
 * continua só com metadados. O webhook nunca transcreve: o áudio entra
 * PENDENTE e um cron manda ao transcritor do runner do assistente (.146).
 *
 * Convenção de sessão: `rep-<codigo>` (ex.: rep-316). É dela que sai o vendedor
 * dono do contato; sessão fora do padrão é registrada sem rep.
 *
 * A mensagem ENVIADA é o terceiro sinal de auto-conclusão da fila do dia
 * (FilaService), ao lado do orçamento e da venda.
 */

/** Os grupos e listas de transmissão ficam FORA do sensor (decisão do plano). */
const CHATS_IGNORADOS = ['@g.us', '@broadcast', '@newsletter'];

/** Sessões cujo conteúdo é guardado (env WA_CORPO_SESSOES, vírgula; vazia = ninguém). */
function sessoesComCorpo(): Set<string> {
  return new Set(
    (process.env.WA_CORPO_SESSOES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Mídia que vale guardar: foto do vidro/chassi, áudio, PDF e documentos. Vídeo, sticker e contato ficam fora. */
const MIDIA_ACEITA =
  /^(image\/|audio\/|application\/pdf|application\/msword|application\/vnd\.(openxmlformats-officedocument|ms-excel|ms-powerpoint))/i;
const MIDIA_MAX_BYTES = 20 * 1024 * 1024;
const BUCKET_WHATSAPP = () => process.env.S3_BUCKET_WHATSAPP || 'whatsapp-atacado';

const EXTENSOES: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
function extensaoDe(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase(); // "audio/ogg; codecs=opus"
  return EXTENSOES[base] ?? base.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'bin';
}

/** Estado de uma importação de histórico (em memória; uma por sessão de cada vez). */
export interface HistoricoEstado {
  sessao: string;
  desde: string;
  iniciado_em: string;
  terminado_em: string | null;
  chats: number;
  lidas: number;
  gravadas: number;
  midias: number;
  erro: string | null;
}

/**
 * Sessões do mesmo WAHA que NÃO são de vendedor e não devem entrar no sensor
 * (ex.: `assistente`, o assistente da gestão no WhatsApp). O WAHA manda o webhook
 * global para todas as sessões; o filtro fica aqui. Lista por env
 * WA_SESSOES_IGNORADAS (separada por vírgula); padrão = assistente.
 */
function sessoesIgnoradas(): Set<string> {
  return new Set(
    (process.env.WA_SESSOES_IGNORADAS ?? 'assistente')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

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
    type?: string;
    body?: string;
    hasMedia?: boolean;
    media?: { url?: string | null; mimetype?: string | null; filename?: string | null } | null;
    _data?: { type?: string; caption?: string; mimetype?: string; size?: number } | null;
    [k: string]: unknown;
  };
}
type PayloadWaha = NonNullable<WebhookWaha['payload']>;

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  /**
   * LID -> número real. O WhatsApp esconde o telefone de parte dos contatos
   * atrás de um Linked ID (`...@lid`) — foi o que o piloto pegou no primeiro
   * teste: 100% das mensagens chegando com LID e casamento zero. O WAHA resolve
   * pelo endpoint `GET /api/{sessao}/lids/{lid}`; o cache evita uma chamada por
   * mensagem. Precisa de WA_API_URL (e WA_API_KEY, se a API tiver chave).
   */
  private lidCache = new Map<string, string>();
  private transcrevendo = false;
  private historicos = new Map<string, HistoricoEstado>();

  constructor(
    private readonly repo: WhatsappRepository,
    private readonly erp: ErpApiService,
    private readonly s3: S3Service,
  ) {}

  private get wahaBase(): string {
    return (process.env.WA_API_URL ?? '').replace(/\/+$/, '');
  }
  private wahaHeaders() {
    return { 'X-Api-Key': process.env.WA_API_KEY ?? '' };
  }

  private repDaSessao(sessao: string): number | null {
    const m = /^rep-(\d+)$/.exec(sessao.trim());
    return m ? Number(m[1]) : null;
  }

  private async resolverLid(sessao: string, lid: string): Promise<string | null> {
    const base = this.wahaBase;
    if (!base) return null;
    const conhecido = this.lidCache.get(lid);
    if (conhecido) return conhecido;
    try {
      const r = await fetch(
        `${base}/api/${encodeURIComponent(sessao)}/lids/${encodeURIComponent(lid)}`,
        {
          headers: { 'X-Api-Key': process.env.WA_API_KEY ?? '' },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!r.ok) return null;
      const j = (await r.json()) as { pn?: string | null };
      const pn = j?.pn ? String(j.pn).replace(/@.*$/, '').replace(/\D/g, '') : null;
      if (pn) {
        if (this.lidCache.size > 10_000) this.lidCache.clear();
        this.lidCache.set(lid, pn);
      }
      return pn;
    } catch (e) {
      // "fetch failed" esconde o motivo real (DNS, porta, timeout) em e.cause.
      const causa = (e as { cause?: { code?: string; hostname?: string; port?: number } }).cause;
      const detalhe = causa?.code
        ? `${causa.code}${causa.hostname ? ` (${causa.hostname}${causa.port ? ':' + causa.port : ''})` : ''}`
        : (e as Error).message;
      this.logger.warn(`LID não resolvido (${lid}): ${detalhe} [alvo: ${base}]`);
      return null;
    }
  }

  // ------------------------------------------------------------- webhook
  async processarWebhook(body: WebhookWaha) {
    const evento = body.event ?? '';
    const sessao = body.session ?? '';
    const p = body.payload ?? {};

    if (!sessao || !p.id) return { ok: true, ignorado: 'sem sessão ou id' };
    if (sessoesIgnoradas().has(sessao)) return { ok: true, ignorado: 'sessão fora do sensor' };

    if (evento === 'message.ack') {
      const r = await this.repo.atualizarAck(sessao, String(p.id), Number(p.ack ?? 0));
      return { ok: true, evento, atualizadas: r.count };
    }

    if (evento !== 'message' && evento !== 'message.any') {
      return { ok: true, ignorado: evento };
    }
    const r = await this.gravarEvento(sessao, p);
    return { ok: true, evento, ...r };
  }

  /**
   * Um evento de mensagem → uma linha. Caminho único do webhook e da importação
   * de histórico (mesma resolução de LID, mesma chave, mesma regra de conteúdo).
   */
  private async gravarEvento(sessao: string, p: PayloadWaha) {
    // fromMe define a direção e, com ela, qual lado do par é o interlocutor.
    const direcao: MensagemRow['direcao'] = p.fromMe ? 'ENVIADA' : 'RECEBIDA';
    const interlocutor = String((p.fromMe ? p.to : p.from) ?? '');
    if (!interlocutor || CHATS_IGNORADOS.some((s) => interlocutor.includes(s))) {
      return { ignorado: 'grupo/broadcast' };
    }

    // Contato atrás de LID: pede ao WAHA o número real; sem resolução, os
    // dígitos do LID viram a chave (a mensagem não se perde — cai na fila de
    // vínculo e o vínculo manual conserta o histórico depois).
    let telefone = interlocutor.replace(/@.*$/, '').replace(/\D/g, '');
    if (interlocutor.endsWith('@lid')) {
      telefone = (await this.resolverLid(sessao, telefone)) ?? telefone;
    }
    const chave = chaveTelefone(telefone);
    const cli_codigo = chave ? await this.repo.resolverChave(chave) : null;
    const tipo = typeof p.type === 'string' ? p.type : (p._data?.type ?? null);
    const timestamp = p.timestamp ? new Date(Number(p.timestamp) * 1000) : new Date();

    let conteudo: Pick<MensagemRow, 'corpo' | 'midia_chave' | 'midia_mime' | 'transcricao_status'> = {};
    if (sessoesComCorpo().has(sessao)) {
      const corpo = (typeof p.body === 'string' && p.body) || p._data?.caption || null;
      const midia = await this.guardarMidia(sessao, String(p.id), timestamp, p);
      conteudo = {
        corpo,
        midia_chave: midia?.chave ?? null,
        midia_mime: midia?.mime ?? null,
        transcricao_status: midia && /^audio\//i.test(midia.mime) ? 'PENDENTE' : null,
      };
    }

    const gravada = await this.repo.gravarMensagem({
      message_id: String(p.id),
      sessao,
      rep_codigo: this.repDaSessao(sessao),
      chat_telefone: telefone,
      chave: chave ?? telefone, // sem chave válida, guarda o número cru p/ vínculo manual
      cli_codigo,
      direcao,
      tipo,
      timestamp,
      ack: p.ack != null ? Number(p.ack) : null,
      ...conteudo,
    });

    return { gravada, casada: cli_codigo != null, midia: conteudo.midia_chave != null };
  }

  // --------------------------------------------------------------- mídia
  /**
   * Baixa a mídia do WAHA e guarda no MinIO. A URL do payload vem com o host
   * interno do container do WAHA (localhost:3000); vista daqui não abre, então
   * o começo é trocado pelo WA_API_URL (mesma armadilha medida no recebimento).
   * Nunca lança: mídia que falha não impede gravar a mensagem.
   */
  private async guardarMidia(
    sessao: string,
    messageId: string,
    quando: Date,
    p: PayloadWaha,
  ): Promise<{ chave: string; mime: string } | null> {
    const url = p.hasMedia ? p.media?.url : null;
    const mime = (p.media?.mimetype ?? p._data?.mimetype ?? '').toString();
    if (!url || !mime || !MIDIA_ACEITA.test(mime)) return null;
    const tamanho = Number(p._data?.size);
    if (Number.isFinite(tamanho) && tamanho > MIDIA_MAX_BYTES) return null;

    const candidatas = [url];
    if (this.wahaBase) {
      try {
        const u = new URL(url);
        const alvo = new URL(this.wahaBase);
        u.protocol = alvo.protocol;
        u.host = alvo.host;
        if (u.toString() !== url) candidatas.unshift(u.toString());
      } catch {
        /* URL torta: tenta só a original */
      }
    }
    let corpo: Buffer | null = null;
    let ultimoErro = '';
    for (const c of candidatas) {
      try {
        const r = await fetch(c, { headers: this.wahaHeaders(), signal: AbortSignal.timeout(60_000) });
        if (!r.ok) {
          ultimoErro = `HTTP ${r.status}`;
          continue;
        }
        corpo = Buffer.from(await r.arrayBuffer());
        break;
      } catch (e) {
        ultimoErro = (e as Error).message;
      }
    }
    if (!corpo) {
      this.logger.warn(`Mídia não baixada (${sessao} ${messageId}): ${ultimoErro}`);
      return null;
    }
    if (corpo.length > MIDIA_MAX_BYTES) return null;

    const aa = quando.getUTCFullYear();
    const mm = String(quando.getUTCMonth() + 1).padStart(2, '0');
    const chave = `${sessao}/${aa}/${mm}/${messageId.replace(/[^A-Za-z0-9_.-]/g, '_')}.${extensaoDe(mime)}`;
    try {
      await this.s3.putObject(chave, corpo, mime.split(';')[0].trim(), BUCKET_WHATSAPP());
      return { chave, mime };
    } catch (e) {
      this.logger.warn(`Mídia não gravada no MinIO (${chave}): ${(e as Error).message}`);
      return null;
    }
  }

  // --------------------------------------------------------- transcrição
  /**
   * Fila de áudios → texto. Um por vez, dentro de um orçamento de ~50 s por
   * tick (o cron é por minuto; a flag impede sobreposição). O transcritor é o
   * `POST /transcrever` do runner do assistente (WA_TRANSCRICAO_URL, Bearer
   * WA_TRANSCRICAO_TOKEN). Transcritor fora do ar (rede ou 5xx) encerra o tick
   * SEM contar tentativa — senão a fila inteira viraria ERRO numa queda.
   */
  @Cron('* * * * *', { name: 'whatsapp-transcricao' })
  async processarAudiosPendentes() {
    const url = (process.env.WA_TRANSCRICAO_URL ?? '').trim();
    if (!url || this.transcrevendo) return null;
    this.transcrevendo = true;
    const soRecebidas = ['1', 'true', 'sim'].includes(String(process.env.WA_TRANSCRICAO_SO_RECEBIDAS ?? '').toLowerCase());
    const inicio = Date.now();
    const r = { processados: 0, ok: 0, falhas: 0, parado: null as string | null };
    try {
      while (Date.now() - inicio < 50_000) {
        const m = await this.repo.proximoAudioPendente(soRecebidas);
        if (!m || !m.midia_chave) break;
        r.processados++;
        let audio: Buffer;
        try {
          audio = await this.s3.getObjectBuffer(m.midia_chave, BUCKET_WHATSAPP());
        } catch (e) {
          this.logger.warn(`Áudio ${m.midia_chave} não lido do MinIO: ${(e as Error).message}`);
          await this.repo.falharTranscricao(m.id, m.transcricao_tentativas);
          r.falhas++;
          continue;
        }
        const t = await this.transcrever(url, audio, m.midia_mime ?? 'audio/ogg', m.midia_chave);
        if (t.indisponivel) {
          r.parado = t.erro ?? 'transcritor indisponível';
          this.logger.warn(`Transcritor indisponível, fila espera: ${r.parado}`);
          break;
        }
        if (t.texto == null) {
          await this.repo.falharTranscricao(m.id, m.transcricao_tentativas);
          r.falhas++;
          this.logger.warn(`Transcrição falhou (${m.midia_chave}): ${t.erro}`);
          continue;
        }
        await this.repo.gravarTranscricao(m.id, t.texto);
        r.ok++;
      }
    } finally {
      this.transcrevendo = false;
    }
    if (r.processados) this.logger.log(`Transcrição: ${r.ok} ok, ${r.falhas} falhas.`);
    return r;
  }

  /** multipart `file` → `{ texto }`. `indisponivel` = rede ou 5xx (não conta tentativa). */
  private async transcrever(
    url: string,
    audio: Buffer,
    mime: string,
    nome: string,
  ): Promise<{ texto?: string | null; indisponivel?: boolean; erro?: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime.split(';')[0].trim() }), nome.split('/').pop());
    const token = (process.env.WA_TRANSCRICAO_TOKEN ?? '').trim();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
        signal: AbortSignal.timeout(Number(process.env.WA_TRANSCRICAO_TIMEOUT_MS) || 600_000),
      });
      if (r.status >= 500) return { indisponivel: true, erro: `HTTP ${r.status}` };
      if (!r.ok) return { texto: null, erro: `HTTP ${r.status}` };
      const j = (await r.json()) as { texto?: string; text?: string };
      return { texto: String(j.texto ?? j.text ?? '') };
    } catch (e) {
      return { indisponivel: true, erro: (e as Error).message };
    }
  }

  // ------------------------------------------------------------ histórico
  /**
   * Importa as conversas da sessão desde uma data (padrão 01/09/2026, data do
   * termo de ciência). Roda em segundo plano; o estado fica em memória.
   * Repetir é seguro: a chave única (sessao, message_id) ignora o que já entrou.
   * Limite conhecido do engine WEBJS: só devolve o que o WhatsApp Web sincronizou
   * do aparelho — medir na primeira rodada.
   */
  importarHistorico(sessao: string, desde?: string) {
    if (!sessao) throw new BadRequestException('sessao é obrigatória.');
    if (!this.wahaBase) throw new BadRequestException('WA_API_URL não configurada.');
    if (!sessoesComCorpo().has(sessao)) {
      throw new BadRequestException(`Sessão ${sessao} não está em WA_CORPO_SESSOES.`);
    }
    const d = new Date(desde ?? '2026-09-01T00:00:00-04:00');
    if (Number.isNaN(d.getTime())) throw new BadRequestException('desde inválida.');
    const atual = this.historicos.get(sessao);
    if (atual && !atual.terminado_em) throw new ConflictException(`Importação de ${sessao} em andamento.`);

    const estado: HistoricoEstado = {
      sessao,
      desde: d.toISOString(),
      iniciado_em: new Date().toISOString(),
      terminado_em: null,
      chats: 0,
      lidas: 0,
      gravadas: 0,
      midias: 0,
      erro: null,
    };
    this.historicos.set(sessao, estado);
    void this.executarHistorico(estado, d);
    return estado;
  }

  statusHistorico() {
    return [...this.historicos.values()];
  }

  /** O laço em si (público para o teste esperar por ele). */
  async executarHistorico(estado: HistoricoEstado, desde: Date) {
    const base = this.wahaBase;
    const s = encodeURIComponent(estado.sessao);
    const epoch = Math.floor(desde.getTime() / 1000);
    try {
      const chats: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const r = await fetch(`${base}/api/${s}/chats?limit=200&offset=${offset}`, {
          headers: this.wahaHeaders(),
          signal: AbortSignal.timeout(90_000),
        });
        if (!r.ok) throw new Error(`WAHA chats HTTP ${r.status}`);
        const lista = (await r.json()) as Array<{ id?: string | { _serialized?: string } }>;
        if (!Array.isArray(lista) || !lista.length) break;
        for (const c of lista) {
          const id = typeof c.id === 'string' ? c.id : (c.id?._serialized ?? '');
          if (id && !CHATS_IGNORADOS.some((g) => id.includes(g))) chats.push(id);
        }
        if (lista.length < 200) break;
      }
      estado.chats = chats.length;

      for (const chatId of chats) {
        let msgs: PayloadWaha[] = [];
        try {
          const r = await fetch(
            `${base}/api/${s}/chats/${encodeURIComponent(chatId)}/messages` +
              `?limit=1000&downloadMedia=true&filter.timestamp.gte=${epoch}`,
            { headers: this.wahaHeaders(), signal: AbortSignal.timeout(180_000) },
          );
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          msgs = (await r.json()) as PayloadWaha[];
        } catch (e) {
          this.logger.warn(`Histórico ${estado.sessao} ${chatId}: ${(e as Error).message}`);
          continue;
        }
        for (const m of Array.isArray(msgs) ? msgs : []) {
          if (!m?.id || Number(m.timestamp ?? 0) < epoch) continue; // o filtro do WAHA pode não existir na versão
          estado.lidas++;
          const p: PayloadWaha = {
            ...m,
            from: m.from ?? (m.fromMe ? 'me' : chatId),
            to: m.to ?? (m.fromMe ? chatId : 'me'),
          };
          try {
            const g = await this.gravarEvento(estado.sessao, p);
            if ('gravada' in g && g.gravada) estado.gravadas++;
            if ('midia' in g && g.midia) estado.midias++;
          } catch (e) {
            this.logger.warn(`Histórico ${estado.sessao} msg ${m.id}: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      estado.erro = (e as Error).message;
      this.logger.error(`Histórico ${estado.sessao} interrompido: ${estado.erro}`);
    } finally {
      estado.terminado_em = new Date().toISOString();
      this.logger.log(
        `Histórico ${estado.sessao}: ${estado.chats} chats, ${estado.lidas} lidas, ` +
          `${estado.gravadas} gravadas, ${estado.midias} mídias.`,
      );
    }
    return estado;
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
    // Chave nova adotando conversa antiga: cliente cadastrado DEPOIS de já ter
    // trocado mensagem ganha o histórico retroativo.
    const religadas = await this.repo.religarPendentes();
    this.logger.log(
      `Semente de contatos: ${porChave.size} chaves no ERP, ${r.count} inseridas, ` +
        `${religadas} mensagens pendentes religadas.`,
    );
    return {
      clientes: clientes.length,
      chaves: porChave.size,
      inseridas: r.count,
      mensagens_religadas: religadas,
    };
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

  // ------------------------------------------- conversa ativa (estação)
  /**
   * Resolve um número (ou os dígitos de um LID) para o cliente vinculado — é o
   * caminho de volta da estação: o vendedor clica numa conversa no WhatsApp e
   * o cabeçalho descobre de quem é. LIDs vinculados manualmente vivem na mesma
   * tabela com a chave crua, então a busca cobre os dois formatos.
   */
  async resolverContato(numero: string) {
    const digitos = String(numero ?? '').replace(/\D/g, '');
    if (!digitos) return null;
    const chave = chaveTelefone(digitos) ?? digitos;
    const c = await this.repo.contatoPorChave(chave);
    return c ? { cli_codigo: c.cli_codigo, cli_nome: c.cli_nome, telefone: c.telefone } : null;
  }
  /**
   * A conversa "em pauta" da sessão do vendedor — a estação consulta em
   * polling leve e faz o cabeçalho seguir o WhatsApp (caminho A: pelo sensor;
   * atualiza quando há mensagem, não no mero clique de leitura).
   */
  conversaAtiva(rep_codigo: number) {
    return this.repo.ultimaConversaDaSessao(`rep-${rep_codigo}`);
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
    const audios = { PENDENTE: 0, OK: 0, ERRO: 0 } as Record<string, number>;
    for (const a of m.audios ?? []) {
      if (a.transcricao_status) audios[a.transcricao_status] = a._count._all;
    }
    return {
      mensagens: m.total,
      casadas: m.casadas,
      taxa_casamento_pct: m.total > 0 ? (m.casadas / m.total) * 100 : null,
      contatos_vinculados: contatos,
      chaves_pendentes: pendentes.length,
      sessoes: [...sessoes.entries()].map(([sessao, v]) => ({ sessao, ...v })),
      conteudo: {
        sessoes_liberadas: [...sessoesComCorpo()],
        com_corpo: m.comCorpo ?? 0,
        com_midia: m.comMidia ?? 0,
        audios,
      },
    };
  }
}
