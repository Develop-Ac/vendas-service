import { BadGatewayException, ForbiddenException, Logger } from '@nestjs/common';
import { AssistenteService, SaudeAssistente } from './assistente.service';

describe('AssistenteService (monitor do runner)', () => {
  let avisos: { emitir: jest.Mock; resolver: jest.Mock };
  let resposta: Partial<SaudeAssistente> | Error;
  let svc: AssistenteService;
  let sessoes: { exigirTela: jest.Mock };
  const env = { ...process.env };

  const saude = (extra: Partial<SaudeAssistente> = {}): Partial<SaudeAssistente> => ({
    estado: 'ok',
    claude: { estado: 'ok', motivo: null, desde: null, detalhe: null, ultimo_teste: '2026-11-23T08:01:00-04:00' },
    subiu_em: '2026-11-23T08:00:00-04:00',
    pendentes: { quantidade: 0, mais_antiga: null },
    eventos: [],
    ...extra,
  });
  const login = (): Partial<SaudeAssistente> =>
    saude({
      estado: 'claude_indisponivel',
      claude: { estado: 'indisponivel', motivo: 'login', desde: '2026-11-23T10:00:00-04:00', detalhe: null, ultimo_teste: null },
      pendentes: { quantidade: 2, mais_antiga: null },
    });
  const emitidos = () => avisos.emitir.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    process.env = { ...env, WA_TRANSCRICAO_URL: 'http://runner:9200/transcrever', WA_TRANSCRICAO_TOKEN: 'tk' };
    delete process.env.ASSISTENTE_RUNNER_URL;
    delete process.env.ASSISTENTE_RUNNER_TOKEN;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    avisos = { emitir: jest.fn(), resolver: jest.fn() };
    resposta = saude();
    (global as any).fetch = jest.fn(async (url: string, init: any) => {
      expect(url).toBe('http://runner:9200/assistente/saude');
      expect(init.headers.Authorization).toBe('Bearer tk');
      if (resposta instanceof Error) throw resposta;
      return { ok: true, json: async () => resposta };
    });
    sessoes = { exigirTela: jest.fn(async () => ({ id: 'u1', nome: 'Lucas' })) };
    svc = new AssistenteService(avisos as any, sessoes as any);
  });

  afterAll(() => {
    process.env = env;
  });

  it('sem endereço e senha não lê nada', async () => {
    delete process.env.WA_TRANSCRICAO_URL;
    await svc.tick();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('3 leituras sem resposta emitem assistente.mudo uma vez; 2 não; a 4ª não repete', async () => {
    await svc.tick(); // boot: resolve o que ficou
    avisos.resolver.mockClear();
    resposta = new Error('timeout');
    await svc.tick();
    await svc.tick();
    expect(avisos.emitir).not.toHaveBeenCalled();
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
    expect(avisos.emitir).toHaveBeenCalledWith(
      'assistente.mudo',
      expect.objectContaining({ ref: 'runner', link: '/sistema/whatsapp', vars: expect.objectContaining({ motivo: 'runner não responde', guardadas: '0' }) }),
    );
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
    expect(svc.semRespostaDesde).not.toBeNull();
    expect(svc.retrato).not.toBeNull();
  });

  it('retrato com login emite precisa_login com as guardadas', async () => {
    resposta = login();
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledWith(
      'assistente.precisa_login',
      expect.objectContaining({ ref: 'runner', vars: expect.objectContaining({ guardadas: '2' }) }),
    );
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledTimes(1);
  });

  it('mudo -> login resolve o mudo e emite precisa_login', async () => {
    resposta = new Error('timeout');
    await svc.tick();
    await svc.tick();
    await svc.tick();
    expect(emitidos()).toEqual(['assistente.mudo']);
    resposta = login();
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.mudo', 'runner');
    expect(emitidos()).toEqual(['assistente.mudo', 'assistente.precisa_login']);
  });

  it('volta resolve e emite voltou com a contagem do reenvio; queda nova resolve o voltou', async () => {
    resposta = login();
    await svc.tick();
    resposta = saude({
      eventos: [
        { id: 9, quando: '2026-11-23T10:20:00-04:00', tipo: 'reenvio', origem: 'volta', motivo: null, por: null, achadas: 3, reenviadas: 3, vencidas: 0 },
      ],
    });
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.precisa_login', 'runner');
    expect(avisos.emitir).toHaveBeenLastCalledWith(
      'assistente.voltou',
      expect.objectContaining({ ref: 'runner', vars: expect.objectContaining({ reenviadas: '3' }) }),
    );
    resposta = login();
    await svc.tick();
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.voltou', 'runner');
  });

  it('volta sem evento de reenvio espera 4 leituras e emite com 0', async () => {
    resposta = login();
    await svc.tick();
    resposta = saude();
    for (let i = 0; i < 3; i++) await svc.tick();
    expect(emitidos()).toEqual(['assistente.precisa_login']);
    await svc.tick();
    expect(avisos.emitir).toHaveBeenLastCalledWith(
      'assistente.voltou',
      expect.objectContaining({ vars: expect.objectContaining({ reenviadas: '0' }) }),
    );
  });

  it('nao_voltou e Claude por cota viram assistente.mudo', async () => {
    resposta = saude({
      estado: 'nao_voltou',
      eventos: [{ id: 1, quando: '2026-11-23T09:00:00-04:00', tipo: 'nao_voltou', origem: 'vigia', motivo: null, por: null, achadas: 0, reenviadas: 0, vencidas: 0 }],
    });
    await svc.tick();
    expect(avisos.emitir).toHaveBeenCalledWith(
      'assistente.mudo',
      expect.objectContaining({ vars: expect.objectContaining({ motivo: 'reiniciou 3 vezes em 30 minutos e não voltou' }) }),
    );
  });

  it('1ª leitura boa depois do boot resolve sem emitir; a 2ª não repete', async () => {
    await svc.tick();
    await svc.tick();
    expect(avisos.emitir).not.toHaveBeenCalled();
    expect(avisos.resolver).toHaveBeenCalledTimes(3);
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.mudo', 'runner');
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.precisa_login', 'runner');
    expect(avisos.resolver).toHaveBeenCalledWith('assistente.voltou', 'runner');
  });

  it('runner recém-subido sem teste do Claude não encerra a queda nem reemite', async () => {
    resposta = login();
    await svc.tick();
    resposta = saude({ subiu_em: '2026-11-23T10:30:00-04:00', claude: { estado: 'ok', motivo: null, desde: '2026-11-23T10:30:00-04:00', detalhe: null, ultimo_teste: '2026-11-23T10:29:59-04:00' } });
    await svc.tick();
    expect(avisos.resolver).not.toHaveBeenCalledWith('assistente.precisa_login', 'runner');
    resposta = login();
    await svc.tick();
    expect(emitidos()).toEqual(['assistente.precisa_login']);
  });

  it('URL própria do runner sem token próprio não usa a senha da transcrição', async () => {
    process.env.ASSISTENTE_RUNNER_URL = 'http://outro-host:9300';
    await svc.tick();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  describe('rotas da tela', () => {
    const negar = () =>
      sessoes.exigirTela.mockImplementation(async (_u: string, acao: string) => {
        if (acao === 'editar') throw new ForbiddenException('sem editar');
        return { id: 'u1', nome: 'Lucas' };
      });

    it('GET devolve o último retrato com alcancavel false quando o runner cai', async () => {
      resposta = saude({ reinicios_24h: 2 });
      await svc.tick();
      resposta = new Error('timeout');
      await svc.tick();
      const fetchMock = (global as any).fetch as jest.Mock;
      fetchMock.mockClear();
      const r = await svc.ler('u1');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessoes.exigirTela).toHaveBeenCalledWith('u1', 'visualizar');
      expect(r.configurado).toBe(true);
      expect(r.alcancavel).toBe(false);
      expect(r.sem_resposta_desde).not.toBeNull();
      expect(r.retrato?.reinicios_24h).toBe(2);
    });

    it('GET sem configuração devolve configurado false', async () => {
      delete process.env.WA_TRANSCRICAO_URL;
      expect(await svc.ler('u1')).toEqual({
        configurado: false,
        alcancavel: false,
        sem_resposta_desde: null,
        lido_em: null,
        retrato: null,
      });
    });

    it('GET sem visualizar -> 403', async () => {
      sessoes.exigirTela.mockRejectedValue(new ForbiddenException('sem ver'));
      await expect(svc.ler('u2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ações sem editar -> 403 e não chamam o runner', async () => {
      negar();
      await expect(svc.reiniciar('u2')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.resgatar('u2')).rejects.toBeInstanceOf(ForbiddenException);
      expect((global as any).fetch).not.toHaveBeenCalled();
    });

    it('reiniciar e resgatar mandam por com o nome de quem agiu', async () => {
      const fetchMock = jest.fn(async () => ({ ok: true, status: 202 }));
      (global as any).fetch = fetchMock;
      expect(await svc.reiniciar('u1')).toEqual({ ok: true });
      expect(await svc.resgatar('u1')).toEqual({ ok: true });
      expect(sessoes.exigirTela).toHaveBeenCalledWith('u1', 'editar');
      const chamadas = fetchMock.mock.calls as unknown as [string, any][];
      expect(chamadas.map((c) => c[0])).toEqual([
        'http://runner:9200/assistente/reiniciar',
        'http://runner:9200/assistente/resgatar',
      ]);
      for (const [, init] of chamadas) {
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer tk');
        expect(JSON.parse(init.body)).toEqual({ por: 'Lucas' });
      }
    });

    it('runner fora ou com erro -> 502 com o texto', async () => {
      (global as any).fetch = jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      await expect(svc.reiniciar('u1')).rejects.toThrow(
        new BadGatewayException('O assistente não responde. O vigia reinicia sozinho em até 90 segundos.'),
      );
      (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500 }));
      await expect(svc.resgatar('u1')).rejects.toBeInstanceOf(BadGatewayException);
    });
  });
});
