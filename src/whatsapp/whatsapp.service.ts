import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ehGestaoVendas } from '../carteirizacao/papel';
import { Cron } from '@nestjs/schedule';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { S3Service } from '../storage/s3.service';
import { WhatsappRepository, MensagemRow } from './whatsapp.repository';
import { SessoesService } from './sessoes.service';
import { ClienteCadastro, ConversaSemCliente, OrcamentoJanela, sugerirVinculos } from './sugestao-vinculo';
import { codigoDaAgenda } from './agenda';

/**
 * Sensor WhatsApp do CRM do Atacado (piloto WAHA).
 *
 * O WAHA (EasyPanel local, 1 container, 1 sessão por número corporativo) manda
 * cada evento de mensagem para o webhook daqui. O serviço registra o FATO do
 * contato (sessão/vendedor, interlocutor, direção, hora, tipo) e resolve o
 * cliente pela chave DDD + últimos 8 dígitos.
 *
 * CONTEÚDO (corpo, mídia no MinIO, áudio em texto) só para as sessões com
 * `guarda_corpo` na tabela ven_wa_sessao — os números são corporativos, a equipe
 * foi comunicada e a guarda é por prazo indefinido (decisão da diretoria). As
 * demais ficam só com metadados. O webhook nunca transcreve: o áudio entra
 * PENDENTE e um cron manda ao transcritor do runner do assistente (.146).
 *
 * Sessão → vendedor e instância do WAHA vêm de ven_wa_sessao (SessoesService,
 * cache em memória); o nome da sessão não significa nada. Sessão sem vendedor e
 * sem guarda de conteúdo (ex.: `assistente`) fica fora do sensor.
 *
 * VÍNCULO PELA AGENDA: o vendedor salva o contato no celular corporativo com o
 * código do cliente no nome ("40289 João"). Número sem vínculo que conversa é
 * lido na agenda na hora (webhook) e a varredura diária lê a agenda inteira de
 * cada sessão com vendedor. A agenda nunca sobrescreve: chave já vinculada a outro
 * cliente vira divergência para a gestão decidir.
 *
 * A mensagem ENVIADA é o terceiro sinal de auto-conclusão da fila do dia
 * (FilaService), ao lado do orçamento e da venda.
 */

/** Os grupos e listas de transmissão ficam FORA do sensor (decisão do plano). */
const CHATS_IGNORADOS = ['@g.us', '@broadcast', '@newsletter'];

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
  /** true = pede ao WAHA só as mensagens fromMe (recarga leve de uma lacuna de enviadas). */
  so_enviadas?: boolean;
}

const TABELAS_ATACADO = ['2', '5'];
const EMPRESA = 3;

/** 'aaaa-mm-dd' no fuso de Cuiabá (o dia do orçamento e o da conversa têm de bater). */
const diaCuiaba = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'America/Cuiaba' });

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
    // WEBJS: metadados da mensagem; NOWEB: a mensagem crua do Baileys (key, message...).
    _data?: { type?: string; caption?: string; mimetype?: string; size?: number; [k: string]: unknown } | null;
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
   * mensagem. URL e chave são as da instância da sessão.
   */
  private lidCache = new Map<string, string>();
  private agendaCache = new Map<string, string | null>();
  private agendaLida = new Map<string, number>();
  private sugestoesCache: { chave: string; em: number; valor: unknown } | null = null;
  private atacadoCache: { em: number; nomes: Map<number, string>; codigos: Set<number> } | null = null;
  private transcrevendo = false;
  private historicos = new Map<string, HistoricoEstado>();

  constructor(
    private readonly repo: WhatsappRepository,
    private readonly erp: ErpApiService,
    private readonly s3: S3Service,
    private readonly sessoes: SessoesService,
  ) {}

  private repDaSessao(sessao: string): number | null {
    return this.sessoes.repDaSessao(sessao);
  }

  private async resolverLid(sessao: string, lid: string): Promise<string | null> {
    const { url: base, key } = this.sessoes.wahaDe(sessao);
    if (!base) return null;
    const conhecido = this.lidCache.get(lid);
    if (conhecido) return conhecido;
    try {
      const r = await fetch(
        `${base}/api/${encodeURIComponent(sessao)}/lids/${encodeURIComponent(lid)}`,
        {
          headers: { 'X-Api-Key': key },
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
    if (this.sessoes.ignorada(sessao)) return { ok: true, ignorado: 'sessão fora do sensor' };

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
    // WEBJS: enviada vem com from=eu e to=contato. NOWEB: `from` é SEMPRE o chat
    // (remoteJid do Baileys) e `to` vem vazio — sem o fallback, toda enviada
    // caía no descarte de "grupo/broadcast" e o painel mostrava 0 enviadas.
    const direcao: MensagemRow['direcao'] = p.fromMe ? 'ENVIADA' : 'RECEBIDA';
    const interlocutor = String((p.fromMe ? p.to || p.from : p.from) ?? '');
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
    let cli_codigo = chave ? await this.repo.resolverChave(chave) : null;
    // WEBJS manda `type`; NOWEB não (o `_data` é a mensagem crua do Baileys),
    // então o tipo sai da mídia: texto → 'chat', mídia → prefixo do mimetype.
    const mimeMidia = (p.media?.mimetype ?? p._data?.mimetype ?? '').toString();
    const tipo =
      typeof p.type === 'string'
        ? p.type
        : (p._data?.type ?? (!p.hasMedia ? 'chat' : mimeMidia.split('/')[0] || null));
    const timestamp = p.timestamp ? new Date(Number(p.timestamp) * 1000) : new Date();

    // Reentrega do webhook ou histórico repetindo o que já entrou: sai antes de baixar mídia.
    if (await this.repo.existe(sessao, String(p.id))) {
      return { gravada: false, casada: cli_codigo != null, midia: false, duplicada: true };
    }

    // Número sem vínculo: o nome salvo na agenda pode trazer o código do cliente.
    // Uma leitura por número a cada 10 min (o vendedor costuma salvar o contato
    // depois da 1ª conversa; a varredura diária pega o resto). Falha do WAHA ou
    // do ERP não pode custar a mensagem: segue sem vínculo.
    if (chave && cli_codigo == null && this.agendaVencida(sessao, chave)) {
      try {
        if (!(await this.repo.chavesIgnoradas()).has(chave)) {
          const nome = await this.nomeAgenda(sessao, chave, telefone, true);
          if ((await this.vincularPelaAgenda(sessao, chave, telefone, nome)) === 'vinculado') {
            cli_codigo = await this.repo.resolverChave(chave);
          }
        }
      } catch (e) {
        this.logger.warn(`Vínculo pela agenda de ${chave} não lido: ${(e as Error).message}`);
      }
    }

    let conteudo: Pick<MensagemRow, 'corpo' | 'midia_chave' | 'midia_mime' | 'transcricao_status'> = {};
    if (this.sessoes.guardaCorpo(sessao)) {
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
   * o começo é trocado pela URL da instância da sessão (mesma armadilha medida
   * no recebimento).
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

    const waha = this.sessoes.wahaDe(sessao);
    const candidatas = [url];
    if (waha.url) {
      try {
        const u = new URL(url);
        const alvo = new URL(waha.url);
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
        const r = await fetch(c, { headers: { 'X-Api-Key': waha.key }, signal: AbortSignal.timeout(60_000) });
        if (!r.ok) {
          ultimoErro = `HTTP ${r.status}`;
          continue;
        }
        // NOWEB não informa o tamanho no payload: o corte de 20 MB vale pelo
        // content-length antes de ler o corpo (sem o header, confere depois).
        const declarado = Number(r.headers?.get('content-length'));
        if (declarado > MIDIA_MAX_BYTES) return null;
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
      // 401/403 = token errado, 404 = rota ausente (runner antigo), 5xx = caiu: são problemas
      // do transcritor, não do áudio — parar o tick sem contar, senão a fila inteira vira ERRO.
      if (r.status >= 500 || [401, 403, 404].includes(r.status)) {
        return { indisponivel: true, erro: `HTTP ${r.status}` };
      }
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
  importarHistorico(sessao: string, desde?: string, soEnviadas = false) {
    if (!sessao) throw new BadRequestException('sessao é obrigatória.');
    if (!this.sessoes.wahaDe(sessao).url) throw new BadRequestException('URL do WAHA não configurada.');
    if (!this.sessoes.guardaCorpo(sessao)) {
      throw new BadRequestException(`Sessão ${sessao} não guarda conteúdo (guarda_corpo).`);
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
      so_enviadas: soEnviadas,
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
    const { url: base, key } = this.sessoes.wahaDe(estado.sessao);
    const headers = { 'X-Api-Key': key };
    const s = encodeURIComponent(estado.sessao);
    const epoch = Math.floor(desde.getTime() / 1000);
    try {
      const chats: string[] = [];
      for (let offset = 0; ; offset += 200) {
        const r = await fetch(`${base}/api/${s}/chats?limit=200&offset=${offset}`, {
          headers,
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
              `?limit=1000&downloadMedia=true&filter.timestamp.gte=${epoch}` +
              // filter.fromMe=true: o WAHA devolve (e baixa mídia) só das enviadas —
              // recarga da lacuna de 29/09→deploy sem repassar milhares de recebidas.
              (estado.so_enviadas ? '&filter.fromMe=true' : ''),
            { headers, signal: AbortSignal.timeout(180_000) },
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

  /** "Não é cliente": o número sai da lista de vínculo (vincular depois desfaz). */
  async ignorar(dto: { telefone: string; motivo?: string; usuario_nome?: string }) {
    const bruto = String(dto?.telefone ?? '');
    const chave = chaveTelefone(bruto) ?? bruto.replace(/\D/g, '');
    if (!chave) throw new BadRequestException('telefone é obrigatório.');
    this.sugestoesCache = null;
    return this.repo.ignorar({ chave, telefone: bruto, motivo: dto.motivo ?? null, criado_por: dto.usuario_nome ?? null });
  }

  // ------------------------------------------- lista de vínculo com sugestão
  /**
   * Números sem cliente das sessões de vendedor, do mais ativo para o menos,
   * cada um com o cliente sugerido e a evidência (ver sugestao-vinculo.ts).
   * Cálculo pesado (ERP + orçamentos + agenda do WAHA): cache de 10 minutos,
   * zerado a cada vínculo ou "não é cliente".
   */
  async sugestoesVinculo(limite = 50, dias = 30) {
    const chaveCache = `${limite}|${dias}`;
    if (this.sugestoesCache?.chave === chaveCache && Date.now() - this.sugestoesCache.em < 600_000) {
      return this.sugestoesCache.valor;
    }
    const desde = new Date(Date.now() - dias * 86_400_000);
    const ignoradas = await this.repo.chavesIgnoradas();
    const todos = (await this.repo.semClientePorVolume()).filter((x) => !ignoradas.has(x.chave));
    const alvo = todos.slice(0, limite);
    const chaves = alvo.map((x) => x.chave);
    const reps = [
      ...new Set(alvo.flatMap((x) => x.sessoes.map((s) => this.repDaSessao(s))).filter((r): r is number => r != null)),
    ];

    const [textos, entregas, intranet, celta, clientes, agendas] = await Promise.all([
      this.repo.textoDasChaves(chaves, desde),
      this.repo.entregasNasChaves(chaves, desde).catch((e) => this.avisar('entregas', e, [] as Awaited<ReturnType<WhatsappRepository['entregasNasChaves']>>)),
      this.repo.orcamentosIntranet(reps, desde).catch((e) => this.avisar('orçamentos da intranet', e, [] as Awaited<ReturnType<WhatsappRepository['orcamentosIntranet']>>)),
      this.orcamentosCelta(reps, desde).catch((e) => this.avisar('orçamentos do Celta', e, [] as OrcamentoJanela[])),
      this.clientesAtacado().catch((e) => this.avisar('clientes do ERP', e, [] as ClienteCadastro[])),
      Promise.all(alvo.map((x) => this.nomeAgenda(x.sessoes[0], x.chave, x.telefone))),
    ]);

    const conversas: ConversaSemCliente[] = alvo.map((x, i) => ({
      chave: x.chave,
      rep: this.repDaSessao(x.sessoes[0]),
      textoPorDia: new Map(),
      nomeAgenda: agendas[i],
    }));
    const convDe = new Map(conversas.map((c) => [c.chave, c]));
    for (const t of textos) {
      const c = convDe.get(t.chave);
      if (!c) continue;
      const dia = diaCuiaba(t.timestamp);
      c.textoPorDia.set(dia, `${c.textoPorDia.get(dia) ?? ''} ${t.corpo ?? ''} ${t.transcricao ?? ''}`);
    }
    const orcamentos: OrcamentoJanela[] = [
      ...celta,
      ...intranet
        .filter((o) => o.rep_codigo != null)
        .map((o) => ({
          origem: 'INTRANET' as const,
          numero: String(o.numero),
          rep: o.rep_codigo as number,
          cli: o.cli_codigo,
          cliNome: o.cli_nome,
          dia: diaCuiaba(o.created_at),
          itens: o.itens.map((i) => i.descricao ?? ''),
        })),
    ];
    const sugestoes = sugerirVinculos(
      conversas,
      orcamentos,
      entregas.map((e) => ({
        chave: e.chave,
        rep: Number(e.rep),
        cli: Number(e.cli),
        cliNome: e.cli_nome,
        numero: String(e.numero),
        entregueEm: new Date(e.entregue_em),
      })),
      clientes,
    );

    const valor = {
      gerado_em: new Date().toISOString(),
      janela_dias: dias,
      total_sem_cliente: todos.length,
      mensagens_sem_cliente: todos.reduce((s, x) => s + x.mensagens, 0),
      itens: alvo.map((x, i) => ({
        chave: x.chave,
        telefone: x.telefone,
        lid: x.chave.length > 11,
        sessoes: x.sessoes,
        rep_codigos: [...new Set(x.sessoes.map((s) => this.repDaSessao(s)).filter((r) => r != null))],
        mensagens: x.mensagens,
        ultima_atividade: x.ultima,
        nome_agenda: agendas[i],
        ...(sugestoes.get(x.chave) ?? { confianca: null, sugestoes: [] }),
      })),
    };
    this.sugestoesCache = { chave: chaveCache, em: Date.now(), valor };
    return valor;
  }

  private avisar<T>(fonte: string, e: unknown, vazio: T): T {
    this.logger.warn(`Sugestão de vínculo sem ${fonte}: ${(e as Error).message}`);
    return vazio;
  }

  /** Número ainda não lido na agenda nos últimos 10 min (e marca a leitura). */
  private agendaVencida(sessao: string, chave: string): boolean {
    const k = `${sessao}|${chave}`;
    const em = this.agendaLida.get(k);
    if (em != null && Date.now() - em < 10 * 60_000) return false;
    if (this.agendaLida.size > 5_000) this.agendaLida.clear();
    this.agendaLida.set(k, Date.now());
    return true;
  }

  /**
   * Nome do contato: o salvo na agenda do celular corporativo, senão o do perfil.
   * `soAgenda` (vínculo automático) lê o WAHA na hora e devolve só o nome salvo
   * pelo vendedor: o do perfil é escolhido pela própria pessoa e não vincula.
   */
  private async nomeAgenda(sessao: string, chave: string, telefone: string, soAgenda = false): Promise<string | null> {
    const k = `${sessao}|${chave}`;
    if (!soAgenda && this.agendaCache.has(k)) return this.agendaCache.get(k) ?? null;
    const waha = this.sessoes.wahaDe(sessao);
    if (!waha.url) return null;
    const contato = chave.length > 11 ? `${telefone}@lid` : telefone;
    try {
      const r = await fetch(
        `${waha.url}/api/contacts?contactId=${encodeURIComponent(contato)}&session=${encodeURIComponent(sessao)}`,
        { headers: { 'X-Api-Key': waha.key }, signal: AbortSignal.timeout(10_000) },
      );
      const j = r.ok ? ((await r.json()) as { name?: string | null; pushname?: string | null }) : null;
      const salvo = (j?.name || '').trim() || null;
      const nome = salvo ?? ((j?.pushname || '').trim() || null);
      this.agendaCache.set(k, nome);
      return soAgenda ? salvo : nome;
    } catch {
      return null; // WAHA fora: a sugestão segue sem o sinal do nome
    }
  }

  /** Orçamentos do Celta dos vendedores na janela, com a descrição dos itens. */
  private async orcamentosCelta(reps: number[], desde: Date): Promise<OrcamentoJanela[]> {
    if (!reps.length) return [];
    const cab = await this.erp.consultar<Record<string, any>>('orcamentos', {
      empresa: EMPRESA,
      campos: ['ORCAMENTO', 'EMISSAO', 'CLI_CODIGO', 'CLI_NOME', 'REP_CODIGO'],
      filtros: [
        { campo: 'EMISSAO', op: 'maior_igual', valor: desde.toISOString().slice(0, 10) },
        { campo: 'REP_CODIGO', op: 'em', valor: reps },
      ],
      limite: 20_000,
    });
    const itens = new Map<number, string[]>();
    const nums = cab.map((o) => Number(o.ORCAMENTO));
    for (let i = 0; i < nums.length; i += 500) {
      const lote = nums.slice(i, i + 500);
      const r = await this.erp.consultar<Record<string, any>>('orcamentos-itens', {
        empresa: EMPRESA,
        campos: ['ORCAMENTO', 'PRO_DESCRICAO', 'CANCELADO'],
        filtros: [{ campo: 'ORCAMENTO', op: 'em', valor: lote }],
        limite: 20_000,
      });
      for (const it of r) {
        if (String(it.CANCELADO ?? '').trim() === 'S') continue;
        const n = Number(it.ORCAMENTO);
        (itens.get(n) ?? itens.set(n, []).get(n)!).push(String(it.PRO_DESCRICAO ?? ''));
      }
    }
    return cab.map((o) => ({
      origem: 'CELTA' as const,
      numero: String(o.ORCAMENTO),
      rep: Number(o.REP_CODIGO),
      cli: Number(o.CLI_CODIGO),
      cliNome: o.CLI_NOME ?? null,
      dia: String(o.EMISSAO).slice(0, 10),
      itens: itens.get(Number(o.ORCAMENTO)) ?? [],
    }));
  }

  /** Clientes do atacado (nome e pessoa de contato) — base do sinal do nome na agenda. */
  private async clientesAtacado(): Promise<ClienteCadastro[]> {
    const r = await this.erp.consultar<Record<string, any>>('clientes', {
      empresa: EMPRESA,
      campos: ['CLI_CODIGO', 'CLI_NOME', 'CONTATO'],
      filtros: [{ campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO }],
      limite: 20_000,
    });
    return r.map((c) => ({ cli: Number(c.CLI_CODIGO), nome: String(c.CLI_NOME ?? ''), contato: c.CONTATO ?? null }));
  }

  /** Clientes do atacado por código (nome) — cache de 10 min; o webhook consulta a cada número novo. */
  private async atacado() {
    if (this.atacadoCache && Date.now() - this.atacadoCache.em < 10 * 60_000) return this.atacadoCache;
    const nomes = new Map((await this.clientesAtacado()).map((c) => [c.cli, c.nome] as [number, string]));
    this.atacadoCache = { em: Date.now(), nomes, codigos: new Set(nomes.keys()) };
    return this.atacadoCache;
  }

  /**
   * Código do cliente no nome da agenda → vínculo. Chave sem vínculo: vincula
   * (origem AGENDA; o vincular do repo já religa o histórico da chave). Mesmo
   * cliente: só completa o nome da pessoa se estiver vazio. Outro cliente:
   * registra a divergência e mantém o vínculo atual.
   */
  private async vincularPelaAgenda(
    sessao: string,
    chave: string,
    telefone: string,
    nome: string | null,
  ): Promise<'vinculado' | 'divergencia' | null> {
    if (!nome) return null;
    const { nomes, codigos } = await this.atacado();
    const achado = codigoDaAgenda(nome, codigos);
    if (!achado) return null;
    const atual = await this.repo.contatoPorChave(chave);
    if (!atual) {
      // Só vincula cliente da carteira do dono da sessão: o resto fica na lista de sugestões.
      const rep = this.repDaSessao(sessao);
      if (rep == null || (await this.repo.donoDaCarteira(achado.cli_codigo)) !== rep) return null;
      await this.repo.vincular({
        chave,
        telefone,
        cli_codigo: achado.cli_codigo,
        cli_nome: nomes.get(achado.cli_codigo) ?? null,
        contato_nome: achado.contato_nome,
        origem: 'AGENDA',
        criado_por: `agenda:${sessao}`,
      });
      this.sugestoesCache = null;
      return 'vinculado';
    }
    if (atual.cli_codigo === achado.cli_codigo) {
      if (achado.contato_nome) await this.repo.preencherContatoNome(chave, achado.contato_nome);
      return null;
    }
    await this.repo.upsertDivergencia({
      chave,
      sessao,
      nome_agenda: nome,
      cli_agenda: achado.cli_codigo,
      cli_vinculado: atual.cli_codigo,
    });
    return 'divergencia';
  }

  /**
   * Varredura das agendas: lê os contatos salvos de cada sessão com vendedor,
   * cada uma na sua instância do WAHA, e vincula pelo código no nome. Roda na
   * carga diária e por POST /whatsapp/contatos/varrer-agendas; sessão que falha
   * (desconectada no WAHA, por exemplo) não para as outras.
   */
  async varrerAgendas() {
    const r = { sessoes: 0, contatos_lidos: 0, vinculados: 0, divergencias: 0 };
    const sessoes = this.sessoes.sessoesComVendedor();
    if (!sessoes.length) return r;
    const ignoradas = await this.repo.chavesIgnoradas();
    for (const sessao of sessoes) {
      try {
        const waha = this.sessoes.wahaDe(sessao);
        const c = await fetch(`${waha.url}/api/contacts/all?session=${encodeURIComponent(sessao)}`, {
          headers: { 'X-Api-Key': waha.key },
          signal: AbortSignal.timeout(60_000),
        });
        if (!c.ok) throw new Error(`HTTP ${c.status}`);
        const contatos = (await c.json()) as Array<{ id?: string; name?: string | null }>;
        r.sessoes++;
        for (const ct of contatos) {
          if (!ct.id || !ct.name) continue;
          const telefone = String(ct.id).replace(/@.*$/, '').replace(/\D/g, '');
          const chave = chaveTelefone(telefone);
          if (!chave || ignoradas.has(chave)) continue;
          r.contatos_lidos++;
          const x = await this.vincularPelaAgenda(sessao, chave, telefone, ct.name);
          if (x === 'vinculado') r.vinculados++;
          else if (x === 'divergencia') r.divergencias++;
        }
      } catch (e) {
        this.logger.warn(`Agenda da sessão ${sessao} não lida: ${(e as Error).message}`);
      }
    }
    this.logger.log(
      `Varredura de agendas: ${r.sessoes} sessões, ${r.contatos_lidos} contatos, ` +
        `${r.vinculados} vínculos novos, ${r.divergencias} divergências.`,
    );
    return r;
  }

  /** Divergências da agenda com o nome dos dois clientes (null se fora do atacado). */
  async divergencias() {
    const [ds, { nomes }] = await Promise.all([this.repo.listarDivergencias(), this.atacado()]);
    return ds.map((d) => ({
      chave: d.chave,
      telefone: d.telefone,
      sessao: d.sessao,
      nome_agenda: d.nome_agenda,
      cli_agenda: d.cli_agenda,
      cli_agenda_nome: nomes.get(d.cli_agenda) ?? null,
      cli_vinculado: d.cli_vinculado,
      cli_vinculado_nome: nomes.get(d.cli_vinculado) ?? null,
      visto_em: d.visto_em,
    }));
  }

  /** Gestão decide: 'manter' o vínculo atual ou trocar para o cliente da 'agenda'. */
  async resolverDivergencia(chave: string, acao: string, usuario_id?: string) {
    if (acao !== 'manter' && acao !== 'agenda') throw new BadRequestException("acao deve ser 'manter' ou 'agenda'.");
    await this.exigirPapel(usuario_id, { gestao: true });
    const d = await this.repo.divergencia(chave);
    if (!d) return { ok: true };
    if (acao === 'agenda') {
      const { nomes, codigos } = await this.atacado();
      const atual = await this.repo.contatoPorChave(chave);
      await this.repo.vincular({
        chave,
        telefone: atual?.telefone ?? chave,
        cli_codigo: d.cli_agenda,
        cli_nome: nomes.get(d.cli_agenda) ?? null,
        contato_nome: codigoDaAgenda(d.nome_agenda, codigos)?.contato_nome ?? null,
        origem: 'AGENDA',
        criado_por: `agenda:${d.sessao}`,
      });
      this.sugestoesCache = null;
      await this.repo.apagarDivergencia(chave);
    } else {
      await this.repo.manterDivergencia(chave);
    }
    return { ok: true };
  }

  /** 1 toque que aprende para sempre: vincula a chave e conserta o histórico. */
  async vincular(dto: {
    telefone: string;
    cli_codigo: number;
    cli_nome?: string;
    usuario_nome?: string;
    contato_nome?: string;
    usuario_id?: string;
  }) {
    if (!dto.telefone || dto.cli_codigo == null) {
      throw new BadRequestException('telefone e cli_codigo são obrigatórios.');
    }
    const chave = chaveTelefone(dto.telefone) ?? dto.telefone.replace(/\D/g, '');
    if (!chave) throw new BadRequestException('Telefone inválido.');
    const cli_codigo = Number(dto.cli_codigo);
    // número já vinculado = alterar (só gestão); novo = vendedor na própria carteira
    const existente = await this.repo.contatoPorChave(chave);
    const u = await this.exigirPapel(dto.usuario_id, existente ? { gestao: true } : { cli: cli_codigo });
    this.sugestoesCache = null;
    return this.repo.vincular({
      chave,
      telefone: dto.telefone,
      cli_codigo,
      cli_nome: dto.cli_nome ?? null,
      criado_por: u.nome,
      // ausente não apaga o nome que já está lá
      contato_nome: dto.contato_nome === undefined ? undefined : dto.contato_nome.trim() || null,
    });
  }

  /** Números do cliente (ERP, manual e agenda) — o menu do Conversar e a tela de contatos. */
  contatosDoCliente(cli_codigo: number) {
    return this.repo.contatosDoCliente(cli_codigo);
  }

  /** Apagar número: só gestão; o do cadastro do ERP volta na semente — corrige-se no Celta. */
  async removerContato(chave: string, usuario_id?: string) {
    await this.exigirPapel(usuario_id, { gestao: true });
    const c = await this.repo.contatoPorChave(chave);
    if (!c) return { ok: true };
    if (c.origem === 'SEED_ERP') {
      throw new BadRequestException('Número do cadastro do ERP: corrija no Celta.');
    }
    await this.repo.removerContato(chave);
    this.sugestoesCache = null;
    return { ok: true };
  }

  /**
   * Papel de vendas de quem mexe nos contatos: gestão (ehGestaoVendas) faz
   * tudo; o vendedor só adiciona número a cliente da própria carteira.
   */
  async exigirPapel(usuario_id: string | undefined, o: { gestao?: boolean; cli?: number }) {
    const u = await this.repo.usuarioVendas(usuario_id);
    if (!u) throw new ForbiddenException('Usuário não identificado.');
    if (ehGestaoVendas(u)) return u;
    if (o.gestao) throw new ForbiddenException('Só a gestão de vendas altera ou apaga contatos.');
    if (o.cli != null && (u.vendas_rep_codigo == null || (await this.repo.donoDaCarteira(o.cli)) !== u.vendas_rep_codigo)) {
      throw new ForbiddenException('Só para cliente da sua carteira.');
    }
    return u;
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
    return this.repo.ultimaConversaDaSessao(this.sessoes.sessoesDoRep(rep_codigo));
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
        sessoes_liberadas: this.sessoes.sessoesComCorpo(),
        com_corpo: m.comCorpo ?? 0,
        com_midia: m.comMidia ?? 0,
        audios,
      },
    };
  }
}
