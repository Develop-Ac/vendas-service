import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { ven_wa_reconexao, ven_wa_sessao } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessoesService } from './sessoes.service';
import { HistoricoEstado, WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';

/**
 * Reconexão da sessão do WhatsApp pelo próprio usuário (ven_wa_reconexao).
 *
 * Roda no fim de cada tick do monitor (gancho `SessoesService.aoFimDoTick`), sobre as
 * linhas de ven_wa_sessao já atualizadas pelo tick:
 * - Marca: sessão com usuário da intranet, em FAILED/STOPPED/SCAN_QR_CODE há 3 leituras
 *   seguidas e sem reconexão em aberto. `caiu_em` = última saída de WORKING (evento
 *   `status`); sessão que nunca saiu de WORKING (não pareou ainda) não marca. STARTING e
 *   AUSENTE não marcam.
 * - Conclui: reconexão em aberto cuja sessão voltou a WORKING (pelo aviso ou pela tela,
 *   com ou sem usuário hoje). Sessão que guarda conteúdo agenda a recarga do período fora
 *   do ar (desde 1 h antes da queda, primeira rodada em 5 min); sem guarda ou com outro
 *   número pareado, conclui direto.
 * - Recarga: duas rodadas de `WhatsappService.importarHistorico` desde `recarga_de` (a 2ª
 *   1 h depois da 1ª), uma de cada vez no serviço inteiro. `recarga_proxima_em` só anda
 *   quando a rodada termina: reinício no meio repete a rodada (a chave (sessao, message_id)
 *   ignora o que já entrou).
 * Erro numa sessão vai para o log e não para as outras nem o tick.
 *
 * Aviso ao usuário (whatsapp/minha-sessao): pendentes, reconectar (prepara o QR) e o QR ao
 * vivo (registra quem viu), só para o usuário dono da sessão.
 */
const FORA = ['FAILED', 'STOPPED', 'SCAN_QR_CODE'];
const HORA = 3_600_000;
const cuiaba = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Cuiaba' });

@Injectable()
export class ReconexaoService implements OnModuleInit {
  private readonly logger = new Logger(ReconexaoService.name);
  // ponytail: trava em memória, vale para uma instância do serviço; o término da rodada é
  // visto no tick seguinte (até 1 min de atraso). Mais réplicas pedem trava no banco.
  private emCurso: { id: string; estado: HistoricoEstado } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessoes: SessoesService,
    private readonly whatsapp: WhatsappService,
    private readonly repo: WhatsappRepository,
  ) {}

  onModuleInit() {
    this.sessoes.aoFimDoTick = (antes) => this.aposTick(antes);
  }

  async aposTick(antes: Map<string, ven_wa_sessao>) {
    const agora = new Date();
    const [sessoes, abertas] = await Promise.all([
      this.prisma.ven_wa_sessao.findMany(),
      this.prisma.ven_wa_reconexao.findMany({ where: { reconectada_em: null } }),
    ]);
    const abertaDe = new Map(abertas.map((r) => [r.sessao, r]));
    for (const s of sessoes) {
      try {
        const aberta = abertaDe.get(s.sessao);
        if (aberta) {
          if (s.status === 'WORKING') await this.concluir(s, aberta, antes.get(s.sessao)?.telefone ?? null, agora);
        } else if (s.usuario_codigo != null && FORA.includes(s.status ?? '') && s.leituras_fora >= 3) {
          await this.marcar(s, agora);
        }
      } catch (e) {
        this.logger.error(`Reconexão da sessão ${s.sessao} falhou: ${(e as Error).message}`);
      }
    }
    try {
      await this.recarga(sessoes, agora);
    } catch (e) {
      this.logger.error(`Recarga do WhatsApp falhou: ${(e as Error).message}`);
    }
  }

  /** Acompanha a rodada em curso (sem esperar por ela) e dispara a próxima vencida. */
  private async recarga(sessoes: ven_wa_sessao[], agora: Date) {
    if (this.emCurso) {
      const { id, estado } = this.emCurso;
      if (!estado.terminado_em) return;
      this.emCurso = null;
      const r = await this.prisma.ven_wa_reconexao.findUnique({ where: { id } });
      if (r) {
        const rodadas = r.recarga_rodadas + 1;
        const fim = rodadas >= 2 ? { recarga_proxima_em: null, concluida_em: agora } : { recarga_proxima_em: new Date(agora.getTime() + HORA) };
        await this.prisma.$transaction([
          this.prisma.ven_wa_reconexao.update({
            where: { id },
            data: {
              recarga_rodadas: rodadas,
              recarga_lidas: r.recarga_lidas + estado.lidas,
              recarga_gravadas: r.recarga_gravadas + estado.gravadas,
              recarga_erro: estado.erro ?? null,
              ...fim,
            },
          }),
          this.prisma.ven_wa_sessao_evento.create({
            data: {
              sessao: r.sessao,
              tipo: 'recarga',
              quando: agora,
              detalhe: `${estado.lidas} lidas, ${estado.gravadas} gravadas, de ${cuiaba(r.recarga_de!)} a ${cuiaba(r.reconectada_em!)}`,
            },
          }),
        ]);
      }
    }

    const working = new Set(sessoes.filter((s) => s.status === 'WORKING').map((s) => s.sessao));
    const vencidas = await this.prisma.ven_wa_reconexao.findMany({
      where: { concluida_em: null, recarga_proxima_em: { lte: agora } },
      orderBy: { recarga_proxima_em: 'asc' },
    });
    const r = vencidas.find((v) => working.has(v.sessao));
    if (!r) return;
    try {
      this.emCurso = { id: r.id, estado: this.whatsapp.importarHistorico(r.sessao, r.recarga_de!.toISOString()) };
    } catch (e) {
      if (e instanceof ConflictException) return; // importação manual da mesma sessão; tenta no próximo tick
      await this.prisma.ven_wa_reconexao.update({
        where: { id: r.id },
        data: { recarga_erro: (e as Error).message, recarga_proxima_em: null, concluida_em: agora },
      });
    }
  }

  private async marcar(s: ven_wa_sessao, agora: Date) {
    const [queda, usuario] = await Promise.all([
      this.prisma.ven_wa_sessao_evento.findFirst({
        where: { sessao: s.sessao, tipo: 'status', de: 'WORKING' },
        orderBy: { quando: 'desc' },
        select: { quando: true },
      }),
      this.prisma.sis_usuarios.findFirst({ where: { codigo: s.usuario_codigo! }, select: { nome: true } }),
    ]);
    if (!queda) return; // nunca saiu de WORKING: sessão que ainda não pareou não é queda
    const caiu_em = queda.quando;
    await this.prisma.$transaction([
      this.prisma.ven_wa_reconexao.create({ data: { sessao: s.sessao, caiu_em, marcada_em: agora } }),
      this.prisma.ven_wa_sessao_evento.create({
        data: { sessao: s.sessao, tipo: 'reconexao', quando: agora, detalhe: `aguardando ${usuario?.nome ?? s.usuario_codigo}` },
      }),
    ]);
  }

  // ------------------------------------------------------- whatsapp/minha-sessao

  /** Sessões do usuário logado (x-user-id = sis_usuarios.id) com reconexão em aberto, para o aviso. */
  async pendentes(userId: string | undefined) {
    const u = await this.repo.usuarioVendas(userId);
    if (!u) return [];
    const [minhas, abertas] = await Promise.all([
      this.prisma.ven_wa_sessao.findMany({ where: { usuario_codigo: u.codigo } }),
      this.prisma.ven_wa_reconexao.findMany({ where: { reconectada_em: null } }),
    ]);
    const abertaDe = new Map(abertas.map((r) => [r.sessao, r]));
    return minhas
      .filter((s) => abertaDe.has(s.sessao))
      .map((s) => ({ sessao: s.sessao, apelido: s.apelido, telefone: s.telefone, caiu_em: abertaDe.get(s.sessao)!.caiu_em }));
  }

  /** Usuário e reconexão em aberto da sessão; sessão de outro usuário ou sem reconexão em aberto = 404. */
  private async doUsuario(userId: string | undefined, sessao: string) {
    const u = await this.repo.usuarioVendas(userId);
    const [s, aberta] = await Promise.all([
      this.prisma.ven_wa_sessao.findUnique({ where: { sessao } }),
      this.prisma.ven_wa_reconexao.findFirst({ where: { sessao, reconectada_em: null } }),
    ]);
    if (!u || !s || s.usuario_codigo !== u.codigo || !aberta) {
      throw new NotFoundException(`Nenhuma reconexão pendente da sessão ${sessao} para você.`);
    }
    return { u, aberta };
  }

  /**
   * Prepara a sessão para o QR do usuário. FAILED/STOPPED: logout (o WAHA apaga o login e, com a
   * sessão rodando, já recomeça pedindo QR); se continuar parada, restart (para e sobe de novo,
   * vale para FAILED e STOPPED). WORKING/SCAN_QR_CODE/STARTING: nada no WAHA. Sem apps.purge:
   * as mensagens guardadas pelo WAHA ficam.
   */
  async reconectar(userId: string | undefined, sessao: string) {
    const { u, aberta } = await this.doUsuario(userId, sessao);
    const caminho = `/api/sessions/${encodeURIComponent(sessao)}`;
    const statusAoVivo = async () =>
      ((await (await this.sessoes.waha(sessao, caminho)).json()) as { status?: string })?.status ?? 'DESCONHECIDO';
    const parada = (st: string) => st === 'FAILED' || st === 'STOPPED';
    let status = await statusAoVivo();
    const agora = new Date();
    const deslogar = parada(status);
    if (deslogar) await this.sessoes.waha(sessao, `${caminho}/logout`, { method: 'POST' });
    // Grava antes do restart: o logout já feito fica no histórico mesmo se o WAHA falhar depois.
    await this.prisma.$transaction([
      this.prisma.ven_wa_reconexao.update({ where: { id: aberta.id }, data: { modal_visto_em: agora } }),
      ...(deslogar ? [this.prisma.ven_wa_sessao_evento.create({ data: { sessao, tipo: 'logout', usuario: u.nome, quando: agora } })] : []),
    ]);
    if (deslogar) {
      status = await statusAoVivo();
      if (parada(status)) {
        await this.sessoes.waha(sessao, `${caminho}/restart`, { method: 'POST' });
        status = await statusAoVivo();
      }
    }
    return { status };
  }

  /**
   * QR da sessão para o próprio usuário: status ao vivo, imagem só em SCAN_QR_CODE (sem 409; o aviso
   * tenta de novo). Entregar a imagem grava `qr_por` = usuário; o QR da tela limpa (quem viu o QR por
   * último é quem reconectou).
   */
  async qr(userId: string | undefined, sessao: string) {
    const { u, aberta } = await this.doUsuario(userId, sessao);
    const r = await this.sessoes.qrAoVivo(sessao);
    if (r.imagem && aberta.qr_por !== u.nome) {
      await this.prisma.ven_wa_reconexao.update({ where: { id: aberta.id }, data: { qr_por: u.nome } });
    }
    return r;
  }

  private async concluir(s: ven_wa_sessao, r: ven_wa_reconexao, telefoneAntes: string | null, agora: Date) {
    const mudou = telefoneAntes && s.telefone && telefoneAntes !== s.telefone;
    const detalhe = mudou ? `número mudou: ${telefoneAntes} → ${s.telefone}` : s.telefone;
    // Outro número pareado: não importa o histórico dele para a sessão do vendedor.
    const recarga = mudou
      ? { recarga_erro: 'número mudou', concluida_em: agora }
      : this.sessoes.guardaCorpo(s.sessao)
        ? { recarga_de: new Date(r.caiu_em.getTime() - HORA), recarga_proxima_em: new Date(agora.getTime() + 5 * 60_000) }
        : { recarga_erro: 'sessão não guarda conteúdo', concluida_em: agora };
    await this.prisma.$transaction([
      this.prisma.ven_wa_reconexao.update({
        where: { id: r.id },
        data: { reconectada_em: agora, reconectada_por: r.qr_por, ...recarga },
      }),
      this.prisma.ven_wa_sessao_evento.create({
        data: { sessao: s.sessao, tipo: 'reconectada', usuario: r.qr_por, quando: agora, detalhe },
      }),
    ]);
  }
}
