import { RetornoVendaPerdidaService } from './retorno-venda-perdida.service';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { hojeYmd } from './supervisao.indicadores';

const DIA_MS = 86_400_000;
const AGORA = new Date('2026-11-13T15:00:00Z');

/** Cliente mínimo da carteira: só os campos que o retorno lê variam. */
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

describe('RetornoVendaPerdidaService', () => {
  let clientes: ClienteCarteira[];
  let vendasPerdidas: any[];
  let tabela: any[];
  let saldos: Record<number, number>;
  let erpFora: boolean;
  let linhas: any[];
  let ativas: any[];
  let ativos: Set<number>;
  let seq: number;
  let msgs: Map<number, Date>;

  const repo = {
    vendasPerdidasComCliente: jest.fn(async (desde: Date) => vendasPerdidas.filter((v) => v.created_at >= desde)),
    retornosParaReconciliar: jest.fn(async (desde: Date) =>
      tabela.filter((r) => r.encerrada_em == null || r.gerada_em >= desde).map((r) => ({ ...r })),
    ),
    retornosDosClientes: jest.fn(async (clis: number[], desde: Date) =>
      tabela.filter((r) => clis.includes(r.cli_codigo) && r.gerada_em >= desde).map((r) => ({ ...r })),
    ),
    criarRetornos: jest.fn(async (rows: any[]) => {
      for (const r of rows) {
        tabela.push({
          id: `r${++seq}`,
          status: 'ABERTA',
          contato_em: null,
          contato_sinal: null,
          cancelada_em: null,
          encerrada_em: null,
          convertida_em: null,
          convertida_qtd: null,
          convertida_valor: null,
          ...r,
        });
      }
      return { count: rows.length };
    }),
    atualizarRetorno: jest.fn(async (id: string, data: any) => Object.assign(tabela.find((r) => r.id === id), data)),
    ultimaMensagemEnviadaPorCliente: jest.fn(async () => msgs),
    retornosEmAberto: jest.fn(async (rep?: number) =>
      tabela
        .filter((r) => r.encerrada_em == null && (rep == null || r.rep_codigo === rep))
        .sort((a, b) => a.prazo_em - b.prazo_em)
        .map((r) => ({ ...r })),
    ),
    coberturasAtivas: jest.fn(async () => ativas),
    tarefasEmAndamento: jest.fn(async (): Promise<any[]> => []),
  } as unknown as CarteirizacaoPrismaRepository;

  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
    vendedoresAtivosAtacado: jest.fn(async () => ativos),
    resolverNomeRep: jest.fn(async (rep: number) => (rep === 20 ? 'OUTRO' : null)),
  } as unknown as CarteirizacaoService;

  const orcamento = {
    saldosPorCodigo: jest.fn(async (cods: number[]) => {
      if (erpFora) throw new Error('ERP fora');
      return new Map(
        cods.filter((c) => c in saldos).map((c) => [c, { saldo: saldos[c], inativo: false, descricao: `PRODUTO ${c}` }]),
      );
    }),
    vendasPorPar: jest.fn(async () => linhas),
  } as unknown as OrcamentoService;

  const avisos = { filaDia: jest.fn(async () => undefined), filaEscalada: jest.fn(), escaladasSupervisor: jest.fn() };
  const service = new RetornoVendaPerdidaService(carteirizacao, repo, orcamento, avisos as unknown as AvisosVendasService);

  const vp = (over: any = {}) => ({
    id: 'vp1',
    cli_codigo: 1,
    pro_codigo: 500,
    descricao: 'PARA-BRISA',
    quantidade: 2,
    rep_codigo: 10,
    created_at: new Date('2026-11-01T14:00:00Z'),
    ven_orcamento: { cli_nome: 'NOME DO ORCAMENTO' },
    ...over,
  });
  const avancar = (dias: number) => jest.setSystemTime(new Date(AGORA.getTime() + dias * DIA_MS));

  beforeEach(() => {
    jest.useFakeTimers({
      now: AGORA,
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    clientes = [cliente({})];
    vendasPerdidas = [vp()];
    tabela = [];
    saldos = { 500: 5 };
    erpFora = false;
    linhas = [];
    ativas = [];
    ativos = new Set([10, 20]);
    seq = 0;
    msgs = new Map();
  });
  afterEach(() => jest.useRealTimers());

  it('gera para o dono da carteira com prazo de 3 dias', async () => {
    const r = await service.processar();
    expect(tabela).toHaveLength(1);
    expect(tabela[0]).toMatchObject({
      cli_codigo: 1,
      cli_nome: 'CLIENTE TESTE',
      pro_codigo: 500,
      rep_codigo: 10,
      rep_nome: 'VENDEDOR',
      quantidade_pedida: 2,
      saldo_na_geracao: 5,
      status: 'ABERTA',
      venda_perdida_id: 'vp1',
    });
    expect(tabela[0].prazo_em).toEqual(new Date(AGORA.getTime() + 3 * DIA_MS));
    expect(r.geradas).toBe(1);
    expect(r.chegouPorRep.get(10)).toBe(1);
  });

  it('cobertura ativa do dono manda ao substituto', async () => {
    ativas = [{ id: 'c1', rep_titular_codigo: 10, rep_substituto_codigo: 77, rep_substituto_nome: 'SUBSTITUTO' }];
    await service.processar();
    expect(tabela[0]).toMatchObject({ rep_codigo: 77, rep_nome: 'SUBSTITUTO' });
  });

  it('fora de carteira vai a quem registrou; vendedor inativo não gera', async () => {
    clientes = [];
    vendasPerdidas = [vp({ rep_codigo: 20 }), vp({ id: 'vp2', cli_codigo: 2, rep_codigo: 30 })];
    await service.processar();
    expect(tabela).toHaveLength(1);
    expect(tabela[0]).toMatchObject({ cli_codigo: 1, cli_nome: 'NOME DO ORCAMENTO', rep_codigo: 20, rep_nome: 'OUTRO' });
  });

  it('cliente que comprou o produto depois da venda perdida não gera', async () => {
    linhas = [{ cli_codigo: 1, pro_codigo: 500, emissao: '2026-11-05', devolucao: false, quantidade: 2, liquido: 200 }];
    await service.processar();
    expect(tabela).toHaveLength(0);
  });

  it('rodar duas vezes não duplica', async () => {
    await service.processar();
    avancar(1);
    const r = await service.processar();
    expect(tabela).toHaveLength(1);
    expect(r.geradas).toBe(0);
  });

  it('saldo zera no prazo -> CANCELADA, e volta a gerar quando o saldo retorna', async () => {
    await service.processar();
    avancar(1);
    saldos = { 500: 0 };
    const r = await service.processar();
    expect(tabela[0]).toMatchObject({ status: 'CANCELADA' });
    expect(tabela[0].encerrada_em).not.toBeNull();
    expect(r.canceladas).toBe(1);
    avancar(2);
    saldos = { 500: 4 };
    await service.processar();
    expect(tabela).toHaveLength(2);
    expect(tabela[1]).toMatchObject({ status: 'ABERTA', saldo_na_geracao: 4, encerrada_em: null });
  });

  it('3 dias sem sinal -> NEGLIGENCIADA e continua na lista', async () => {
    await service.processar();
    avancar(4);
    const r = await service.processar();
    expect(tabela).toHaveLength(1);
    expect(tabela[0]).toMatchObject({ status: 'NEGLIGENCIADA', encerrada_em: null });
    expect(r.negligenciadas).toBe(1);
  });

  it('aviso do dia: vendedor só com retorno recebe filaDia com chegou; negligência não avisa ninguém', async () => {
    avisos.filaDia.mockClear();
    await service.processar();
    expect(avisos.filaDia).toHaveBeenCalledWith(10, { total: 1, resgates: 0, escaladas: 0, chegou: 1 });
    avancar(4);
    avisos.filaDia.mockClear();
    await service.processar();
    expect(tabela[0]).toMatchObject({ status: 'NEGLIGENCIADA' });
    expect(avisos.filaDia).not.toHaveBeenCalled();
    expect(avisos.filaEscalada).not.toHaveBeenCalled();
    expect(avisos.escaladasSupervisor).not.toHaveBeenCalled();
  });

  it('aviso do dia soma as tarefas da régua geradas hoje', async () => {
    avisos.filaDia.mockClear();
    (repo.tarefasEmAndamento as jest.Mock).mockResolvedValueOnce([
      { tipo: 'RESGATE', gerada_em: AGORA },
      { tipo: 'RECOMPRA', gerada_em: AGORA },
      { tipo: 'RESGATE', gerada_em: new Date(AGORA.getTime() - 2 * DIA_MS) },
    ]);
    await service.processar();
    expect(avisos.filaDia).toHaveBeenCalledWith(10, { total: 3, resgates: 1, escaladas: 0, chegou: 1 });
  });

  it('conversão desconta a devolução e encerra o retorno', async () => {
    await service.processar();
    avancar(2);
    linhas = [
      { cli_codigo: 1, pro_codigo: 500, emissao: '2026-11-14', devolucao: false, quantidade: 3, liquido: 300 },
      { cli_codigo: 1, pro_codigo: 500, emissao: '2026-11-15', devolucao: true, quantidade: 1, liquido: 100 },
    ];
    const r = await service.processar();
    expect(tabela[0]).toMatchObject({
      convertida_qtd: 2,
      convertida_valor: 200,
      convertida_em: new Date('2026-11-14T00:00:00Z'),
      // venda sem outro sinal na carteira conta como contato
      status: 'CONTATADA',
      contato_sinal: 'VENDA',
      contato_em: new Date('2026-11-14T00:00:00Z'),
    });
    expect(tabela[0].encerrada_em).not.toBeNull();
    expect(r.convertidas).toBe(1);
  });

  it('venda que leva todo o saldo encerra como CONTATADA, não CANCELADA', async () => {
    await service.processar();
    avancar(1);
    saldos = { 500: 0 };
    linhas = [{ cli_codigo: 1, pro_codigo: 500, emissao: hojeYmd(new Date(tabela[0].gerada_em)), devolucao: false, quantidade: 3, liquido: 300 }];
    const r = await service.processar();
    expect(tabela[0]).toMatchObject({ status: 'CONTATADA', contato_sinal: 'VENDA' });
    expect(tabela[0].cancelada_em ?? null).toBeNull();
    expect(r.canceladas).toBe(0);
  });

  it('ERP fora não cancela nada e não gera', async () => {
    await service.processar();
    avancar(1);
    saldos = { 500: 0 };
    erpFora = true;
    vendasPerdidas.push(vp({ id: 'vp3', pro_codigo: 600 }));
    await expect(service.processar()).rejects.toThrow('ERP fora');
    expect(tabela).toHaveLength(1);
    expect(tabela[0]).toMatchObject({ status: 'ABERTA', encerrada_em: null });
  });

  describe('listar (leitura da fila)', () => {
    it('dois produtos do mesmo cliente viram uma entrada, com o fone da carteira', async () => {
      vendasPerdidas = [vp(), vp({ id: 'vp2', pro_codigo: 600, created_at: new Date('2026-11-02T14:00:00Z') })];
      saldos = { 500: 5, 600: 1 };
      await service.processar();
      const g = await service.listar({}, clientes);
      expect(g).toHaveLength(1);
      expect(g[0]).toMatchObject({ cli_codigo: 1, fone: '65999990000', rep_codigo: 10, atrasada: false });
      expect(g[0].produtos.map((p) => p.pro_codigo).sort()).toEqual([500, 600]);
    });

    it('filtra pelo vendedor', async () => {
      clientes = [cliente({}), cliente({ cli_codigo: 2, rep_codigo: 20, rep_nome: 'OUTRO', fone: null })];
      vendasPerdidas = [vp(), vp({ id: 'vp2', cli_codigo: 2, rep_codigo: 20 })];
      await service.processar();
      expect((await service.listar({ rep_codigo: 20 }, clientes)).map((g) => g.cli_codigo)).toEqual([2]);
      expect(await service.listar({}, clientes)).toHaveLength(2);
    });

    it('mensagem ao cliente: na leitura seguinte o grupo some e a linha fica CONTATADA', async () => {
      await service.processar();
      expect(await service.listar({}, clientes)).toHaveLength(1);
      avancar(1);
      msgs = new Map([[1, new Date()]]);
      expect(await service.listar({}, clientes)).toEqual([]);
      expect(tabela[0]).toMatchObject({ status: 'CONTATADA', contato_sinal: 'MENSAGEM' });
      expect(tabela[0].encerrada_em).not.toBeNull();
    });

    it('prazo vencido sem sinal: segue na lista como atrasada, sem cancelar por saldo', async () => {
      await service.processar();
      avancar(4);
      saldos = { 500: 0 };
      const leiturasErp = (orcamento.saldosPorCodigo as jest.Mock).mock.calls.length;
      const g = await service.listar({}, clientes);
      expect(g[0]).toMatchObject({ atrasada: true });
      expect(tabela[0]).toMatchObject({ status: 'NEGLIGENCIADA', encerrada_em: null });
      expect((orcamento.saldosPorCodigo as jest.Mock).mock.calls.length).toBe(leiturasErp); // a leitura não toca o ERP
    });
  });
});
