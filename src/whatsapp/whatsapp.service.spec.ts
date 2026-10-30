import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { WhatsappService, chaveTelefone } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { S3Service } from '../storage/s3.service';
import { SessoesService } from './sessoes.service';

/** Cache de ven_wa_sessao (SessoesService) falso: tabela sessão → vendedor/guarda/status e a URL do WAHA. */
type LinhaSessao = { rep: number | null; corpo?: boolean; status?: string };
function sessoesFalsas(tabela: () => Record<string, LinhaSessao>, waha: () => string) {
  const nomes = () => Object.keys(tabela());
  return {
    repDaSessao: (s: string) => tabela()[s]?.rep ?? null,
    guardaCorpo: (s: string) => !!tabela()[s]?.corpo,
    ignorada: (s: string) => tabela()[s]?.rep == null && !tabela()[s]?.corpo,
    sessoesDoRep: (rep: number) => nomes().filter((s) => tabela()[s].rep === rep),
    sessoesComVendedor: () => nomes().filter((s) => tabela()[s].rep != null),
    sessoesComCorpo: () => nomes().filter((s) => tabela()[s].corpo),
    wahaDe: () => ({ url: waha(), key: 'chave' }),
  } as unknown as SessoesService;
}

describe('chaveTelefone', () => {
  it('normaliza para DDD + últimos 8 dígitos, sobrevivendo ao 9º dígito', () => {
    // o mesmo cliente nos três formatos reais: ERP fixo, ERP celular, WhatsApp E.164
    expect(chaveTelefone('(65) 9999-8888')).toBe('6599998888');
    expect(chaveTelefone('65 9 9999-8888')).toBe('6599998888');
    expect(chaveTelefone('5565999998888')).toBe('6599998888');
  });

  it('DDD 55 (RS) não é confundido com o código do país', () => {
    // 10 dígitos começando em 55 = número nacional com DDD 55, não E.164
    expect(chaveTelefone('5599998888')).toBe('5599998888');
    // 13 dígitos: 55 (país) + 55 (DDD) + 9 dígitos
    expect(chaveTelefone('5555999998888')).toBe('5599998888');
  });

  it('rejeita número sem DDD ou vazio (sem chave, sem casamento)', () => {
    expect(chaveTelefone('9999-8888')).toBeNull();
    expect(chaveTelefone('')).toBeNull();
    expect(chaveTelefone(null)).toBeNull();
  });
});

describe('WhatsappService', () => {
  let gravadas: any[];
  let acks: any[];
  let vinculos: Map<string, number>;
  let tabela: Record<string, LinhaSessao>;
  let wahaUrl: string;
  const sessoes = sessoesFalsas(() => tabela, () => wahaUrl);

  const repo = {
    resolverChave: jest.fn(async (chave: string) => vinculos.get(chave) ?? null),
    existe: jest.fn(async () => false),
    gravarMensagem: jest.fn(async (row: any) => {
      gravadas.push(row);
      return true;
    }),
    atualizarAck: jest.fn(async (s: string, id: string, ack: number) => {
      acks.push({ s, id, ack });
      return { count: 1 };
    }),
    semearContatos: jest.fn(async (rows: any[]) => ({ count: rows.length })),
    religarPendentes: jest.fn(async () => 2),
    vincular: jest.fn(async (p: any) => {
      vinculos.set(p.chave, p.cli_codigo);
      return { contato: p, mensagens_resolvidas: 2 };
    }),
    chavesIgnoradas: jest.fn(async () => new Set<string>()),
    preencherContatoNome: jest.fn(async () => ({ count: 1 })),
    upsertDivergencia: jest.fn(async () => undefined),
    pendentesVinculo: jest.fn(async () => []),
    contarContatos: jest.fn(async () => 0),
    medicoes: jest.fn(async () => ({ total: 0, casadas: 0, porSessao: [] })),
    contatoPorChave: jest.fn(async (chave: string) =>
      vinculos.has(chave) ? { chave, cli_codigo: vinculos.get(chave), origem: chave === '6588887777' ? 'SEED_ERP' : 'MANUAL' } : null,
    ),
    usuarioVendas: jest.fn(async (ref: string) =>
      ref === 'sup' ? { id: 'sup', vendas_hub_inicial: 'SUPERVISAO_ATACADO', vendas_rep_codigo: null }
        : ref === 'v316' ? { id: 'v316', vendas_hub_inicial: 'VENDEDOR', vendas_rep_codigo: 316 } : null,
    ),
    donoDaCarteira: jest.fn(async (cli: number) => (cli === 9 || cli === 40289 ? 316 : 163)),
    removerContato: jest.fn(async () => undefined),
  } as unknown as WhatsappRepository;

  const erp = {
    consultar: jest.fn(async () => [
      { CLI_CODIGO: 1, CLI_NOME: 'CLIENTE A', FONE: '(65) 3333-4444', CELULAR: '65 9 8888-7777' },
      { CLI_CODIGO: 2, CLI_NOME: 'CLIENTE B', FONE: null, CELULAR: '66999996666' },
      { CLI_CODIGO: 3, CLI_NOME: 'SEM FONE', FONE: null, CELULAR: null },
    ]),
  } as unknown as ErpApiService;

  const s3 = {
    putObject: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => Buffer.from('OggS-audio')),
  } as unknown as S3Service;

  const service = new WhatsappService(repo, erp, s3, sessoes);

  beforeEach(() => {
    gravadas = [];
    acks = [];
    vinculos = new Map([['6588887777', 1]]);
    tabela = {
      'rep-316': { rep: 316, status: 'WORKING' },
      'rep-163': { rep: 163, status: 'STOPPED' },
      'rep-999': { rep: 999, status: 'WORKING' },
      assistente: { rep: null, status: 'WORKING' },
    };
    wahaUrl = '';
    jest.clearAllMocks();
  });

  it('mensagem recebida: interlocutor é o "from", direção RECEBIDA, casa pela chave', async () => {
    const r = await service.processarWebhook({
      event: 'message',
      session: 'rep-316',
      payload: { id: 'm1', from: '556588887777@c.us', to: 'me@c.us', fromMe: false, timestamp: 1756300000, type: 'chat' },
    });
    expect(r).toMatchObject({ ok: true, gravada: true, casada: true });
    expect(gravadas[0]).toMatchObject({
      sessao: 'rep-316',
      rep_codigo: 316,
      direcao: 'RECEBIDA',
      chave: '6588887777',
      cli_codigo: 1,
    });
  });

  it('mensagem enviada (fromMe): interlocutor é o "to", direção ENVIADA', async () => {
    await service.processarWebhook({
      event: 'message.any',
      session: 'rep-316',
      payload: { id: 'm2', from: 'me@c.us', to: '556588887777@c.us', fromMe: true, timestamp: 1756300000 },
    });
    expect(gravadas[0]).toMatchObject({ direcao: 'ENVIADA', cli_codigo: 1 });
  });

  it('mensagem enviada no NOWEB: "to" vazio e "from" é o contato — ainda assim ENVIADA', async () => {
    const r = await service.processarWebhook({
      event: 'message.any',
      session: 'rep-316',
      payload: { id: 'true_556588887777@c.us_X', from: '556588887777@c.us', to: undefined, fromMe: true, timestamp: 1756300000, source: 'app' },
    });
    expect(r).toMatchObject({ ok: true, gravada: true });
    expect(gravadas[0]).toMatchObject({ direcao: 'ENVIADA', chave: '6588887777', cli_codigo: 1 });
  });

  it('grupo e broadcast ficam fora do sensor', async () => {
    const r1 = await service.processarWebhook({
      event: 'message',
      session: 'rep-316',
      payload: { id: 'g1', from: '123456-789@g.us', fromMe: false },
    });
    const r2 = await service.processarWebhook({
      event: 'message',
      session: 'rep-316',
      payload: { id: 'b1', from: 'status@broadcast', fromMe: false },
    });
    expect(r1).toMatchObject({ ignorado: 'grupo/broadcast' });
    expect(r2).toMatchObject({ ignorado: 'grupo/broadcast' });
    expect(gravadas).toHaveLength(0);
  });

  it('número desconhecido grava sem cliente (fila de vínculo)', async () => {
    const r = await service.processarWebhook({
      event: 'message',
      session: 'rep-316',
      payload: { id: 'm3', from: '556511112222@c.us', fromMe: false },
    });
    expect(r).toMatchObject({ casada: false });
    expect(gravadas[0].cli_codigo).toBeNull();
  });

  it('sessão sem vendedor e sem guarda_corpo é ignorada', async () => {
    const r = await service.processarWebhook({
      event: 'message',
      session: 'assistente',
      payload: { id: 'a1', from: '556588887777@c.us', fromMe: false },
    });
    expect(r).toMatchObject({ ignorado: 'sessão fora do sensor' });
    expect(gravadas).toHaveLength(0);
  });

  it('sessão com vendedor na tabela grava rep_codigo mesmo sem nome rep-', async () => {
    tabela['wa-joao'] = { rep: 316 };
    await service.processarWebhook({
      event: 'message',
      session: 'wa-joao',
      payload: { id: 'm4', from: '556588887777@c.us', fromMe: false },
    });
    expect(gravadas[0]).toMatchObject({ sessao: 'wa-joao', rep_codigo: 316 });
  });

  it('contato atrás de LID: resolve o número real no WAHA e casa normalmente', async () => {
    wahaUrl = 'http://waha.local';
    const fetchMock: jest.Mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lid: '25099822457032@lid', pn: '556588887777@c.us' }),
    });
    (global as any).fetch = fetchMock;
    try {
      await service.processarWebhook({
        event: 'message',
        session: 'rep-999',
        payload: { id: 'l1', from: '25099822457032@lid', fromMe: false, timestamp: 1756300000 },
      });
      // segunda mensagem do mesmo LID sai do cache — uma chamada só ao WAHA
      await service.processarWebhook({
        event: 'message',
        session: 'rep-999',
        payload: { id: 'l2', from: '25099822457032@lid', fromMe: false, timestamp: 1756300001 },
      });
      expect(gravadas[0]).toMatchObject({ chave: '6588887777', cli_codigo: 1 });
      expect(gravadas[1]).toMatchObject({ chave: '6588887777', cli_codigo: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        'http://waha.local/api/rep-999/lids/25099822457032',
      );
    } finally {
      delete (global as any).fetch;
    }
  });

  it('LID sem resolução (WAHA fora ou pn nulo) grava com os dígitos do LID como chave', async () => {
    wahaUrl = 'http://waha.local';
    (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ pn: null }) }));
    try {
      const r = await service.processarWebhook({
        event: 'message',
        session: 'rep-999',
        payload: { id: 'l3', from: '91753520574651@lid', fromMe: false },
      });
      expect(r).toMatchObject({ casada: false });
      expect(gravadas[0]).toMatchObject({ chave: '91753520574651', cli_codigo: null });
    } finally {
      delete (global as any).fetch;
    }
  });

  describe('payload NOWEB (sem type, sem _data.size)', () => {
    const imagem = {
      id: 'true_556588887777@c.us_NW1',
      from: '556588887777@c.us',
      to: 'me@c.us',
      fromMe: false,
      timestamp: 1756300000,
      body: 'foto do vidro',
      hasMedia: true,
      media: { url: 'http://localhost:3000/api/files/NW1.jpeg', mimetype: 'image/jpeg' },
      _data: { key: {}, message: {} },
    };
    const baixa = (headers: Record<string, string> = {}) =>
      jest.fn(async () => ({
        ok: true,
        headers: new Headers(headers),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }));

    beforeEach(() => {
      tabela['rep-316'].corpo = true;
      wahaUrl = 'http://waha.local:3000';
    });
    afterEach(() => {
      delete (global as any).fetch;
    });

    it('mídia: tipo sai do mimetype, legenda vem do body, mídia é guardada', async () => {
      (global as any).fetch = baixa({ 'content-length': '3' });
      const r = await service.processarWebhook({ event: 'message', session: 'rep-316', payload: { ...imagem } });
      expect(r).toMatchObject({ gravada: true, midia: true });
      expect(s3.putObject).toHaveBeenCalledTimes(1);
      expect(gravadas[0]).toMatchObject({
        tipo: 'image',
        corpo: 'foto do vidro',
        midia_chave: 'rep-316/2025/08/true_556588887777_c.us_NW1.jpg',
        midia_mime: 'image/jpeg',
      });
    });

    it('texto sem mídia: tipo chat', async () => {
      await service.processarWebhook({
        event: 'message',
        session: 'rep-316',
        payload: { id: 'nw2', from: '556588887777@c.us', fromMe: false, body: 'bom dia', _data: {} },
      });
      expect(gravadas[0]).toMatchObject({ tipo: 'chat', corpo: 'bom dia', midia_chave: null });
    });

    it('content-length acima de 20 MB: não guarda a mídia, mas grava a mensagem', async () => {
      (global as any).fetch = baixa({ 'content-length': String(21 * 1024 * 1024) });
      const r = await service.processarWebhook({ event: 'message', session: 'rep-316', payload: { ...imagem } });
      expect(r).toMatchObject({ gravada: true, midia: false });
      expect(s3.putObject).not.toHaveBeenCalled();
      expect(gravadas[0]).toMatchObject({ tipo: 'image', corpo: 'foto do vidro', midia_chave: null });
    });
  });

  it('message.ack atualiza o status sem criar linha', async () => {
    await service.processarWebhook({
      event: 'message.ack',
      session: 'rep-316',
      payload: { id: 'm1', ack: 3 },
    });
    expect(acks).toEqual([{ s: 'rep-316', id: 'm1', ack: 3 }]);
    expect(gravadas).toHaveLength(0);
  });

  it('semente: celular vence o fixo, cliente sem telefone fica de fora e pendentes são religadas', async () => {
    const r = await service.seedContatos();
    // A: celular + fixo, B: celular; e o histórico pendente adota as chaves novas
    expect(r).toMatchObject({ clientes: 3, chaves: 3, mensagens_religadas: 2 });
    const rows = (repo.semearContatos as jest.Mock).mock.calls[0][0];
    const chaves = rows.map((x: any) => x.chave).sort();
    expect(chaves).toEqual(['6533334444', '6588887777', '6699996666']);
  });

  it('vincular exige telefone e cliente', async () => {
    await expect(service.vincular({ telefone: '', cli_codigo: 1 } as any)).rejects.toThrow();
    const ok = await service.vincular({ telefone: '65 9 1111-2222', cli_codigo: 9, usuario_id: 'v316', contato_nome: ' João ' });
    expect(ok.mensagens_resolvidas).toBe(2);
    expect((repo.vincular as jest.Mock).mock.calls[0][0]).toMatchObject({ chave: '6511112222', contato_nome: 'João' });
  });

  it('vendedor: número novo só na própria carteira; número já vinculado é da gestão (403)', async () => {
    await expect(service.vincular({ telefone: '65 9 1111-2222', cli_codigo: 5, usuario_id: 'v316' })).rejects.toThrow(ForbiddenException);
    await expect(service.vincular({ telefone: '65 9 8888-7777', cli_codigo: 9, usuario_id: 'v316' })).rejects.toThrow(ForbiddenException);
    await expect(service.vincular({ telefone: '65 9 8888-7777', cli_codigo: 9 })).rejects.toThrow(ForbiddenException);
    await service.vincular({ telefone: '65 9 8888-7777', cli_codigo: 9, usuario_id: 'sup' });
    expect(repo.vincular).toHaveBeenCalledTimes(1);
  });

  describe('vínculo pela agenda', () => {
    // serviço novo por caso: o cache de 10 min dos clientes do atacado não vaza entre testes
    let svc: WhatsappService;
    const atacado = [{ CLI_CODIGO: 40289, CLI_NOME: 'AUTO VIDROS' }];

    beforeEach(() => {
      svc = new WhatsappService(repo, erp, s3, sessoes);
      wahaUrl = 'http://waha.local';
      (erp.consultar as jest.Mock).mockResolvedValueOnce(atacado);
    });
    afterEach(() => {
      delete (global as any).fetch;
    });

    it('webhook: número sem vínculo com código no nome da agenda vincula e grava a mensagem já casada', async () => {
      (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: '40289 João' }) }));
      const r = await svc.processarWebhook({
        event: 'message',
        session: 'rep-316',
        payload: { id: 'ag1', from: '556511112222@c.us', fromMe: false },
      });
      expect(repo.vincular).toHaveBeenCalledWith(
        expect.objectContaining({ chave: '6511112222', cli_codigo: 40289, contato_nome: 'João', origem: 'AGENDA', criado_por: 'agenda:rep-316' }),
      );
      expect(r).toMatchObject({ casada: true });
      expect(gravadas[0]).toMatchObject({ chave: '6511112222', cli_codigo: 40289 });
    });

    it('webhook: nome do perfil (pushname) não vincula; cliente de outra carteira também não', async () => {
      (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ pushname: 'Loja 40289' }) }));
      await svc.processarWebhook({ event: 'message', session: 'rep-316', payload: { id: 'ag2', from: '556511112222@c.us' } });
      (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: '40289 João' }) }));
      await svc.processarWebhook({ event: 'message', session: 'rep-163', payload: { id: 'ag3', from: '556522223333@c.us' } });
      expect(repo.vincular).not.toHaveBeenCalled();
      expect(gravadas).toHaveLength(2);
    });

    it('webhook: ERP fora não perde a mensagem', async () => {
      await (erp.consultar as jest.Mock)(); // consome a lista do beforeEach
      const fora = { consultar: jest.fn(async () => Promise.reject(new Error('erp fora'))) } as unknown as ErpApiService;
      (global as any).fetch = jest.fn(async () => ({ ok: true, json: async () => ({ name: '40289 João' }) }));
      const r = await new WhatsappService(repo, fora, s3, sessoes).processarWebhook({ event: 'message', session: 'rep-316', payload: { id: 'ag4', from: '556511112222@c.us' } });
      expect(r).toMatchObject({ casada: false });
      expect(gravadas).toHaveLength(1);
    });

    it('varredura: sessões com vendedor; a que o WAHA recusa não para as outras; chave nova vincula; chave de outro cliente vira divergência', async () => {
      delete tabela['rep-999'];
      const fetchMock = jest.fn(async (url: string) => ({
        ok: !url.includes('rep-163'),
        status: 422,
        json: async () => [
          { id: '556588887777@c.us', name: '40289 Maria' },
          { id: '556511112222@c.us', name: '40289 João' },
          { id: '556500001111@c.us', name: 'Fulano' },
        ],
      }));
      (global as any).fetch = fetchMock;
      const r = await svc.varrerAgendas();
      expect(r).toEqual({ sessoes: 1, contatos_lidos: 3, vinculados: 1, divergencias: 1 });
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
        'http://waha.local/api/contacts/all?session=rep-316',
        'http://waha.local/api/contacts/all?session=rep-163',
      ]);
      expect(repo.upsertDivergencia).toHaveBeenCalledWith({
        chave: '6588887777',
        sessao: 'rep-316',
        nome_agenda: '40289 Maria',
        cli_agenda: 40289,
        cli_vinculado: 1,
      });
      expect(repo.vincular).toHaveBeenCalledTimes(1);
      expect((repo.vincular as jest.Mock).mock.calls[0][0]).toMatchObject({ chave: '6511112222' });
      expect(vinculos.get('6588887777')).toBe(1);
    });
  });

  it('remover: vendedor 403; número do ERP 400; manual apaga', async () => {
    vinculos.set('6511112222', 9);
    await expect(service.removerContato('6511112222', 'v316')).rejects.toThrow(ForbiddenException);
    await expect(service.removerContato('6588887777', 'sup')).rejects.toThrow(BadRequestException);
    await expect(service.removerContato('6511112222', 'sup')).resolves.toEqual({ ok: true });
    expect(repo.removerContato).toHaveBeenCalledWith('6511112222');
  });
});
