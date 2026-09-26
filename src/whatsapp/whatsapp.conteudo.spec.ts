import { HistoricoEstado, WhatsappService } from './whatsapp.service';
import { WhatsappRepository } from './whatsapp.repository';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import { S3Service } from '../storage/s3.service';

/**
 * Conteúdo das conversas (corpo, mídia no MinIO, áudio em texto, histórico).
 * Mesma costura do spec do sensor: entra pelo serviço, olha o que ele mandou
 * gravar. Repositório, MinIO, WAHA e transcritor são falsos (fetch mockado).
 */
describe('WhatsappService — conteúdo', () => {
  let gravadas: any[];
  let transcricoes: any[];
  let falhas: any[];
  let pendentes: any[];
  let vinculos: Map<string, number>;

  const repo = {
    resolverChave: jest.fn(async (chave: string) => vinculos.get(chave) ?? null),
    gravarMensagem: jest.fn(async (row: any) => {
      gravadas.push(row);
      return true;
    }),
    atualizarAck: jest.fn(async () => ({ count: 1 })),
    proximoAudioPendente: jest.fn(async () => pendentes.shift() ?? null),
    gravarTranscricao: jest.fn(async (id: string, texto: string) => transcricoes.push({ id, texto })),
    falharTranscricao: jest.fn(async (id: string, n: number) => falhas.push({ id, n })),
    contarContatos: jest.fn(async () => 0),
    pendentesVinculo: jest.fn(async () => []),
    medicoes: jest.fn(async () => ({
      total: 3,
      casadas: 2,
      porSessao: [],
      comCorpo: 2,
      comMidia: 1,
      audios: [{ transcricao_status: 'PENDENTE', _count: { _all: 1 } }],
    })),
  } as unknown as WhatsappRepository;
  const erp = { consultar: jest.fn(async () => []) } as unknown as ErpApiService;
  const s3 = {
    putObject: jest.fn(async () => undefined),
    getObjectBuffer: jest.fn(async () => Buffer.from('OggS-audio')),
  } as unknown as S3Service;
  const service = new WhatsappService(repo, erp, s3);

  const audioPayload = {
    id: 'true_556588887777@c.us_AAA',
    from: '556588887777@c.us',
    to: 'me@c.us',
    fromMe: false,
    timestamp: 1756300000, // 2025-08-27
    type: 'ptt',
    body: '',
    hasMedia: true,
    media: { url: 'http://localhost:3000/api/files/AAA.oga', mimetype: 'audio/ogg; codecs=opus', filename: null },
    _data: { size: 12345 },
  };

  beforeEach(() => {
    gravadas = [];
    transcricoes = [];
    falhas = [];
    pendentes = [];
    vinculos = new Map([['6588887777', 1]]);
    process.env.WA_CORPO_SESSOES = 'rep-163, rep-200';
    process.env.WA_API_URL = 'http://waha.local:3000';
    delete process.env.WA_TRANSCRICAO_URL;
    delete process.env.WA_TRANSCRICAO_TOKEN;
    delete process.env.WA_TRANSCRICAO_SO_RECEBIDAS;
    jest.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.WA_CORPO_SESSOES;
    delete process.env.WA_API_URL;
    delete (global as any).fetch;
  });

  it('sessão liberada grava corpo e mídia; áudio entra PENDENTE; URL do WAHA é reescrita', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }));
    (global as any).fetch = fetchMock;
    const r = await service.processarWebhook({
      event: 'message.any',
      session: 'rep-163',
      payload: { ...audioPayload },
    });
    expect(r).toMatchObject({ gravada: true, casada: true, midia: true });
    expect(String((fetchMock as jest.Mock).mock.calls[0][0])).toBe('http://waha.local:3000/api/files/AAA.oga');
    const put = (s3.putObject as jest.Mock).mock.calls[0];
    expect(put[0]).toBe('rep-163/2025/08/true_556588887777_c.us_AAA.ogg');
    expect(put[2]).toBe('audio/ogg');
    expect(put[3]).toBe('whatsapp-atacado');
    expect(gravadas[0]).toMatchObject({
      corpo: null,
      midia_chave: 'rep-163/2025/08/true_556588887777_c.us_AAA.ogg',
      midia_mime: 'audio/ogg; codecs=opus',
      transcricao_status: 'PENDENTE',
      cli_codigo: 1,
    });
  });

  it('texto: corpo gravado, sem mídia, sem transcrição', async () => {
    await service.processarWebhook({
      event: 'message',
      session: 'rep-200',
      payload: {
        id: 't1',
        from: '556588887777@c.us',
        fromMe: false,
        type: 'chat',
        body: 'tem o vidro do gol g5?',
      },
    });
    expect(gravadas[0]).toMatchObject({
      corpo: 'tem o vidro do gol g5?',
      midia_chave: null,
      transcricao_status: null,
    });
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('sessão fora de WA_CORPO_SESSOES continua só com metadados (nem baixa a mídia)', async () => {
    (global as any).fetch = jest.fn();
    await service.processarWebhook({
      event: 'message',
      session: 'rep-349',
      payload: { ...audioPayload, body: 'oi' },
    });
    expect(gravadas[0].corpo).toBeUndefined();
    expect(gravadas[0].midia_chave).toBeUndefined();
    expect((global as any).fetch).not.toHaveBeenCalled();
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('vídeo e mídia acima de 20 MB não são baixados; a mensagem grava mesmo assim', async () => {
    (global as any).fetch = jest.fn();
    await service.processarWebhook({
      event: 'message',
      session: 'rep-163',
      payload: {
        ...audioPayload,
        id: 'v1',
        type: 'video',
        media: { url: 'http://localhost:3000/x.mp4', mimetype: 'video/mp4' },
      },
    });
    await service.processarWebhook({
      event: 'message',
      session: 'rep-163',
      payload: {
        ...audioPayload,
        id: 'g1',
        type: 'image',
        media: { url: 'http://localhost:3000/x.jpg', mimetype: 'image/jpeg' },
        _data: { size: 25 * 1024 * 1024 },
      },
    });
    expect(gravadas).toHaveLength(2);
    expect(gravadas.map((g) => g.midia_chave)).toEqual([null, null]);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('download da mídia falha (WAHA fora): mensagem grava sem mídia', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await service.processarWebhook({
      event: 'message',
      session: 'rep-163',
      payload: { ...audioPayload, body: 'legenda' },
    });
    expect(r).toMatchObject({ gravada: true, midia: false });
    expect(gravadas[0]).toMatchObject({ corpo: 'legenda', midia_chave: null, transcricao_status: null });
  });

  it('processador: manda o áudio por multipart com Bearer e grava o texto', async () => {
    process.env.WA_TRANSCRICAO_URL = 'http://146.local:9200/transcrever';
    process.env.WA_TRANSCRICAO_TOKEN = 'tok';
    pendentes = [
      { id: 'a1', midia_chave: 'rep-163/2025/08/x.ogg', midia_mime: 'audio/ogg', transcricao_tentativas: 0 },
    ];
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ texto: 'quero dois para-brisas' }),
    }));
    (global as any).fetch = fetchMock;
    const r = await service.processarAudiosPendentes();
    expect(r).toMatchObject({ processados: 1, ok: 1, falhas: 0 });
    expect(transcricoes).toEqual([{ id: 'a1', texto: 'quero dois para-brisas' }]);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('http://146.local:9200/transcrever');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.body).toBeInstanceOf(FormData);
    expect((s3.getObjectBuffer as jest.Mock).mock.calls[0]).toEqual([
      'rep-163/2025/08/x.ogg',
      'whatsapp-atacado',
    ]);
  });

  it('processador: resposta 4xx conta tentativa; 5xx/rede para o tick sem contar', async () => {
    process.env.WA_TRANSCRICAO_URL = 'http://146.local:9200/transcrever';
    pendentes = [
      { id: 'a1', midia_chave: 'k1', midia_mime: 'audio/ogg', transcricao_tentativas: 2 },
      { id: 'a2', midia_chave: 'k2', midia_mime: 'audio/ogg', transcricao_tentativas: 0 },
    ];
    (global as any).fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const r = await service.processarAudiosPendentes();
    expect(falhas).toEqual([{ id: 'a1', n: 2 }]);
    expect(r).toMatchObject({ processados: 2, ok: 0, falhas: 1, parado: 'HTTP 503' });
    expect(pendentes).toHaveLength(0); // a2 foi lida, mas não contou tentativa
  });

  it('processador: sem WA_TRANSCRICAO_URL não faz nada', async () => {
    expect(await service.processarAudiosPendentes()).toBeNull();
    expect(repo.proximoAudioPendente).not.toHaveBeenCalled();
  });

  it('histórico: varre os chats individuais, filtra pela data, ignora grupo e grava pelo mesmo caminho', async () => {
    const desde = new Date('2026-09-01T00:00:00-04:00');
    const epoch = Math.floor(desde.getTime() / 1000);
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url.includes('/chats?')) {
        return {
          ok: true,
          json: async () =>
            url.includes('offset=0') ? [{ id: { _serialized: '556588887777@c.us' } }, { id: '1203@g.us' }] : [],
        };
      }
      if (url.includes('/messages')) {
        expect(url).toContain(`filter.timestamp.gte=${epoch}`);
        expect(url).toContain('downloadMedia=true');
        return {
          ok: true,
          json: async () => [
            { id: 'h1', timestamp: epoch + 100, fromMe: true, to: '556588887777@c.us', body: 'segue orçamento', type: 'chat' },
            { id: 'h2', timestamp: epoch - 100, fromMe: false, from: '556588887777@c.us', body: 'antiga', type: 'chat' },
          ],
        };
      }
      throw new Error('url inesperada ' + url);
    });
    // importarHistorico() dispara este laço em segundo plano; aqui ele é
    // esperado diretamente para o teste ver o resultado.
    const estado: HistoricoEstado = {
      sessao: 'rep-163',
      desde: desde.toISOString(),
      iniciado_em: new Date().toISOString(),
      terminado_em: null,
      chats: 0,
      lidas: 0,
      gravadas: 0,
      midias: 0,
      erro: null,
    };
    await service.executarHistorico(estado, desde);
    expect(estado).toMatchObject({ chats: 1, lidas: 1, gravadas: 1, erro: null });
    expect(estado.terminado_em).not.toBeNull();
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0]).toMatchObject({
      message_id: 'h1',
      direcao: 'ENVIADA',
      corpo: 'segue orçamento',
      cli_codigo: 1,
    });
  });

  it('histórico recusa sessão fora da lista e em andamento', () => {
    expect(() => service.importarHistorico('rep-349')).toThrow(/WA_CORPO_SESSOES/);
    (global as any).fetch = jest.fn(() => new Promise(() => undefined)); // nunca responde
    service.importarHistorico('rep-200');
    expect(() => service.importarHistorico('rep-200')).toThrow(/em andamento/);
  });

  it('medições trazem o bloco de conteúdo', async () => {
    const m = await service.medicoes();
    expect(m.conteudo).toEqual({
      sessoes_liberadas: ['rep-163', 'rep-200'],
      com_corpo: 2,
      com_midia: 1,
      audios: { PENDENTE: 1, OK: 0, ERRO: 0 },
    });
  });
});
