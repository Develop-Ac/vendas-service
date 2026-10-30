import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { SessoesService } from './sessoes.service';
import { hojeCuiabaYmd } from '../orcamento/orcamento.prisma.repository';

describe('SessoesService (monitor do WAHA)', () => {
  let rows: Map<string, any>;
  let eventos: any[];
  let lista: any[] | Error;
  let svc: SessoesService;

  const linha = (sessao: string, extra: any = {}) => ({
    sessao,
    instancia: 'local',
    apelido: sessao,
    rep_codigo: null,
    rep_nome: null,
    guarda_corpo: false,
    status: 'WORKING',
    status_desde: new Date('2026-10-30T12:00:00Z'),
    telefone: null,
    push_name: null,
    visto_em: null,
    leituras_fora: 0,
    avisada: false,
    restart_em: null,
    ...extra,
  });

  const prisma = {
    ven_wa_sessao: {
      findMany: jest.fn(async () => [...rows.values()].map((r) => ({ ...r }))),
      create: jest.fn(async ({ data }: any) => {
        const r = linha(data.sessao, { ...data, status: null, status_desde: null });
        rows.set(r.sessao, r);
        return { ...r };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        if (rows.has(where.sessao)) return Object.assign(rows.get(where.sessao), update);
        const r = linha(create.sessao, { ...create, status: null, status_desde: null });
        rows.set(r.sessao, r);
        return { ...r };
      }),
      findUnique: jest.fn(async ({ where }: any) => (rows.has(where.sessao) ? { ...rows.get(where.sessao) } : null)),
      update: jest.fn(async ({ where, data }: any) => Object.assign(rows.get(where.sessao), data)),
    },
    ven_wa_sessao_evento: {
      createMany: jest.fn(async ({ data }: any) => {
        eventos.push(...data);
        return { count: data.length };
      }),
      create: jest.fn(async ({ data }: any) => {
        eventos.push(data);
        return data;
      }),
    },
    ven_wa_mensagem: { updateMany: jest.fn(async () => ({ count: 12 })) },
    ven_fila_tarefa: { updateMany: jest.fn(async () => ({ count: 3 })) },
    ven_resgate: { updateMany: jest.fn(async () => ({ count: 2 })) },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg))),
  };
  const avisos = { emitir: jest.fn(), resolver: jest.fn() };
  let permissao: { visualizar: boolean; editar: boolean } | null;
  const repo = {
    permissaoTela: jest.fn(async () => ({ id: 'u1', nome: 'LUCAS', sis_permissoes: permissao ? [permissao] : [] })),
  };
  const fetchMock = jest.fn();

  const waha = (status: string, name = 'rep-7', me: any = { id: '5565999998888@c.us', pushName: 'Fulano' }) => {
    lista = [{ name, status, me }];
  };
  const restarts = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/restart')).length;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.WA_INSTANCIAS;
    process.env.WA_API_URL = 'http://waha:3000/';
    process.env.WA_API_KEY = 'k';
    rows = new Map([['rep-7', linha('rep-7', { rep_codigo: 7, rep_nome: 'JOAO' })]]);
    eventos = [];
    lista = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/restart')) return { ok: true, json: async () => ({}) };
      if (lista instanceof Error) throw lista;
      return { ok: true, json: async () => lista };
    });
    (global as any).fetch = fetchMock;
    permissao = { visualizar: true, editar: true };
    svc = new SessoesService(prisma as any, avisos as any, repo as any);
  });

  describe('ações da tela', () => {
    const amanha = () => new Date(Date.parse(hojeCuiabaYmd() + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10);

    it('troca de vendedor com data futura → 400', async () => {
      await expect(svc.trocarVendedor('u1', 'rep-7', { rep_codigo: 9, desde: amanha() })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('troca para o mesmo vendedor → 400', async () => {
      await expect(svc.trocarVendedor('u1', 'rep-7', { rep_codigo: 7 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('troca com transferir_tarefas move mensagens, tarefas e resgates e devolve as contagens', async () => {
      const r = await svc.trocarVendedor('u1', 'rep-7', { rep_codigo: 9, rep_nome: 'MARIA', desde: '2026-10-01', transferir_tarefas: true });
      expect(r).toEqual({ mensagens: 12, tarefas: 3, resgates: 2 });
      expect(prisma.ven_wa_mensagem.updateMany).toHaveBeenCalledWith({
        where: { sessao: 'rep-7', timestamp: { gte: new Date('2026-10-01T04:00:00Z') } },
        data: { rep_codigo: 9 },
      });
      expect(prisma.ven_fila_tarefa.updateMany).toHaveBeenCalledWith({
        where: { rep_codigo: 7, status: { in: ['ABERTA', 'ESCALADA'] } },
        data: expect.objectContaining({ rep_codigo: 9, rep_nome: 'MARIA' }),
      });
      expect(prisma.ven_resgate.updateMany).toHaveBeenCalledWith({
        where: { rep_codigo: 7, estagio: { notIn: ['RECUPERADO', 'PERDIDO'] } },
        data: expect.objectContaining({ rep_codigo: 9, rep_nome: 'MARIA' }),
      });
      expect(rows.get('rep-7')).toMatchObject({ rep_codigo: 9, rep_nome: 'MARIA' });
      expect(eventos).toContainEqual(
        expect.objectContaining({ tipo: 'vendedor', de: '7', para: '9', detalhe: '2026-10-01', usuario: 'LUCAS' }),
      );
    });

    it('sem editar → 403 em reiniciar, sem chamar o WAHA', async () => {
      permissao = { visualizar: true, editar: false };
      await expect(svc.acao('u1', 'rep-7', 'restart')).rejects.toBeInstanceOf(ForbiddenException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ligar guarda_corpo grava evento com quem mudou; só apelido não grava', async () => {
      await svc.editar('u1', 'rep-7', { guarda_corpo: true });
      expect(eventos).toEqual([expect.objectContaining({ tipo: 'guarda_corpo', de: 'false', para: 'true', usuario: 'LUCAS' })]);
      await svc.editar('u1', 'rep-7', { apelido: 'Joao' });
      expect(eventos).toHaveLength(1);
    });

    it('criar depois de o monitor inserir a mesma sessão grava o vendedor da tela', async () => {
      process.env.WA_WEBHOOK_URL = 'http://vendas/whatsapp/webhook';
      prisma.ven_wa_sessao.findUnique.mockResolvedValueOnce(null);
      rows.set('wa-loja', linha('wa-loja'));
      const r = await svc.criar('u1', { apelido: 'Loja', rep_codigo: 9, rep_nome: 'MARIA' });
      expect(r).toMatchObject({ sessao: 'wa-loja', rep_codigo: 9, guarda_corpo: true });
      const corpo = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(corpo.config.webhooks[0].events).toEqual(['message.any', 'message.ack']);
    });

    it('QR com a sessão fora de SCAN_QR_CODE → 409', async () => {
      fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ name: 'rep-7', status: 'WORKING' }) }));
      await expect(svc.qr('u1', 'rep-7')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('instância local vem de WA_API_URL/WA_API_KEY, sem barra final', () => {
    expect(svc.instancias()).toEqual([{ id: 'local', nome: 'WAHA local', url: 'http://waha:3000', key: 'k' }]);
    expect(svc.wahaDe('qualquer')).toEqual({ url: 'http://waha:3000', key: 'k' });
  });

  it('WORKING → FAILED grava evento status de→para', async () => {
    waha('FAILED');
    await svc.tick();
    expect(eventos).toContainEqual(expect.objectContaining({ sessao: 'rep-7', tipo: 'status', de: 'WORKING', para: 'FAILED' }));
    expect(rows.get('rep-7').status).toBe('FAILED');
    expect(rows.get('rep-7').telefone).toBe('5565999998888');
    expect(rows.get('rep-7').apelido).toBe('Fulano');
  });

  it('FAILED chama /restart no 1º tick e não no 2º', async () => {
    waha('FAILED');
    await svc.tick();
    expect(restarts()).toBe(1);
    expect(eventos).toContainEqual(expect.objectContaining({ tipo: 'restart', usuario: 'monitor' }));
    await svc.tick();
    expect(restarts()).toBe(1);
  });

  it('SCAN_QR_CODE não reinicia', async () => {
    waha('SCAN_QR_CODE', 'rep-7', null);
    await svc.tick();
    expect(restarts()).toBe(0);
  });

  it('2 leituras fora avisam 1x, a 3ª não repete, WORKING resolve e zera', async () => {
    waha('SCAN_QR_CODE', 'rep-7', null);
    await svc.tick();
    expect(avisos.emitir).not.toHaveBeenCalled();
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
    expect(avisos.emitir).toHaveBeenCalledWith(
      'whatsapp.sessao_caiu',
      expect.objectContaining({ ref: 'rep-7', vars: expect.objectContaining({ vendedor: 'JOAO', status: 'SCAN_QR_CODE', instancia: 'WAHA local' }) }),
    );
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
    waha('WORKING');
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledWith('whatsapp.sessao_caiu', 'rep-7');
    expect(rows.get('rep-7')).toMatchObject({ leituras_fora: 0, avisada: false, restart_em: null });
  });

  it('instância sem resposta 2x emite instancia_fora 1x e nenhum sessao_caiu; voltou resolve', async () => {
    lista = new Error('timeout');
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
    expect(avisos.emitir).toHaveBeenCalledWith('whatsapp.instancia_fora', expect.objectContaining({ ref: 'local' }));
    expect(prisma.ven_wa_sessao.update).not.toHaveBeenCalled();
    waha('WORKING');
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledWith('whatsapp.instancia_fora', 'local');
  });

  it('1ª leitura depois do boot resolve aviso de instância que ficou de antes do restart', async () => {
    waha('WORKING');
    await svc.tick();
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledTimes(1);
    expect(avisos.resolver).toHaveBeenCalledWith('whatsapp.instancia_fora', 'local');
  });

  it('WA_INSTANCIAS inválida não vai ao log com a chave', () => {
    process.env.WA_INSTANCIAS = '[{"id":"x","key":"SEGREDO123abc"},]';
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const s = new SessoesService(prisma as any, avisos as any, repo as any);
    expect(s.instancias()).toEqual([{ id: 'local', nome: 'WAHA local', url: 'http://waha:3000', key: 'k' }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).not.toContain('SEGREDO');
    log.mockRestore();
  });

  it('sessão desconhecida vira create; sessão do banco fora da lista vira AUSENTE', async () => {
    waha('WORKING', 'wa-nova');
    await svc.tick();
    expect(prisma.ven_wa_sessao.upsert).toHaveBeenCalledWith({
      where: { sessao: 'wa-nova' },
      create: { sessao: 'wa-nova', instancia: 'local', apelido: 'wa-nova', guarda_corpo: false },
      update: {},
    });
    expect(rows.get('wa-nova')).toMatchObject({ status: 'WORKING', apelido: 'Fulano' });
    expect(rows.get('rep-7').status).toBe('AUSENTE');
  });

  it('repDaSessao lê do cache, não do nome', async () => {
    rows = new Map([
      ['aux', linha('aux', { rep_codigo: 42, status: 'FAILED' })],
      ['qualquer', linha('qualquer', { rep_codigo: 42 })],
      ['rep-9', linha('rep-9')],
      ['corpo', linha('corpo', { guarda_corpo: true })],
    ]);
    await svc.onModuleInit();
    expect(svc.repDaSessao('qualquer')).toBe(42);
    expect(svc.repDaSessao('rep-9')).toBeNull();
    expect(svc.ignorada('rep-9')).toBe(true);
    expect(svc.ignorada('corpo')).toBe(false);
    expect(svc.guardaCorpo('corpo')).toBe(true);
    expect(svc.sessoesDoRep(42)).toEqual(['aux', 'qualquer']);
    expect(svc.sessoesComVendedor()).toEqual(['aux', 'qualquer']);
  });

  it('sessão fora da tabela (semente não aplicada / cache vazio) cai no padrão rep-<código>', () => {
    expect(svc.repDaSessao('rep-163')).toBe(163);
    expect(svc.guardaCorpo('rep-163')).toBe(true);
    expect(svc.ignorada('rep-163')).toBe(false);
    expect(svc.ignorada('assistente')).toBe(true);
  });
});
