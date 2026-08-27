import { ServiceUnavailableException } from '@nestjs/common';
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

  const repo = {
    tarefasEmAndamento: jest.fn(async () => tarefasEmAndamento),
    tarefasConcluidasDesde: jest.fn(async () => []),
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
  } as unknown as CarteirizacaoPrismaRepository;

  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
  } as unknown as CarteirizacaoService;

  const service = new FilaService(carteirizacao, repo);

  beforeEach(() => {
    clientes = [];
    tarefasEmAndamento = [];
    criadas = [];
    concluidas = [];
    escaladas = [];
    canceladas = [];
    jest.clearAllMocks();
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

  it('gera RESGATE com prazo curto para curva A em risco de inativação', async () => {
    clientes = [
      cliente({ cli_codigo: 1, curva_abc: 'A', risco_inativacao: true, dias_sem_compra: 50, dias_sem_orcamento: 50 }),
      // risco em curva B não é resgate — cai na régua comum (30 < 50 -> CONTATO)
      cliente({ cli_codigo: 2, curva_abc: 'B', risco_inativacao: true, dias_sem_compra: 50, dias_sem_orcamento: 50 }),
    ];
    await service.gerar();
    const porCli = new Map(criadas.map((c) => [c.cli_codigo, c]));
    expect(porCli.get(1)!.tipo).toBe('RESGATE');
    expect(porCli.get(2)!.tipo).toBe('CONTATO');
    // prazo do resgate (48h) chega antes do prazo de contato (3d)
    expect(porCli.get(1)!.prazo_em.getTime()).toBeLessThan(porCli.get(2)!.prazo_em.getTime());
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
