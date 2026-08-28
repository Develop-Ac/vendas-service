import { ResgateService } from './resgate.service';
import { CarteirizacaoService, ClienteCarteira } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { WhatsappRepository } from '../whatsapp/whatsapp.repository';

const DIA_MS = 86_400_000;

function cliente(over: Partial<ClienteCarteira>): ClienteCarteira {
  return {
    cli_codigo: 1,
    cli_nome: 'CLIENTE',
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
    data_ult_compra: new Date(Date.now() - 50 * DIA_MS),
    dias_sem_compra: 50,
    faturamento_total: 100_000,
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
    score: 80,
    score_faixa: 'A',
    curva_abc: 'A',
    risco_inativacao: true,
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

describe('ResgateService', () => {
  let clientes: ClienteCarteira[];
  let abertos: any[];
  let abertosNovos: any[];
  let atualizados: Array<{ id: string; data: any }>;
  let msgEnviada: Map<number, Date>;

  const repo = {
    resgatesAbertos: jest.fn(async () => abertos),
    abrirResgates: jest.fn(async (rows: any[]) => {
      abertosNovos.push(...rows);
      return { count: rows.length };
    }),
    atualizarResgate: jest.fn(async (id: string, data: any) => {
      atualizados.push({ id, data });
    }),
    resgatesFechadosDesde: jest.fn(async () => []),
    ultimaMensagemEnviadaPorCliente: jest.fn(async () => msgEnviada),
    tarefasConcluidasPorRepDesde: jest.fn(async () => []),
    escaladasPorRep: jest.fn(async () => []),
    slaResgatePorRepDesde: jest.fn(async () => []),
    desfechosPorRepDesde: jest.fn(async () => []),
    resumoMotivosDesde: jest.fn(async () => []),
  } as unknown as CarteirizacaoPrismaRepository;

  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
    listarVendedores: jest.fn(async () => [
      { rep_codigo: 10, rep_nome: 'VENDEDOR', clientes_carteira: 5 },
    ]),
  } as unknown as CarteirizacaoService;

  const erp = {
    orcamentosPorRep: jest.fn(async () => [{ rep_codigo: 10, qtd: 12, valor: 30_000 }]),
  } as unknown as CarteirizacaoErpRepository;

  const wa = {
    mensagensPorRepDesde: jest.fn(async () => []),
  } as unknown as WhatsappRepository;

  const service = new ResgateService(carteirizacao, repo, erp, wa);

  beforeEach(() => {
    clientes = [];
    abertos = [];
    abertosNovos = [];
    atualizados = [];
    msgEnviada = new Map();
    jest.clearAllMocks();
  });

  it('abre episódio para risco novo — SLA de 48h só na curva A', async () => {
    clientes = [
      cliente({ cli_codigo: 1, curva_abc: 'A' }),
      cliente({ cli_codigo: 2, curva_abc: 'B' }),
      cliente({ cli_codigo: 3, risco_inativacao: false }), // fora de risco: não abre
    ];
    const r = await service.reconciliar();
    expect(r.novos).toBe(2);
    const porCli = new Map(abertosNovos.map((n) => [n.cli_codigo, n]));
    expect(porCli.get(1)!.sla_em).toBeInstanceOf(Date);
    expect(porCli.get(2)!.sla_em).toBeNull();
  });

  it('não duplica episódio de cliente que já está na esteira', async () => {
    clientes = [cliente({ cli_codigo: 1 })];
    abertos = [{ id: 'r1', cli_codigo: 1, rep_codigo: 10, estagio: 'A_CONTATAR', aberto_em: new Date(), sla_em: null, sla_cumprido: null, contatado_em: null, proposta_em: null }];
    // sem sinal novo: nada muda, nada abre
    clientes[0].data_ult_compra = new Date(Date.now() - 50 * DIA_MS);
    const r = await service.reconciliar();
    expect(r.novos).toBe(0);
    expect(atualizados).toHaveLength(0);
  });

  it('avança sozinho: mensagem -> CONTATADO, orçamento -> PROPOSTA, venda -> RECUPERADO', async () => {
    const aberto_em = new Date(Date.now() - 3 * DIA_MS);
    const base = { rep_codigo: 10, aberto_em, sla_em: null, sla_cumprido: null, contatado_em: null, proposta_em: null };
    clientes = [
      cliente({ cli_codigo: 1 }),
      cliente({ cli_codigo: 2, ult_orcamento: new Date(Date.now() - 1 * DIA_MS) }),
      cliente({ cli_codigo: 3, data_ult_compra: new Date(Date.now() - 1 * DIA_MS), dias_sem_compra: 1, risco_inativacao: false }),
    ];
    msgEnviada.set(1, new Date(Date.now() - 2 * DIA_MS));
    abertos = [
      { id: 'r1', cli_codigo: 1, estagio: 'A_CONTATAR', ...base },
      { id: 'r2', cli_codigo: 2, estagio: 'CONTATADO', ...base },
      { id: 'r3', cli_codigo: 3, estagio: 'PROPOSTA', ...base },
    ];
    await service.reconciliar();
    const porId = new Map(atualizados.map((a) => [a.id, a.data]));
    expect(porId.get('r1')).toMatchObject({ estagio: 'CONTATADO' });
    expect(porId.get('r2')).toMatchObject({ estagio: 'PROPOSTA' });
    expect(porId.get('r3')).toMatchObject({ estagio: 'RECUPERADO' });
    expect(porId.get('r3').fechado_em).toEqual(clientes[2].data_ult_compra);
  });

  it('cliente que inativa fecha como PERDIDO; sinal antes da abertura não conta', async () => {
    const aberto_em = new Date(Date.now() - 10 * DIA_MS);
    clientes = [
      cliente({
        cli_codigo: 1,
        status: 'INATIVO',
        risco_inativacao: false,
        dias_sem_compra: 65,
        data_ult_compra: new Date(Date.now() - 65 * DIA_MS), // ANTES da abertura
        ult_orcamento: new Date(Date.now() - 30 * DIA_MS), // idem
      }),
    ];
    abertos = [
      { id: 'r1', cli_codigo: 1, rep_codigo: 10, estagio: 'A_CONTATAR', aberto_em, sla_em: null, sla_cumprido: null, contatado_em: null, proposta_em: null },
    ];
    await service.reconciliar();
    expect(atualizados[0].data).toMatchObject({ estagio: 'PERDIDO' });
    expect(atualizados[0].data.contatado_em).toBeUndefined();
  });

  it('SLA: cumpre com sinal dentro do prazo, falha com prazo vencido sem sinal', async () => {
    const aberto_em = new Date(Date.now() - 3 * DIA_MS);
    clientes = [
      cliente({ cli_codigo: 1 }),
      cliente({ cli_codigo: 2 }),
    ];
    msgEnviada.set(1, new Date(aberto_em.getTime() + 24 * 3_600_000)); // 24h depois: dentro de 48h
    abertos = [
      { id: 'r1', cli_codigo: 1, rep_codigo: 10, estagio: 'A_CONTATAR', aberto_em, sla_em: new Date(aberto_em.getTime() + 48 * 3_600_000), sla_cumprido: null, contatado_em: null, proposta_em: null },
      { id: 'r2', cli_codigo: 2, rep_codigo: 10, estagio: 'A_CONTATAR', aberto_em, sla_em: new Date(aberto_em.getTime() + 48 * 3_600_000), sla_cumprido: null, contatado_em: null, proposta_em: null },
    ];
    await service.reconciliar();
    const porId = new Map(atualizados.map((a) => [a.id, a.data]));
    expect(porId.get('r1')).toMatchObject({ sla_cumprido: true, estagio: 'CONTATADO' });
    expect(porId.get('r2')).toMatchObject({ sla_cumprido: false });
  });

  it('painel esforço×resultado agrega por vendedor', async () => {
    clientes = [];
    const p = await service.painelEsforco(7);
    expect(p.vendedores).toHaveLength(1);
    expect(p.vendedores[0]).toMatchObject({
      rep_codigo: 10,
      rep_nome: 'VENDEDOR',
      orcamentos: 12,
      valor_orcado: 30_000,
    });
    expect(p.totais.orcamentos).toBe(12);
  });
});
