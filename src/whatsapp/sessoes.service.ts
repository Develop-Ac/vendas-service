import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Prisma, ven_wa_sessao } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AvisosService } from '../common/avisos/avisos.module';
import { hojeCuiabaYmd } from '../orcamento/orcamento.prisma.repository';
import { WhatsappRepository } from './whatsapp.repository';

/**
 * Sessões do WAHA (tabela ven_wa_sessao) e monitor das instâncias.
 *
 * Instâncias: env WA_INSTANCIAS = JSON `[{id,nome,url,key}]`, lida uma vez no boot; sem
 * ela, só `local` montada de WA_API_URL/WA_API_KEY. Toda chamada ao WAHA por sessão
 * resolve URL e chave por `wahaDe(sessao)` (sessão desconhecida = `local`).
 *
 * Cache em memória sessão → {instancia, rep_codigo, guarda_corpo, status}: o webhook é
 * caminho quente e lê pelos getters síncronos. Carregado no boot, renovado no fim de
 * cada tick e após cada escrita (`recarregar()`). Sessão que não está no cache (tabela
 * ainda sem a semente ou cache que não carregou) cai no padrão `rep-<código>` com
 * guarda de conteúdo — o mesmo que a semente grava —, para o webhook não descartar.
 *
 * Monitor (a cada minuto; WA_MONITOR_CRON_DISABLED=true desliga — sem ele o status
 * não muda e sessão criada direto no WAHA não entra na tabela): lista as sessões de
 * cada instância, insere as novas, marca AUSENTE as que sumiram, grava evento de
 * mudança de status, reinicia FAILED/STOPPED uma vez por queda e avisa a tela
 * /sistema/whatsapp na 2ª leitura seguida fora de WORKING (ou da instância sem resposta).
 *
 * Ações da tela /sistema/whatsapp (criar, editar, QR, reiniciar, deslogar, trocar
 * vendedor) exigem a permissão da tela em sis_permissoes: visualizar para ler, editar
 * para agir. Quem agiu fica em `usuario` do evento.
 */
const DESLIGADO = process.env.WA_MONITOR_CRON_DISABLED === 'true';
const LINK = '/sistema/whatsapp';
const TELA = '/sistema/whatsapp';
/** Tarefas e resgates que acompanham o vendedor na troca (os mesmos de /transferiveis). */
const tarefasAbertas = (rep: number) => ({ rep_codigo: rep, status: { in: ['ABERTA', 'ESCALADA'] } });
const resgatesAbertos = (rep: number) => ({ rep_codigo: rep, estagio: { notIn: ['RECUPERADO', 'PERDIDO'] } });

export interface InstanciaWaha {
  id: string;
  nome: string;
  url: string;
  key: string;
}

interface SessaoCache {
  instancia: string;
  rep_codigo: number | null;
  guarda_corpo: boolean;
  status: string | null;
}

interface SessaoWaha {
  name: string;
  status: string;
  me?: { id?: string | null; pushName?: string | null } | null;
}

@Injectable()
export class SessoesService implements OnModuleInit {
  private readonly logger = new Logger(SessoesService.name);
  private cache = new Map<string, SessaoCache>();
  /** leituras seguidas sem resposta, por instância */
  private falhasInstancia = new Map<string, number>();
  private instanciasAvisadas = new Set<string>();
  /** Instâncias já lidas desde o boot: a 1ª leitura resolve o aviso de queda que ficou de antes do restart. */
  private instanciasLidas = new Set<string>();
  private rodando = false;
  private readonly lista: InstanciaWaha[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly avisos: AvisosService,
    private readonly repo: WhatsappRepository,
  ) {
    this.lista = this.lerInstancias();
  }

  async onModuleInit() {
    try {
      await this.recarregar();
    } catch (e) {
      this.logger.error(`Cache de sessões do WhatsApp não carregou: ${(e as Error).message}`);
    }
  }

  private lerInstancias(): InstanciaWaha[] {
    const semBarra = (u: string) => (u ?? '').replace(/\/+$/, '');
    const raw = process.env.WA_INSTANCIAS;
    if (raw) {
      try {
        const lista = JSON.parse(raw) as InstanciaWaha[];
        return lista.map((i) => ({ ...i, url: semBarra(i.url) }));
      } catch {
        // Sem a mensagem do JSON.parse: ela traz um trecho do texto, que pode conter a chave.
        this.logger.error('WA_INSTANCIAS inválida, usando só a local.');
      }
    }
    return [{ id: 'local', nome: 'WAHA local', url: semBarra(process.env.WA_API_URL ?? ''), key: process.env.WA_API_KEY ?? '' }];
  }

  instancias(): InstanciaWaha[] {
    return this.lista;
  }

  wahaDe(sessao: string): { url: string; key: string } {
    const lista = this.lista;
    const id = this.cache.get(sessao)?.instancia ?? 'local';
    const i = lista.find((x) => x.id === id) ?? lista.find((x) => x.id === 'local') ?? lista[0];
    return { url: i.url, key: i.key };
  }

  async recarregar() {
    const rows = await this.prisma.ven_wa_sessao.findMany({
      select: { sessao: true, instancia: true, rep_codigo: true, guarda_corpo: true, status: true },
    });
    this.cache = new Map(rows.map(({ sessao, ...r }) => [sessao, r]));
  }

  /** Sessão fora do cache: `rep-<código>` vale como vendedor com guarda de conteúdo (ver topo). */
  private padraoDoNome(sessao: string): number | null {
    const m = /^rep-(\d+)$/.exec(sessao);
    return m ? Number(m[1]) : null;
  }

  repDaSessao(sessao: string): number | null {
    const c = this.cache.get(sessao);
    return c ? c.rep_codigo : this.padraoDoNome(sessao);
  }

  guardaCorpo(sessao: string): boolean {
    const c = this.cache.get(sessao);
    return c ? c.guarda_corpo : this.padraoDoNome(sessao) != null;
  }

  /** Sem vendedor e sem guarda de conteúdo: o webhook descarta (inclui sessão desconhecida fora do padrão rep-<código>). */
  ignorada(sessao: string): boolean {
    return this.repDaSessao(sessao) == null && !this.guardaCorpo(sessao);
  }

  sessoesDoRep(rep: number): string[] {
    return [...this.cache].filter(([, c]) => c.rep_codigo === rep).map(([s]) => s);
  }

  sessoesComVendedor(): string[] {
    return [...this.cache].filter(([, c]) => c.rep_codigo != null).map(([s]) => s);
  }

  /** Sessões com guarda de conteúdo (corpo, mídia, transcrição). */
  sessoesComCorpo(): string[] {
    return [...this.cache].filter(([, c]) => c.guarda_corpo).map(([s]) => s);
  }

  @Cron(DESLIGADO ? '0 0 1 1 *' : '* * * * *', { name: 'whatsapp-monitor', disabled: DESLIGADO })
  async monitorar() {
    if (this.rodando) return;
    this.rodando = true;
    try {
      await this.tick();
    } catch (e) {
      this.logger.error(`Ciclo do monitor do WhatsApp falhou: ${(e as Error).message}`);
    } finally {
      this.rodando = false;
    }
  }

  async tick() {
    const banco = await this.prisma.ven_wa_sessao.findMany();
    const porNome = new Map(banco.map((r) => [r.sessao, r]));
    const agora = new Date();

    for (const inst of this.lista) {
      let lista: SessaoWaha[];
      try {
        const r = await fetch(`${inst.url}/api/sessions?all=true`, {
          headers: { 'X-Api-Key': inst.key },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        lista = (await r.json()) as SessaoWaha[];
      } catch (e) {
        // Instância fora: as sessões dela ficam como estão (sem evento nem aviso individual).
        const n = (this.falhasInstancia.get(inst.id) ?? 0) + 1;
        this.falhasInstancia.set(inst.id, n);
        this.logger.warn(`WAHA ${inst.id} sem resposta (${n}x): ${(e as Error).message}`);
        if (n >= 2 && !this.instanciasAvisadas.has(inst.id)) {
          this.avisos.emitir('whatsapp.instancia_fora', { ref: inst.id, vars: { instancia: inst.nome }, link: LINK });
          this.instanciasAvisadas.add(inst.id);
        }
        continue;
      }
      this.falhasInstancia.delete(inst.id);
      if (this.instanciasAvisadas.delete(inst.id) || !this.instanciasLidas.has(inst.id)) {
        this.avisos.resolver('whatsapp.instancia_fora', inst.id);
      }
      this.instanciasLidas.add(inst.id);

      const vistas = new Set<string>();
      for (const s of lista) {
        vistas.add(s.name);
        let row = porNome.get(s.name);
        // Mesmo nome registrado em outra instância: quem move é a troca de instância, não o monitor.
        if (row && row.instancia !== inst.id) continue;
        if (!row) {
          // upsert: a tela pode ter criado a mesma sessão depois da leitura do banco; a linha dela vale.
          row = await this.prisma.ven_wa_sessao.upsert({
            where: { sessao: s.name },
            create: { sessao: s.name, instancia: inst.id, apelido: s.name, guarda_corpo: false },
            update: {},
          });
        }
        await this.aplicar(inst, row, s.status, s.me ?? null, agora);
      }
      // Nada some sozinho: sessão do banco que o WAHA não listou vira AUSENTE.
      for (const row of banco) {
        if (row.instancia === inst.id && !vistas.has(row.sessao)) await this.aplicar(inst, row, 'AUSENTE', undefined, agora);
      }
    }
    await this.recarregar();
  }

  /** `me` undefined = sessão ausente da lista (não mexe em telefone/nome/visto_em). */
  private async aplicar(inst: InstanciaWaha, row: ven_wa_sessao, status: string, me: SessaoWaha['me'] | undefined, agora: Date) {
    const data: Prisma.ven_wa_sessaoUpdateInput = { updated_at: agora };
    let apelido = row.apelido;
    if (me !== undefined) {
      data.visto_em = agora;
      if (me) {
        data.telefone = (me.id ?? '').split('@')[0].replace(/\D/g, '') || null;
        data.push_name = me.pushName ?? null;
        // Nasce com o nome técnico; adota o nome do aparelho na primeira leitura.
        if (row.apelido === row.sessao && me.pushName) apelido = data.apelido = me.pushName;
      }
    }

    const eventos: Prisma.ven_wa_sessao_eventoCreateManyInput[] = [];
    let desde = row.status_desde;
    if (row.status !== status) {
      eventos.push({ sessao: row.sessao, tipo: 'status', de: row.status, para: status, quando: agora });
      data.status = status;
      data.status_desde = desde = agora;
    }

    if ((status === 'FAILED' || status === 'STOPPED') && !row.restart_em) {
      let detalhe: string | null = null;
      try {
        const r = await fetch(`${inst.url}/api/sessions/${encodeURIComponent(row.sessao)}/restart`, {
          method: 'POST',
          headers: { 'X-Api-Key': inst.key },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) detalhe = `HTTP ${r.status}`;
      } catch (e) {
        detalhe = (e as Error).message;
      }
      eventos.push({ sessao: row.sessao, tipo: 'restart', usuario: 'monitor', quando: agora, detalhe });
      data.restart_em = agora;
    }

    let emitir = false;
    if (status === 'WORKING') {
      data.restart_em = null;
      data.leituras_fora = 0;
      data.avisada = false;
      if (row.avisada) this.avisos.resolver('whatsapp.sessao_caiu', row.sessao);
    } else {
      data.leituras_fora = row.leituras_fora + 1;
      if (data.leituras_fora >= 2 && !row.avisada) {
        data.avisada = true;
        emitir = true;
      }
    }

    await this.prisma.ven_wa_sessao.update({ where: { sessao: row.sessao }, data });
    if (eventos.length) await this.prisma.ven_wa_sessao_evento.createMany({ data: eventos });

    if (emitir) {
      this.avisos.emitir('whatsapp.sessao_caiu', {
        ref: row.sessao,
        vars: {
          apelido,
          vendedor: row.rep_nome ?? '—',
          status,
          desde: (desde ?? agora).toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' }),
          instancia: inst.nome,
        },
        link: LINK,
      });
    }
  }

  // ------------------------------------------------------------ ações da tela

  /** Permissão da tela /sistema/whatsapp; devolve quem age para gravar nos eventos. */
  async exigirTela(userId: string | null | undefined, acao: 'visualizar' | 'editar') {
    const u = await this.repo.permissaoTela(userId, TELA);
    if (!u?.sis_permissoes.some((p) => p[acao])) {
      throw new ForbiddenException(`Sem permissão para ${acao === 'editar' ? 'alterar' : 'ver'} as sessões do WhatsApp.`);
    }
    return { id: u.id, nome: u.nome };
  }

  private async linha(sessao: string) {
    const row = await this.prisma.ven_wa_sessao.findUnique({ where: { sessao } });
    if (!row) throw new NotFoundException(`Sessão ${sessao} não encontrada.`);
    return row;
  }

  /** Chamada ao WAHA da instância da sessão; falha do WAHA vira 502 com o texto dele. */
  private async waha(sessao: string, caminho: string, init: { method?: string; body?: unknown } = {}) {
    const { url, key } = this.wahaDe(sessao);
    let r: Response;
    try {
      r = await fetch(`${url}${caminho}`, {
        method: init.method ?? 'GET',
        headers: { 'X-Api-Key': key, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new BadGatewayException(`WAHA sem resposta: ${(e as Error).message}`);
    }
    if (!r.ok) throw new BadGatewayException(`WAHA respondeu HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
    return r;
  }

  /** Instâncias (sem a chave) com as sessões, a última mensagem recebida e desde quando estão com o vendedor. */
  async listar(userId?: string) {
    await this.exigirTela(userId, 'visualizar');
    const [linhas, recebidas, trocas] = await Promise.all([
      this.prisma.ven_wa_sessao.findMany({ orderBy: { apelido: 'asc' } }),
      this.prisma.ven_wa_mensagem.groupBy({ by: ['sessao'], where: { direcao: 'RECEBIDA' }, _max: { timestamp: true } }),
      this.prisma.ven_wa_sessao_evento.findMany({
        where: { tipo: 'vendedor' },
        orderBy: { quando: 'desc' },
        distinct: ['sessao'],
        select: { sessao: true, detalhe: true },
      }),
    ]);
    const ultima = new Map(recebidas.map((g) => [g.sessao, g._max.timestamp]));
    const desde = new Map(trocas.map((t) => [t.sessao, t.detalhe]));
    return this.instancias().map(({ id, nome }) => ({
      id,
      nome,
      sessoes: linhas
        .filter((l) => l.instancia === id)
        .map((l) => ({ ...l, ultima_recebida_em: ultima.get(l.sessao) ?? null, vendedor_desde: desde.get(l.sessao) ?? null })),
    }));
  }

  async eventos(userId: string | undefined, sessao: string, limite = 50) {
    await this.exigirTela(userId, 'visualizar');
    return this.prisma.ven_wa_sessao_evento.findMany({
      where: { sessao },
      orderBy: { quando: 'desc' },
      take: Math.min(Math.max(Math.trunc(limite) || 50, 1), 500),
    });
  }

  /** QR de pareamento; só com a sessão aguardando leitura (status ao vivo no WAHA, não o da última leitura). */
  async qr(userId: string | undefined, sessao: string) {
    await this.exigirTela(userId, 'editar');
    await this.linha(sessao);
    const atual = (await (await this.waha(sessao, `/api/sessions/${encodeURIComponent(sessao)}`)).json()) as { status?: string };
    const status = atual?.status ?? 'DESCONHECIDO';
    if (status !== 'SCAN_QR_CODE') throw new ConflictException(`A sessão está ${status}, não aguardando QR.`);
    const r = await this.waha(sessao, `/api/${encodeURIComponent(sessao)}/auth/qr?format=image`);
    return { status, imagem: `data:image/png;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` };
  }

  /** Nova sessão na instância local (`wa-<apelido>`), já com o webhook de mensagens. */
  async criar(
    userId: string | undefined,
    dto: { apelido?: string; rep_codigo?: number | null; rep_nome?: string | null; guarda_corpo?: boolean },
  ) {
    const u = await this.exigirTela(userId, 'editar');
    const apelido = (dto?.apelido ?? '').trim();
    const slug = apelido
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!slug) throw new BadRequestException('Informe o apelido da sessão.');
    const rep_codigo = dto.rep_codigo ?? null;
    if (rep_codigo !== null && !Number.isInteger(rep_codigo)) throw new BadRequestException('rep_codigo inválido.');
    const webhook = process.env.WA_WEBHOOK_URL;
    if (!webhook) throw new BadRequestException('WA_WEBHOOK_URL não configurada no vendas-service.');
    const sessao = `wa-${slug}`;
    if (await this.prisma.ven_wa_sessao.findUnique({ where: { sessao } })) {
      throw new ConflictException(`Já existe a sessão ${sessao}.`);
    }
    await this.waha(sessao, '/api/sessions', {
      method: 'POST',
      body: {
        name: sessao,
        start: true,
        config: {
          noweb: { store: { enabled: true, fullSync: true } },
          webhooks: [
            {
              url: webhook,
              // message.any já traz as recebidas; somar 'message' entregaria cada uma duas vezes.
              events: ['message.any', 'message.ack'],
              customHeaders: [{ name: 'x-webhook-token', value: process.env.WA_WEBHOOK_TOKEN ?? '' }],
            },
          ],
        },
      },
    });
    const dados = {
      instancia: 'local',
      apelido,
      rep_codigo,
      rep_nome: rep_codigo == null ? null : dto.rep_nome?.trim() || null,
      guarda_corpo: dto.guarda_corpo ?? true,
    };
    // upsert: o monitor pode ter inserido a sessão recém-criada no WAHA (sem vendedor) antes daqui.
    const [row] = await this.prisma.$transaction([
      this.prisma.ven_wa_sessao.upsert({ where: { sessao }, create: { sessao, ...dados }, update: dados }),
      this.prisma.ven_wa_sessao_evento.create({
        data: { sessao, tipo: 'criada', para: rep_codigo == null ? null : String(rep_codigo), usuario: u.nome },
      }),
    ]);
    await this.recarregar();
    return row;
  }

  /** Ligar/desligar a guarda de conteúdo fica no histórico (evento `guarda_corpo`, com quem mudou). */
  async editar(userId: string | undefined, sessao: string, dto: { apelido?: string; guarda_corpo?: boolean }) {
    const u = await this.exigirTela(userId, 'editar');
    const atual = await this.linha(sessao);
    const data: Prisma.ven_wa_sessaoUpdateInput = { updated_at: new Date() };
    if (dto?.apelido !== undefined) {
      if (!String(dto.apelido).trim()) throw new BadRequestException('O apelido não pode ficar vazio.');
      data.apelido = String(dto.apelido).trim();
    }
    const guarda = dto?.guarda_corpo === undefined ? atual.guarda_corpo : !!dto.guarda_corpo;
    data.guarda_corpo = guarda;
    const [row] = await this.prisma.$transaction([
      this.prisma.ven_wa_sessao.update({ where: { sessao }, data }),
      ...(guarda === atual.guarda_corpo
        ? []
        : [
            this.prisma.ven_wa_sessao_evento.create({
              data: { sessao, tipo: 'guarda_corpo', de: String(atual.guarda_corpo), para: String(guarda), usuario: u.nome },
            }),
          ]),
    ]);
    await this.recarregar();
    return row;
  }

  /** Reiniciar (zera restart_em: o monitor volta a poder reiniciar sozinho) ou deslogar (volta a pedir QR). */
  async acao(userId: string | undefined, sessao: string, acao: 'restart' | 'logout') {
    const u = await this.exigirTela(userId, 'editar');
    await this.linha(sessao);
    await this.waha(sessao, `/api/sessions/${encodeURIComponent(sessao)}/${acao}`, { method: 'POST' });
    await this.prisma.$transaction([
      this.prisma.ven_wa_sessao.update({
        where: { sessao },
        data: { updated_at: new Date(), ...(acao === 'restart' ? { restart_em: null } : {}) },
      }),
      this.prisma.ven_wa_sessao_evento.create({ data: { sessao, tipo: acao, usuario: u.nome } }),
    ]);
    await this.recarregar();
    return { ok: true };
  }

  /** O que a troca de vendedor leva junto: tarefas abertas e resgates em andamento do vendedor atual. */
  async transferiveis(userId: string | undefined, sessao: string) {
    await this.exigirTela(userId, 'visualizar');
    const { rep_codigo } = await this.linha(sessao);
    if (rep_codigo == null) return { tarefas: 0, resgates: 0 };
    const [tarefas, resgates] = await Promise.all([
      this.prisma.ven_fila_tarefa.count({ where: tarefasAbertas(rep_codigo) }),
      this.prisma.ven_resgate.count({ where: resgatesAbertos(rep_codigo) }),
    ]);
    return { tarefas, resgates };
  }

  /**
   * Troca o vendedor da sessão a partir de `desde` (dia em Cuiabá, padrão hoje): as
   * mensagens da sessão desde esse dia passam ao novo vendedor; com `transferir_tarefas`
   * (e vendedor antes e depois), as tarefas abertas e os resgates em andamento também.
   */
  async trocarVendedor(
    userId: string | undefined,
    sessao: string,
    dto: { rep_codigo?: number | null; rep_nome?: string | null; desde?: string; transferir_tarefas?: boolean },
  ) {
    const u = await this.exigirTela(userId, 'editar');
    const row = await this.linha(sessao);
    const novo = dto?.rep_codigo ?? null;
    if (novo !== null && !Number.isInteger(novo)) throw new BadRequestException('rep_codigo inválido.');
    const hoje = hojeCuiabaYmd();
    const desde = dto.desde || hoje;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || isNaN(Date.parse(desde))) throw new BadRequestException('Data inválida (AAAA-MM-DD).');
    if (desde > hoje) throw new BadRequestException('A data da troca não pode ser futura.');
    const antigo = row.rep_codigo;
    if (novo === antigo) throw new BadRequestException('A sessão já está com esse vendedor.');
    const rep_nome = novo == null ? null : dto.rep_nome?.trim() || null;
    const agora = new Date();

    const r = await this.prisma.$transaction(
      async (tx) => {
        await tx.ven_wa_sessao.update({ where: { sessao }, data: { rep_codigo: novo, rep_nome, updated_at: agora } });
        await tx.ven_wa_sessao_evento.create({
          data: {
            sessao,
            tipo: 'vendedor',
            de: antigo == null ? null : String(antigo),
            para: novo == null ? null : String(novo),
            detalhe: desde,
            usuario: u.nome,
          },
        });
        // Meia-noite de Cuiabá (UTC-4, sem horário de verão).
        const mensagens = await tx.ven_wa_mensagem.updateMany({
          where: { sessao, timestamp: { gte: new Date(`${desde}T00:00:00-04:00`) } },
          data: { rep_codigo: novo },
        });
        let tarefas = 0;
        let resgates = 0;
        if (dto.transferir_tarefas && antigo != null && novo != null) {
          const data = { rep_codigo: novo, rep_nome, updated_at: agora };
          tarefas = (await tx.ven_fila_tarefa.updateMany({ where: tarefasAbertas(antigo), data })).count;
          resgates = (await tx.ven_resgate.updateMany({ where: resgatesAbertos(antigo), data })).count;
        }
        return { mensagens: mensagens.count, tarefas, resgates };
      },
      { timeout: 30_000 },
    );
    await this.recarregar();
    return r;
  }
}
