import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { FilaService } from './fila.service';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';

const DIA_MS = 86_400_000;

/** Cliente mínimo para a régua: só os campos que a fila lê. */
function cliente(over: Partial<ClienteCarteira>): ClienteCarteira {
  return {
    cli_codigo: 1,
    cli_nome: 'CLIENTE TESTE',
    uf: 'MT',
    cidade: 'CUIABA',
    fone: '65999990000',
    contato: null,
    localizacao: null,
    tabela_preco: '2',
    em_carteira: true,
    rep_codigo: 10,
    rep_nome: 'VENDEDOR',
    origem: 'SYNC_ERP',
    rep_codigo_cadastro: 10,
    rep_nome_cadastro: 'VENDEDOR',
    data_ult_compra: null,
    dias_sem_compra: null,
    faturamento_total: 1000,
    faturamento_3m: 0,
    faturamento_3m_ant: 0,
    faturamento_12m: 0,
    ticket_medio: 0,
    ticket_dia: 0,
    dias_com_venda: 0,
    qtd_pedidos: 0,
    participacao_carteira_pct: 0,
    margem_custo_pct: 0,
    lucro_12m: 0,
    crediario: null,
    crediario_liberado: false,
    limite_credito: 0,
    limite_disponivel: 0,
    con_codigo: null,
    conceito: null,
    status: 'ATIVO',
    alto_faturamento: false,
    queda: false,
    novo: false,
    score: 50,
    score_faixa: 'B',
    curva_abc: 'A',
    curva_criterio: 'FINANCEIRO',
    curva_pontos: null,
    curva_motivo: null,
    financeiro: null,
    risco_inativacao: false,
    revisao: false,
    revisao_motivo: null,
    ult_orcamento: null,
    dias_sem_orcamento: null,
    orcamentos_90d: 0,
    valor_orcado_90d: 0,
    quadrante: 'PERDA_SILENCIOSA',
    ...over,
  };
}

describe('FilaService', () => {
  let clientes: ClienteCarteira[];
  let tarefasEmAndamento: any[];
  let criadas: any[];
  let concluidas: Array<{ id: string; sinal: string }>;
  let escaladas: string[];
  let canceladas: Array<{ id: string; obs: string }>;
  let msgEnviadaPorCliente: Map<number, Date>;
  let usuario: any;
  let delegadas: Array<{ id: string; data: any }>;

  const repo = {
    tarefasEmAndamento: jest.fn(async () => tarefasEmAndamento),
    ultimaMensagemEnviadaPorCliente: jest.fn(async () => msgEnviadaPorCliente),
    tarefasConcluidasDesde: jest.fn(async () => []),
    escaladasDesde: jest.fn(async () => [{ rep_codigo: 10, rep_nome: 'ANA' }, { rep_codigo: 10, rep_nome: 'ANA' }, { rep_codigo: 10, rep_nome: 'ANA' }]),

    criarTarefas: jest.fn(async (rows: any[]) => {
      criadas.push(...rows);
      return { count: rows.length };
    }),
    concluirTarefa: jest.fn(async (id: string, sinal: string) => {
      concluidas.push({ id, sinal });
    }),
    escalarTarefa: jest.fn(async (id: string) => {
      escaladas.push(id);
    }),
    cancelarTarefa: jest.fn(async (id: string, obs: string) => {
      canceladas.push({ id, obs });
    }),
    orcamentosComDesfecho: jest.fn(async () => new Set()),
    resumoMotivosDesde: jest.fn(async () => []),
    upsertDesfecho: jest.fn(async (p: any) => p),
    usuarioVendas: jest.fn(async () => usuario),
    obterTarefa: jest.fn(async (id: string) => tarefasEmAndamento.find((t) => t.id === id) ?? null),
    delegarTarefa: jest.fn(async (id: string, data: any) => {
      delegadas.push({ id, data });
      return { ...tarefasEmAndamento.find((t) => t.id === id), ...data };
    }),
    // cobertura por período
    coberturasVencidasComTarefas: jest.fn(async () => vencidas),
    coberturasAtivas: jest.fn(async () => ativas),
    coberturasSobrepostas: jest.fn(async (rep: number) =>
      sobrepostas.filter((c) => c.rep_titular_codigo === rep || c.rep_substituto_codigo === rep),
    ),
    delegarTarefasDoTitular: jest.fn(async () => ({ count: 0 })),
    devolverTarefasDaCobertura: jest.fn(async () => 2),
    criarCobertura: jest.fn(async (data: any) => ({ id: 'cNova', ...data, encerrada_em: null })),
    obterCobertura: jest.fn(async (id: string) => sobrepostas.find((c) => c.id === id) ?? null),
    encerrarCobertura: jest.fn(async (id: string, por: string) => ({
      ...sobrepostas.find((c) => c.id === id),
      encerrada_em: new Date(),
      encerrada_por: por,
    })),
  } as unknown as CarteirizacaoPrismaRepository;

  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
    resolverNomeRep: jest.fn(async (rep: number) =>
      rep === 77 ? 'SUBSTITUTO' : rep === 10 ? 'VENDEDOR' : rep === 20 ? 'OUTRO' : null,
    ),
  } as unknown as CarteirizacaoService;
  let vencidas: string[];
  let ativas: any[];
  let sobrepostas: any[];
  const cob = (over: any = {}) => ({
    id: 'c1',
    rep_titular_codigo: 10,
    rep_titular_nome: 'VENDEDOR',
    rep_substituto_codigo: 77,
    rep_substituto_nome: 'SUBSTITUTO',
    inicio: new Date('2026-11-03T00:00:00Z'),
    fim: new Date('2026-11-14T00:00:00Z'),
    encerrada_em: null,
    ...over,
  });

  const avisosVendas = { filaDia: jest.fn(async () => undefined), filaEscalada: jest.fn(async () => undefined), resgateSla: jest.fn(async () => undefined), orcamentoVencendo: jest.fn(async () => undefined), escaladasSupervisor: jest.fn(async () => undefined) } as unknown as AvisosVendasService;
  const service = new FilaService(carteirizacao, repo, avisosVendas);

  beforeEach(() => {
    clientes = [];
    tarefasEmAndamento = [];
    criadas = [];
    concluidas = [];
    escaladas = [];
    canceladas = [];
    msgEnviadaPorCliente = new Map();
    usuario = { id: 'u1', nome: 'SUPERVISOR', vendas_hub_inicial: 'SUPERVISAO_ATACADO', setor: null };
    delegadas = [];
    vencidas = [];
    ativas = [];
    sobrepostas = [];
    jest.clearAllMocks();
  });

  // ------------------------------------------------------------- cobertura
  it('cobertura ativa: passa as abertas do titular e a tarefa nova nasce no substituto', async () => {
    ativas = [cob()];
    clientes = [cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 20, dias_sem_orcamento: 20 })];
    await service.gerar();
    expect((repo as any).delegarTarefasDoTitular).toHaveBeenCalledWith(10, ativas[0]);
    expect(criadas).toHaveLength(1);
    expect(criadas[0]).toMatchObject({
      rep_codigo: 77,
      rep_nome: 'SUBSTITUTO',
      rep_titular_codigo: 10,
      rep_titular_nome: 'VENDEDOR',
      cobertura_id: 'c1',
      delegada_por: 'cobertura:c1',
    });
  });

  it('cobertura vencida/encerrada devolve as tarefas dela na leitura', async () => {
    vencidas = ['cVelha'];
    await service.listar({});
    expect((repo as any).devolverTarefasDaCobertura).toHaveBeenCalledWith('cVelha');
  });

  it('encerrar devolve só as tarefas da cobertura (avulsa não volta)', async () => {
    sobrepostas = [cob()];
    const r = await service.encerrarCobertura('c1', { usuario_id: 'u1' });
    expect(r.devolvidas).toBe(2);
    expect(r.cobertura).toMatchObject({ id: 'c1', inicio: '2026-11-03', fim: '2026-11-14', encerrada_por: 'SUPERVISOR' });
    // a devolução é por cobertura_id; tarefa passada avulsa não é tocada
    expect((repo as any).devolverTarefasDaCobertura).toHaveBeenCalledWith('c1');
    expect((repo as any).delegarTarefa).not.toHaveBeenCalled();
    sobrepostas = [cob({ encerrada_em: new Date() })];
    await expect(service.encerrarCobertura('c1', { usuario_id: 'u1' })).rejects.toThrow(/já foi encerrada/);
  });

  it('listar coberturas exige gestão identificada', async () => {
    usuario = null;
    await expect(service.coberturas(undefined)).rejects.toThrow(/não identificado/);
    usuario = { id: 'u2', nome: 'VENDEDOR', vendas_hub_inicial: 'ATACADO', setor: null };
    await expect(service.coberturas('u2')).rejects.toThrow(/Só a supervisão/);
  });

  it('criar cobertura: valida gestão, datas, substituto e sobreposição', async () => {
    const base = { rep_titular_codigo: 10, rep_substituto_codigo: 77, inicio: '2026-11-03', fim: '2026-11-14', usuario_id: 'u1' };
    const ok = await service.criarCobertura(base);
    expect(ok).toMatchObject({ rep_titular_nome: 'VENDEDOR', rep_substituto_nome: 'SUBSTITUTO', inicio: '2026-11-03' });
    expect((repo as any).coberturasAtivas).toHaveBeenCalled(); // aplica na hora

    usuario = { id: 'u2', nome: 'VENDEDOR', vendas_hub_inicial: 'ATACADO', setor: null };
    await expect(service.criarCobertura(base)).rejects.toThrow(ForbiddenException);
    usuario = { id: 'u1', nome: 'SUPERVISOR', vendas_hub_inicial: 'SUPERVISAO_ATACADO', setor: null };

    await expect(service.criarCobertura({ ...base, rep_substituto_codigo: 10 })).rejects.toThrow(/outro vendedor/);
    await expect(service.criarCobertura({ ...base, fim: '2026-11-01' })).rejects.toThrow(/antes da inicial/);
    await expect(service.criarCobertura({ ...base, inicio: '2026-02-30' })).rejects.toThrow(/Data inválida/);

    sobrepostas = [cob({ id: 'cX', inicio: new Date('2026-11-10T00:00:00Z'), fim: new Date('2026-11-20T00:00:00Z'), rep_substituto_codigo: 20 })];
    await expect(service.criarCobertura(base)).rejects.toThrow(/já tem cobertura/);

    sobrepostas = [cob({ id: 'cY', rep_titular_codigo: 77, rep_substituto_codigo: 20 })];
    await expect(service.criarCobertura(base)).rejects.toThrow(/também está ausente/);
  });

  // ------------------------------------------------------------------ gerar
  it('gera CONTATO quando os dias sem contato passam da régua da curva', async () => {
    clientes = [
      // A (régua 15): 20d sem compra E sem orçamento -> entra
      cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 20, dias_sem_orcamento: 20 }),
      // A: compra velha mas ORÇADO há 5d -> contato houve, não entra
      cliente({ cli_codigo: 2, curva_abc: 'A', dias_sem_compra: 40, dias_sem_orcamento: 5 }),
      // C (régua 60): 40d -> não entra
      cliente({ cli_codigo: 3, curva_abc: 'C', dias_sem_compra: 40, dias_sem_orcamento: 40 }),
      // nunca comprou nem orçou -> entra (Infinity passa qualquer régua)
      cliente({ cli_codigo: 4, curva_abc: 'B', dias_sem_compra: null, dias_sem_orcamento: null }),
    ];
    const r = await service.gerar();
    expect(criadas.map((c) => c.cli_codigo).sort()).toEqual([1, 4]);
    expect(criadas.every((c) => c.tipo === 'CONTATO')).toBe(true);
    expect(r.geradas).toBe(2);
  });

  it('gera RESGATE com prazo curto para curva A/B na janela de resgate; curva C nunca; mensagem recente segura', async () => {
    clientes = [
      cliente({ cli_codigo: 1, curva_abc: 'A', risco_inativacao: true, dias_sem_compra: 31, dias_sem_orcamento: 31 }),
      cliente({ cli_codigo: 2, curva_abc: 'B', risco_inativacao: true, dias_sem_compra: 50, dias_sem_orcamento: 50 }),
      // curva C não tem resgate — cai na régua comum (70 > 60 -> CONTATO)
      cliente({ cli_codigo: 3, curva_abc: 'C', risco_inativacao: false, dias_sem_compra: 70, dias_sem_orcamento: 70 }),
      // curva A em risco pelo ERP, mas com mensagem há 5 dias: nem resgate nem contato (5 < 15)
      cliente({ cli_codigo: 4, curva_abc: 'A', risco_inativacao: true, dias_sem_compra: 40, dias_sem_orcamento: 40 }),
    ];
    msgEnviadaPorCliente.set(4, new Date(Date.now() - 5 * 86_400_000));
    await service.gerar();
    const porCli = new Map(criadas.map((c) => [c.cli_codigo, c]));
    expect(porCli.get(1)!.tipo).toBe('RESGATE');
    expect(porCli.get(2)!.tipo).toBe('RESGATE');
    expect(porCli.get(3)!.tipo).toBe('CONTATO');
    expect(porCli.has(4)).toBe(false);
    // prazo do resgate (48h) chega antes do prazo de contato (3d)
    expect(porCli.get(1)!.prazo_em.getTime()).toBeLessThan(porCli.get(3)!.prazo_em.getTime());
  });

  it('cliente grande fora do próprio ritmo entra antes da régua da curva; orçado depois da compra não entra', async () => {
    process.env.ANALYTICS_ATACADO_URL = 'http://analytics';
    const fetchOriginal = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => [
        { cli: 1, dias_sem_compra: 10, intervalo_dias: 3.2 },
        { cli: 2, dias_sem_compra: 10, intervalo_dias: 3.2 },
      ],
    })) as any;
    try {
      clientes = [
        // curva A, 10d sem compra: a régua (15d) ainda não pegaria
        cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 10, dias_sem_orcamento: 10 }),
        // já foi orçado depois da última compra: alguém está falando com ele
        cliente({ cli_codigo: 2, curva_abc: 'A', dias_sem_compra: 10, dias_sem_orcamento: 2 }),
      ];
      await service.gerar();
      expect(criadas.map((c) => c.cli_codigo)).toEqual([1]);
      expect(criadas[0].motivo_geracao).toContain('costuma comprar a cada 3d');
    } finally {
      global.fetch = fetchOriginal;
      delete process.env.ANALYTICS_ATACADO_URL;
    }
  });

  it('não duplica cliente que já tem tarefa em andamento', async () => {
    clientes = [cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 30 })];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, rep_codigo: 10, rep_nome: 'VENDEDOR', status: 'ABERTA', gerada_em: new Date(), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    const r = await service.gerar();
    expect(criadas).toHaveLength(0);
    expect(r.ja_em_andamento).toBe(1);
  });

  it('cancela tarefa órfã quando a carteira trocou de vendedor e gera para o novo dono', async () => {
    clientes = [cliente({ cli_codigo: 1, rep_codigo: 99, rep_nome: 'NOVO', curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 30 })];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, rep_codigo: 10, rep_nome: 'ANTIGO', status: 'ABERTA', gerada_em: new Date(), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    await service.gerar();
    expect(canceladas).toHaveLength(1);
    expect(criadas).toHaveLength(1);
    expect(criadas[0].rep_codigo).toBe(99);
  });

  it('tarefa passada a outro vendedor sobrevive à geração (carteira = titular)', async () => {
    clientes = [cliente({ cli_codigo: 1, rep_codigo: 10, curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 30 })];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, rep_codigo: 77, rep_nome: 'SUBSTITUTO', rep_titular_codigo: 10, rep_titular_nome: 'VENDEDOR', status: 'ABERTA', gerada_em: new Date(), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    await service.gerar();
    expect(canceladas).toHaveLength(0);
    expect(criadas).toHaveLength(0);
  });

  it('troca real de carteira cancela mesmo tarefa passada adiante', async () => {
    clientes = [cliente({ cli_codigo: 1, rep_codigo: 99, rep_nome: 'NOVO', curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 30 })];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, rep_codigo: 77, rep_nome: 'SUBSTITUTO', rep_titular_codigo: 10, rep_titular_nome: 'VENDEDOR', status: 'ABERTA', gerada_em: new Date(), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    await service.gerar();
    expect(canceladas.map((c) => c.id)).toEqual(['t1']);
    expect(criadas[0].rep_codigo).toBe(99);
  });

  it('delegar: só a gestão passa; guarda o titular e devolve a tarefa enriquecida', async () => {
    clientes = [cliente({ cli_codigo: 1 })];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, rep_codigo: 10, rep_nome: 'VENDEDOR', rep_titular_codigo: null, rep_titular_nome: null, status: 'ABERTA', gerada_em: new Date(), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    usuario = { id: 'u2', nome: 'VENDEDOR', vendas_hub_inicial: 'VENDEDOR', setor: 'VENDAS' };
    await expect(service.delegar('t1', { rep_codigo: 77, usuario_id: 'u2' })).rejects.toThrow(ForbiddenException);
    expect(delegadas).toHaveLength(0);

    usuario = { id: 'u1', nome: 'SUPERVISOR', vendas_hub_inicial: 'SUPERVISAO_ATACADO', setor: null };
    const r = await service.delegar('t1', { rep_codigo: 77, usuario_id: 'u1' });
    expect(delegadas[0].data).toMatchObject({ rep_codigo: 77, rep_nome: 'SUBSTITUTO', rep_titular_codigo: 10, rep_titular_nome: 'VENDEDOR', delegada_por: 'SUPERVISOR' });
    expect(r).toMatchObject({ id: 't1', rep_codigo: 77, rep_titular_codigo: 10, fone: '65999990000' });
    await expect(service.delegar('t1', { rep_codigo: 10, usuario_id: 'u1' })).rejects.toThrow(/já está com este vendedor/);
  });

  it('recusa gerar sem a leitura de orçamentos (quadrantes nulos)', async () => {
    clientes = [cliente({ quadrante: null, dias_sem_compra: 100 })];
    await expect(service.gerar()).rejects.toThrow(ServiceUnavailableException);
    expect(criadas).toHaveLength(0);
  });

  // ------------------------------------------------------------ reconciliar
  it('conclui sozinha por sinal e escala prazo estourado (via listar)', async () => {
    const gerada = new Date(Date.now() - 5 * DIA_MS);
    clientes = [
      // orçamento DEPOIS da geração -> conclui por ORCAMENTO
      cliente({ cli_codigo: 1, ult_orcamento: new Date(Date.now() - 1 * DIA_MS), dias_sem_orcamento: 1 }),
      // venda DEPOIS da geração -> conclui por VENDA
      cliente({ cli_codigo: 2, data_ult_compra: new Date(Date.now() - 2 * DIA_MS), dias_sem_compra: 2 }),
      // sem sinal e prazo vencido -> escala
      cliente({ cli_codigo: 3 }),
    ];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, status: 'ABERTA', gerada_em: gerada, prazo_em: new Date(Date.now() + DIA_MS) },
      { id: 't2', cli_codigo: 2, status: 'ABERTA', gerada_em: gerada, prazo_em: new Date(Date.now() + DIA_MS) },
      { id: 't3', cli_codigo: 3, status: 'ABERTA', gerada_em: gerada, prazo_em: new Date(Date.now() - DIA_MS) },
    ];
    await service.listar({});
    expect(concluidas).toEqual([
      { id: 't1', sinal: 'ORCAMENTO' },
      { id: 't2', sinal: 'VENDA' },
    ]);
    expect(escaladas).toEqual(['t3']);
    // a supervisão recebe as escaladas do dia num aviso só, por vendedor
    expect((avisosVendas as any).escaladasSupervisor).toHaveBeenCalledWith(new Map([['ANA', 3]]));
  });

  it('mensagem enviada (sensor WAHA) é o terceiro sinal: conclui e evita gerar', async () => {
    const gerada = new Date(Date.now() - 5 * DIA_MS);
    clientes = [
      // sem compra nem orçamento, mas o vendedor mandou mensagem ONTEM
      cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 40, dias_sem_orcamento: 40 }),
      // e este outro estaria na régua, mas a mensagem de 3d atrás é contato
      cliente({ cli_codigo: 2, curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 30 }),
    ];
    msgEnviadaPorCliente = new Map([
      [1, new Date(Date.now() - 1 * DIA_MS)],
      [2, new Date(Date.now() - 3 * DIA_MS)],
    ]);
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, status: 'ABERTA', gerada_em: gerada, prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    await service.listar({});
    expect(concluidas).toEqual([{ id: 't1', sinal: 'MENSAGEM' }]);

    tarefasEmAndamento = [];
    await service.gerar();
    expect(criadas).toHaveLength(0); // mensagem recente = contato houve, ninguém entra
  });

  it('NÃO conclui por sinal anterior à geração', async () => {
    clientes = [
      cliente({
        cli_codigo: 1,
        data_ult_compra: new Date(Date.now() - 30 * DIA_MS),
        ult_orcamento: new Date(Date.now() - 30 * DIA_MS),
      }),
    ];
    tarefasEmAndamento = [
      { id: 't1', cli_codigo: 1, status: 'ABERTA', gerada_em: new Date(Date.now() - 2 * DIA_MS), prazo_em: new Date(Date.now() + DIA_MS) },
    ];
    await service.listar({});
    expect(concluidas).toHaveLength(0);
  });

  // --------------------------------------------------------------- desfecho
  it('valida o motivo do desfecho contra os 6 da pesquisa', async () => {
    await expect(
      service.registrarDesfecho(123, { motivo: 'OUTRO', cli_codigo: 1 } as any),
    ).rejects.toThrow(/Motivo inválido/);
    const ok = await service.registrarDesfecho(123, { motivo: 'PRECO', cli_codigo: 1 } as any);
    expect(ok).toMatchObject({ ok: true, orcamento: 123 });
  });
});
