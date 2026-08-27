import { WhatsappService, chaveTelefone } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';
import { ErpApiService } from '../common/erp-api/erp-api.service';

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

  const repo = {
    resolverChave: jest.fn(async (chave: string) => vinculos.get(chave) ?? null),
    gravarMensagem: jest.fn(async (row: any) => {
      gravadas.push(row);
      return true;
    }),
    atualizarAck: jest.fn(async (s: string, id: string, ack: number) => {
      acks.push({ s, id, ack });
      return { count: 1 };
    }),
    semearContatos: jest.fn(async (rows: any[]) => ({ count: rows.length })),
    vincular: jest.fn(async (p: any) => ({ contato: p, mensagens_resolvidas: 2 })),
    pendentesVinculo: jest.fn(async () => []),
    contarContatos: jest.fn(async () => 0),
    medicoes: jest.fn(async () => ({ total: 0, casadas: 0, porSessao: [] })),
  } as unknown as WhatsappRepository;

  const erp = {
    consultar: jest.fn(async () => [
      { CLI_CODIGO: 1, CLI_NOME: 'CLIENTE A', FONE: '(65) 3333-4444', CELULAR: '65 9 8888-7777' },
      { CLI_CODIGO: 2, CLI_NOME: 'CLIENTE B', FONE: null, CELULAR: '66999996666' },
      { CLI_CODIGO: 3, CLI_NOME: 'SEM FONE', FONE: null, CELULAR: null },
    ]),
  } as unknown as ErpApiService;

  const service = new WhatsappService(repo, erp);

  beforeEach(() => {
    gravadas = [];
    acks = [];
    vinculos = new Map([['6588887777', 1]]);
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

  it('sessão fora da convenção rep-<codigo> registra sem vendedor', async () => {
    await service.processarWebhook({
      event: 'message',
      session: 'default',
      payload: { id: 'm4', from: '556588887777@c.us', fromMe: false },
    });
    expect(gravadas[0].rep_codigo).toBeNull();
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

  it('semente: celular vence o fixo e cliente sem telefone fica de fora', async () => {
    const r = await service.seedContatos();
    expect(r).toMatchObject({ clientes: 3, chaves: 3 }); // A: celular + fixo, B: celular
    const rows = (repo.semearContatos as jest.Mock).mock.calls[0][0];
    const chaves = rows.map((x: any) => x.chave).sort();
    expect(chaves).toEqual(['6533334444', '6588887777', '6699996666']);
  });

  it('vincular exige telefone e cliente', async () => {
    await expect(service.vincular({ telefone: '', cli_codigo: 1 } as any)).rejects.toThrow();
    const ok = await service.vincular({ telefone: '65 9 1111-2222', cli_codigo: 9 });
    expect(ok.mensagens_resolvidas).toBe(2);
    expect((repo.vincular as jest.Mock).mock.calls[0][0]).toMatchObject({ chave: '6511112222' });
  });
});
