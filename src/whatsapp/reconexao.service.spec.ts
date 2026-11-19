import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SessoesService } from './sessoes.service';
import { ReconexaoService } from './reconexao.service';

describe('ReconexaoService (marcação e conclusão no tick)', () => {
  let rows: Map<string, any>;
  let eventos: any[];
  let reconexoes: any[];
  let lista: any[];
  let sessoes: SessoesService;
  let svc: ReconexaoService;
  const usuarios = [{ codigo: '37', nome: 'ALISSON', trash: 0 }];

  const linha = (sessao: string, extra: any = {}) => ({
    sessao,
    instancia: 'local',
    apelido: sessao,
    rep_codigo: 7,
    rep_nome: 'JOAO',
    guarda_corpo: true,
    status: 'WORKING',
    status_desde: new Date('2026-11-19T12:00:00Z'),
    telefone: '5565999998888',
    push_name: null,
    visto_em: null,
    leituras_fora: 0,
    avisada: false,
    restart_em: null,
    usuario_codigo: '37',
    ...extra,
  });

  const prisma: any = {
    ven_wa_sessao: {
      findMany: jest.fn(async ({ where }: any = {}) =>
        [...rows.values()].filter((r) => !where?.usuario_codigo || r.usuario_codigo === where.usuario_codigo).map((r) => ({ ...r })),
      ),
      findUnique: jest.fn(async ({ where }: any) => rows.get(where.sessao) ?? null),
      upsert: jest.fn(),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.get(where.sessao), data)),
    },
    ven_wa_sessao_evento: {
      findMany: jest.fn(async ({ where }: any) =>
        eventos.filter((e) => e.sessao === where.sessao && e.tipo === where.tipo && e.de === where.de),
      ),
      findFirst: jest.fn(
        async ({ where }: any) =>
          eventos
            .filter((e) => e.sessao === where.sessao && e.tipo === where.tipo && e.de === where.de)
            .sort((a, b) => b.quando.getTime() - a.quando.getTime())[0] ?? null,
      ),
      createMany: jest.fn(async ({ data }: any) => eventos.push(...data)),
      create: jest.fn(async ({ data }: any) => eventos.push(data)),
    },
    ven_wa_reconexao: {
      findMany: jest.fn(async ({ where }: any) =>
        reconexoes
          .filter((r) => !('reconectada_em' in where) || (r.reconectada_em ?? null) === where.reconectada_em)
          .filter((r) => !('concluida_em' in where) || (r.concluida_em ?? null) === where.concluida_em)
          .filter((r) => !where.recarga_proxima_em || (r.recarga_proxima_em && r.recarga_proxima_em <= where.recarga_proxima_em.lte))
          .sort((a, b) => (a.recarga_proxima_em?.getTime() ?? 0) - (b.recarga_proxima_em?.getTime() ?? 0)),
      ),
      findUnique: jest.fn(async ({ where }: any) => reconexoes.find((r) => r.id === where.id) ?? null),
      findFirst: jest.fn(
        async ({ where }: any) => reconexoes.find((r) => r.sessao === where.sessao && (r.reconectada_em ?? null) === where.reconectada_em) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `r${reconexoes.length + 1}`, qr_por: null, reconectada_em: null, reconectada_por: null, recarga_de: null, recarga_proxima_em: null, recarga_erro: null, concluida_em: null, ...data };
        reconexoes.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(reconexoes.find((r) => r.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }: any) =>
        reconexoes
          .filter((r) => r.sessao === where.sessao && (r.reconectada_em ?? null) === null && r.qr_por != null)
          .forEach((r) => Object.assign(r, data)),
      ),
    },
    sis_usuarios: {
      findFirst: jest.fn(async ({ where }: any) => usuarios.find((u) => u.codigo === where.codigo) ?? null),
    },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  };
  const fetchMock = jest.fn();

  const waha = (status: string, me: any = { id: '5565999998888@c.us', pushName: 'Fulano' }) => {
    lista = [{ name: 'rep-7', status, me }];
  };
  /** Um tick completo do monitor (com o gancho registrado pelo ReconexaoService). */
  const tick = async (status: string, me?: any) => {
    waha(status, me);
    await sessoes.tick();
  };
  const doTipo = (tipo: string) => eventos.filter((e) => e.tipo === tipo);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WA_INSTANCIAS;
    process.env.WA_API_URL = 'http://waha:3000';
    process.env.WA_API_KEY = 'k';
    rows = new Map([['rep-7', linha('rep-7')]]);
    eventos = [];
    reconexoes = [];
    lista = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/restart')) return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => lista };
    });
    (global as any).fetch = fetchMock;
    sessoes = new SessoesService(prisma, { emitir: jest.fn(), resolver: jest.fn() } as any, {} as any);
    svc = new ReconexaoService(prisma, sessoes, { importarHistorico: jest.fn() } as any, {} as any);
    svc.onModuleInit();
  });

  it('marca na 3ª leitura fora com caiu_em na saída de WORKING e evento "aguardando <usuário>"', async () => {
    await sessoes.recarregar();
    await tick('FAILED', null);
    const saida = eventos.find((e) => e.tipo === 'status' && e.de === 'WORKING').quando;
    await tick('FAILED', null);
    expect(reconexoes).toHaveLength(0);
    await tick('SCAN_QR_CODE', null);
    expect(reconexoes).toHaveLength(1);
    expect(reconexoes[0]).toMatchObject({ sessao: 'rep-7', caiu_em: saida, reconectada_em: null });
    expect(doTipo('reconexao')).toEqual([expect.objectContaining({ sessao: 'rep-7', detalhe: 'aguardando ALISSON' })]);
  });

  it('sem usuário não marca', async () => {
    rows.set('rep-7', linha('rep-7', { usuario_codigo: null, status: 'FAILED', leituras_fora: 5, restart_em: new Date() }));
    await tick('FAILED', null);
    expect(reconexoes).toHaveLength(0);
  });

  it.each(['STARTING', 'AUSENTE'])('%s não marca', async (status) => {
    rows.set('rep-7', linha('rep-7', { status, leituras_fora: 5 }));
    if (status === 'AUSENTE') lista = [];
    else waha(status, null);
    await sessoes.tick();
    expect(reconexoes).toHaveLength(0);
  });

  it('não marca duas vezes', async () => {
    rows.set('rep-7', linha('rep-7', { status: 'FAILED', leituras_fora: 2, restart_em: new Date() }));
    eventos.push({ sessao: 'rep-7', tipo: 'status', de: 'WORKING', para: 'FAILED', quando: new Date('2026-11-19T12:00:00Z') });
    await tick('FAILED', null);
    await tick('FAILED', null);
    await tick('SCAN_QR_CODE', null);
    expect(reconexoes).toHaveLength(1);
    expect(doTipo('reconexao')).toHaveLength(1);
  });

  it('caiu_em é a saída de WORKING mais recente', async () => {
    const ultima = new Date('2026-11-16T10:00:00Z');
    rows.set('rep-7', linha('rep-7', { status: 'FAILED', leituras_fora: 2, restart_em: new Date() }));
    eventos.push(
      { sessao: 'rep-7', tipo: 'status', de: 'WORKING', para: 'FAILED', quando: new Date('2026-11-10T10:00:00Z') },
      { sessao: 'rep-7', tipo: 'status', de: 'WORKING', para: 'FAILED', quando: ultima },
    );
    await tick('FAILED', null);
    expect(reconexoes[0].caiu_em).toEqual(ultima);
  });

  it('sessão que nunca saiu de WORKING (ainda não pareou) não marca', async () => {
    rows.set('rep-7', linha('rep-7', { status: 'SCAN_QR_CODE', leituras_fora: 5 }));
    await tick('SCAN_QR_CODE', null);
    expect(reconexoes).toHaveLength(0);
  });

  it('volta a WORKING antes de marcar não gera reconexão', async () => {
    await tick('FAILED', null);
    await tick('FAILED', null);
    await tick('WORKING');
    expect(reconexoes).toHaveLength(0);
    expect(doTipo('reconectada')).toHaveLength(0);
  });

  describe('conclusão', () => {
    const caiu_em = new Date('2026-11-19T10:00:00Z');
    const aberta = (extra: any = {}) =>
      reconexoes.push({ id: 'r1', sessao: 'rep-7', caiu_em, marcada_em: caiu_em, qr_por: 'ALISSON', reconectada_em: null, ...extra });

    beforeEach(() => rows.set('rep-7', linha('rep-7', { status: 'SCAN_QR_CODE', leituras_fora: 4 })));

    it('agenda recarga desde caiu_em − 1 h e primeira rodada em 5 min', async () => {
      aberta();
      const antes = Date.now();
      await tick('WORKING');
      const r = reconexoes[0];
      expect(r.reconectada_em).toBeInstanceOf(Date);
      expect(r.reconectada_por).toBe('ALISSON');
      expect(r.recarga_de).toEqual(new Date('2026-11-19T09:00:00Z'));
      expect(r.recarga_proxima_em.getTime() - r.reconectada_em.getTime()).toBe(5 * 60_000);
      expect(r.reconectada_em.getTime()).toBeGreaterThanOrEqual(antes);
      expect(r.concluida_em).toBeUndefined();
      expect(doTipo('reconectada')).toEqual([expect.objectContaining({ usuario: 'ALISSON', detalhe: '5565999998888' })]);
    });

    it('conclui mesmo com o usuário tirado da sessão', async () => {
      rows.get('rep-7').usuario_codigo = null;
      aberta();
      await tick('WORKING');
      expect(reconexoes[0].reconectada_em).toBeInstanceOf(Date);
    });

    it('pela tela (qr_por nulo) deixa reconectada_por nulo', async () => {
      aberta({ qr_por: null });
      await tick('WORKING');
      expect(reconexoes[0].reconectada_por).toBeNull();
      expect(doTipo('reconectada')[0].usuario).toBeNull();
    });

    it('sem guarda_corpo conclui com o motivo e sem recarga', async () => {
      rows.get('rep-7').guarda_corpo = false;
      await sessoes.recarregar();
      aberta();
      await tick('WORKING');
      expect(reconexoes[0]).toMatchObject({ recarga_erro: 'sessão não guarda conteúdo', concluida_em: expect.any(Date) });
      expect(reconexoes[0].recarga_de).toBeUndefined();
    });

    it('número mudou', async () => {
      aberta();
      await tick('WORKING', { id: '5565911112222@c.us', pushName: 'Fulano' });
      expect(doTipo('reconectada')[0].detalhe).toBe('número mudou: 5565999998888 → 5565911112222');
      // Outro número pareado: sem recarga, para não importar o histórico dele.
      expect(reconexoes[0]).toMatchObject({ recarga_erro: 'número mudou', concluida_em: expect.any(Date) });
      expect(reconexoes[0].recarga_proxima_em).toBeUndefined();
    });

    it('erro numa sessão não derruba as outras', async () => {
      rows = new Map([
        ['rep-8', linha('rep-8', { status: 'FAILED', leituras_fora: 3 })],
        ['rep-7', linha('rep-7')],
      ]);
      aberta();
      prisma.sis_usuarios.findFirst.mockRejectedValueOnce(new Error('falhou'));
      await svc.aposTick(new Map());
      expect(reconexoes[0].reconectada_em).toBeInstanceOf(Date);
    });
  });

  describe('recarga do período fora do ar', () => {
    let estado: any;
    let importarHistorico: jest.Mock;
    const reconectada_em = new Date('2026-11-19T15:00:00Z');
    const recarga_de = new Date('2026-11-19T09:00:00Z');
    const pendente = (id: string, sessao: string, extra: any = {}) =>
      reconexoes.push({
        id, sessao, caiu_em: new Date('2026-11-19T10:00:00Z'), reconectada_em, recarga_de,
        recarga_proxima_em: new Date(Date.now() - 60_000), recarga_rodadas: 0, recarga_lidas: 0,
        recarga_gravadas: 0, recarga_erro: null, concluida_em: null, ...extra,
      });
    const novoServico = () => {
      svc = new ReconexaoService(prisma, sessoes, { importarHistorico } as any, {} as any);
    };
    const terminar = (lidas: number, gravadas: number, erro: string | null = null) =>
      Object.assign(estado, { lidas, gravadas, erro, terminado_em: new Date().toISOString() });

    beforeEach(() => {
      estado = { lidas: 0, gravadas: 0, erro: null, terminado_em: null };
      importarHistorico = jest.fn(() => estado);
      novoServico();
    });

    it('dispara só com recarga_proxima_em vencido e sessão WORKING, desde recarga_de', async () => {
      rows.set('rep-8', linha('rep-8', { status: 'FAILED' }));
      pendente('r1', 'rep-7', { recarga_proxima_em: new Date(Date.now() + 60_000) });
      pendente('r2', 'rep-8');
      await svc.aposTick(new Map());
      expect(importarHistorico).not.toHaveBeenCalled();
      reconexoes[0].recarga_proxima_em = new Date(Date.now() - 1);
      await svc.aposTick(new Map());
      expect(importarHistorico).toHaveBeenCalledWith('rep-7', recarga_de.toISOString());
    });

    it('duas sessões vencidas: uma por vez', async () => {
      rows.set('rep-8', linha('rep-8'));
      pendente('r1', 'rep-7');
      pendente('r2', 'rep-8');
      await svc.aposTick(new Map());
      await svc.aposTick(new Map());
      expect(importarHistorico).toHaveBeenCalledTimes(1);
      terminar(1, 1);
      estado = { lidas: 0, gravadas: 0, erro: null, terminado_em: null };
      importarHistorico.mockImplementation(() => estado);
      await svc.aposTick(new Map());
      expect(importarHistorico).toHaveBeenCalledTimes(2);
      expect(importarHistorico.mock.calls[1][0]).toBe('rep-8');
    });

    it('1ª rodada soma, grava evento e agenda +1 h; 2ª conclui', async () => {
      pendente('r1', 'rep-7');
      await svc.aposTick(new Map());
      terminar(10, 4);
      const antes = Date.now();
      await svc.aposTick(new Map());
      const r = reconexoes[0];
      expect(r).toMatchObject({ recarga_rodadas: 1, recarga_lidas: 10, recarga_gravadas: 4, concluida_em: null });
      expect(r.recarga_proxima_em.getTime()).toBeGreaterThanOrEqual(antes + 3_600_000);
      expect(doTipo('recarga')).toEqual([
        expect.objectContaining({ sessao: 'rep-7', detalhe: '10 lidas, 4 gravadas, de 19/11/2026, 05:00:00 a 19/11/2026, 11:00:00' }),
      ]);

      r.recarga_proxima_em = new Date(Date.now() - 1);
      estado = { lidas: 0, gravadas: 0, erro: null, terminado_em: null };
      importarHistorico.mockImplementation(() => estado);
      await svc.aposTick(new Map());
      terminar(3, 1);
      await svc.aposTick(new Map());
      expect(r).toMatchObject({ recarga_rodadas: 2, recarga_lidas: 13, recarga_gravadas: 5, recarga_proxima_em: null });
      expect(r.concluida_em).toBeInstanceOf(Date);
      expect(importarHistorico).toHaveBeenCalledTimes(2);
    });

    it('erro da rodada vai para recarga_erro; rodada seguinte sem erro limpa', async () => {
      pendente('r1', 'rep-7');
      await svc.aposTick(new Map());
      terminar(2, 0, 'timeout do WAHA');
      await svc.aposTick(new Map());
      expect(reconexoes[0]).toMatchObject({ recarga_erro: 'timeout do WAHA', recarga_rodadas: 1 });

      reconexoes[0].recarga_proxima_em = new Date(Date.now() - 1);
      estado = { lidas: 0, gravadas: 0, erro: null, terminado_em: null };
      importarHistorico.mockImplementation(() => estado);
      await svc.aposTick(new Map());
      terminar(5, 5);
      await svc.aposTick(new Map());
      expect(reconexoes[0]).toMatchObject({ recarga_erro: null, recarga_rodadas: 2 });
    });

    it('importação manual em andamento (409) tenta no próximo tick; outro erro conclui', async () => {
      pendente('r1', 'rep-7');
      importarHistorico.mockImplementationOnce(() => {
        throw new ConflictException('em andamento');
      });
      await svc.aposTick(new Map());
      expect(reconexoes[0].concluida_em).toBeNull();
      importarHistorico.mockImplementationOnce(() => {
        throw new BadRequestException('URL do WAHA não configurada.');
      });
      await svc.aposTick(new Map());
      expect(reconexoes[0]).toMatchObject({ recarga_erro: 'URL do WAHA não configurada.', recarga_proxima_em: null });
      expect(reconexoes[0].concluida_em).toBeInstanceOf(Date);
    });

    it('reinício do serviço no meio repete a rodada', async () => {
      pendente('r1', 'rep-7');
      await svc.aposTick(new Map());
      novoServico();
      await svc.aposTick(new Map());
      expect(importarHistorico).toHaveBeenCalledTimes(2);
      expect(reconexoes[0].recarga_rodadas).toBe(0);
    });
  });

  describe('minha-sessao (aviso do usuário)', () => {
    const caiu_em = new Date('2026-11-19T10:00:00Z');
    // x-user-id é o sis_usuarios.id (cuid); 'id-37' é o usuário de código 37.
    const repo = { usuarioVendas: jest.fn(async (id: string) => (id === 'id-37' ? { id, codigo: '37', nome: 'ALISSON' } : null)) };
    let statusWaha: string[];
    const chamadas = (fim: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(fim));

    beforeEach(() => {
      rows.set('rep-8', linha('rep-8', { usuario_codigo: '83' }));
      rows.set('rep-9', linha('rep-9'));
      reconexoes.push(
        { id: 'r7', sessao: 'rep-7', caiu_em, reconectada_em: null, qr_por: null },
        { id: 'r8', sessao: 'rep-8', caiu_em, reconectada_em: null, qr_por: null },
        { id: 'r9', sessao: 'rep-9', caiu_em, reconectada_em: new Date(), qr_por: null },
      );
      statusWaha = ['FAILED'];
      fetchMock.mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/qr?format=image')) return { ok: true, arrayBuffer: async () => Buffer.from('png') };
        if (url.endsWith('/logout') || url.endsWith('/restart')) return { ok: true, json: async () => ({}) };
        const status = statusWaha.length > 1 ? statusWaha.shift() : statusWaha[0];
        return { ok: true, json: async () => ({ name: 'rep-7', status }) };
      });
      svc = new ReconexaoService(prisma, sessoes, {} as any, repo as any);
    });

    it('pendentes traz só as do dono com reconexão em aberto; usuário desconhecido = vazio', async () => {
      expect(await svc.pendentes('id-37')).toEqual([{ sessao: 'rep-7', apelido: 'rep-7', telefone: '5565999998888', caiu_em }]);
      expect(await svc.pendentes('37')).toEqual([]);
    });

    it.each([
      ['de outro usuário', 'id-37', 'rep-8'],
      ['sem reconexão em aberto', 'id-37', 'rep-9'],
      ['usuário desconhecido', '37', 'rep-7'],
    ])('reconectar e qr de sessão %s = 404', async (_c, userId, sessao) => {
      await expect(svc.reconectar(userId, sessao)).rejects.toBeInstanceOf(NotFoundException);
      await expect(svc.qr(userId, sessao)).rejects.toBeInstanceOf(NotFoundException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['FAILED', 'STOPPED'])('reconectar em %s desloga, grava o aviso visto e o evento logout', async (status) => {
      statusWaha = [status, 'SCAN_QR_CODE'];
      expect(await svc.reconectar('id-37', 'rep-7')).toEqual({ status: 'SCAN_QR_CODE' });
      expect(chamadas('/logout')).toHaveLength(1);
      expect(chamadas('/restart')).toHaveLength(0);
      // Abrir o aviso não diz quem reconectou: qr_por só entra quando o QR é entregue.
      expect(reconexoes[0].qr_por).toBeNull();
      expect(reconexoes[0].modal_visto_em).toBeInstanceOf(Date);
      expect(doTipo('logout')).toEqual([expect.objectContaining({ sessao: 'rep-7', usuario: 'ALISSON' })]);
    });

    it('continua parada depois do logout → restart', async () => {
      statusWaha = ['FAILED', 'FAILED', 'STARTING'];
      expect(await svc.reconectar('id-37', 'rep-7')).toEqual({ status: 'STARTING' });
      expect(chamadas('/logout')).toHaveLength(1);
      expect(chamadas('/restart')).toHaveLength(1);
    });

    it.each(['WORKING', 'SCAN_QR_CODE', 'STARTING'])('reconectar em %s não mexe no WAHA, mas grava o aviso visto', async (status) => {
      statusWaha = [status];
      expect(await svc.reconectar('id-37', 'rep-7')).toEqual({ status });
      expect(chamadas('/logout')).toHaveLength(0);
      expect(chamadas('/restart')).toHaveLength(0);
      expect(doTipo('logout')).toHaveLength(0);
      expect(reconexoes[0].qr_por).toBeNull();
      expect(reconexoes[0].modal_visto_em).toBeInstanceOf(Date);
    });

    it('qr devolve imagem só em SCAN_QR_CODE, não lança 409 e grava quem viu o QR', async () => {
      statusWaha = ['WORKING'];
      expect(await svc.qr('id-37', 'rep-7')).toEqual({ status: 'WORKING' });
      expect(reconexoes[0].qr_por).toBeNull();
      statusWaha = ['SCAN_QR_CODE'];
      expect(await svc.qr('id-37', 'rep-7')).toEqual({
        status: 'SCAN_QR_CODE',
        imagem: `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
      });
      expect(reconexoes[0].qr_por).toBe('ALISSON');
    });

    it('QR pela tela depois do usuário limpa qr_por: a reconexão sai "pela tela"', async () => {
      const tela = { permissaoTela: jest.fn(async () => ({ id: 'adm', nome: 'LUCAS', sis_permissoes: [{ visualizar: true, editar: true }] })) };
      const daTela = new SessoesService(prisma, { emitir: jest.fn(), resolver: jest.fn() } as any, tela as any);
      statusWaha = ['SCAN_QR_CODE'];
      await svc.qr('id-37', 'rep-7');
      expect(reconexoes[0].qr_por).toBe('ALISSON');
      await daTela.qr('adm', 'rep-7');
      expect(reconexoes[0].qr_por).toBeNull();
    });
  });
});
