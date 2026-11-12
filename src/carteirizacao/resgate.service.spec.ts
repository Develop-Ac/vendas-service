import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
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
    curva_criterio: 'FINANCEIRO',
    curva_pontos: null,
    curva_motivo: null,
    financeiro: null,
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
  let mensagens: Array<{ cli_codigo: number; rep_codigo: number; timestamp: Date }>;

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
    // A última de cada cliente (msgEnviada) também existe na lista de mensagens.
    mensagensEnviadasAosClientes: jest.fn(async () => [
      ...[...msgEnviada].map(([cli_codigo, timestamp]) => ({ cli_codigo, rep_codigo: 10, timestamp })),
      ...mensagens,
    ]),
    tarefasConcluidasPorRepDesde: jest.fn(async () => []),
    escaladasPorRep: jest.fn(async () => []),
    slaResgatePorRepDesde: jest.fn(async () => []),
    desfechosPorRepDesde: jest.fn(async () => []),
    orcamentosIntranetPorRepDesde: jest.fn(async () => []),
    resumoMotivosDesde: jest.fn(async () => []),
  } as unknown as CarteirizacaoPrismaRepository;

  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
    vendedoresAtivosAtacado: jest.fn(async () => new Set([10])),
    listarVendedores: jest.fn(async () => [
      { rep_codigo: 10, rep_nome: 'VENDEDOR', clientes_carteira: 5 },
      { rep_codigo: 356, rep_nome: 'CARTEIRA DO ATACADO - DISPONÍVEL', clientes_carteira: 793 },
    ]),
  } as unknown as CarteirizacaoService;

  const erp = {
    orcamentosPorRep: jest.fn(async () => [
      { rep_codigo: 10, qtd: 12, valor: 30_000 },
      { rep_codigo: 340, qtd: 4, valor: 9_000 }, // balcão orçando para cliente atacado
    ]),
  } as unknown as CarteirizacaoErpRepository;

  const wa = {
    mensagensPorRepDesde: jest.fn(async () => [
      { rep_codigo: 316, direcao: 'ENVIADA', _count: { _all: 50 } }, // sessão do supervisor
    ]),
  } as unknown as WhatsappRepository;

  const avisosVendas = { filaDia: jest.fn(async () => undefined), filaEscalada: jest.fn(async () => undefined), resgateSla: jest.fn(async () => undefined), orcamentoVencendo: jest.fn(async () => undefined) } as unknown as AvisosVendasService;
  const service = new ResgateService(carteirizacao, repo, erp, wa, avisosVendas);

  beforeEach(() => {
    clientes = [];
    abertos = [];
    abertosNovos = [];
    atualizados = [];
    msgEnviada = new Map();
    mensagens = [];
    jest.clearAllMocks();
  });

  it('abre episódio para risco novo — SLA de 48h só na curva A; mensagem dentro da janela segura', async () => {
    clientes = [
      cliente({ cli_codigo: 1, curva_abc: 'A' }),
      cliente({ cli_codigo: 2, curva_abc: 'B' }),
      cliente({ cli_codigo: 3, risco_inativacao: false }), // fora de risco: não abre
      cliente({ cli_codigo: 4, curva_abc: 'A' }), // em risco pelo ERP, mas falou por WhatsApp há 10 dias (< 30)
    ];
    msgEnviada.set(4, new Date(Date.now() - 10 * 86_400_000));
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

  it('SLA: vale a PRIMEIRA mensagem depois da abertura e a reprovação é revista quando ela chega atrasada', async () => {
    const aberto_em = new Date(Date.now() - 5 * DIA_MS);
    const sla_em = new Date(aberto_em.getTime() + 48 * 3_600_000);
    const h = (n: number) => new Date(aberto_em.getTime() + n * 3_600_000);
    clientes = [1, 2, 3].map((cli_codigo) => cliente({ cli_codigo }));
    const base = { rep_codigo: 10, estagio: 'CONTATADO', aberto_em, sla_em, contatado_em: h(72), proposta_em: null };
    abertos = [
      { id: 'recarga', cli_codigo: 1, ...base, sla_cumprido: false }, // falou com 24h; a mensagem só entrou depois da reprovação
      { id: 'atrasado', cli_codigo: 2, ...base, sla_cumprido: false }, // só falou com 72h: continua reprovado
      { id: 'duasMsgs', cli_codigo: 3, ...base, estagio: 'A_CONTATAR', contatado_em: null, sla_cumprido: null }, // 24h e 72h: vale a de 24h
    ];
    mensagens = [
      { cli_codigo: 1, rep_codigo: 10, timestamp: h(24) },
      { cli_codigo: 1, rep_codigo: 10, timestamp: h(72) },
      { cli_codigo: 2, rep_codigo: 10, timestamp: h(72) },
      { cli_codigo: 3, rep_codigo: 10, timestamp: h(72) },
      { cli_codigo: 3, rep_codigo: 10, timestamp: h(24) },
    ];
    await service.reconciliar();
    const porId = new Map(atualizados.map((a) => [a.id, a.data]));
    expect(porId.get('recarga')).toEqual({ sla_cumprido: true });
    expect(porId.has('atrasado')).toBe(false);
    expect(porId.get('duasMsgs')).toMatchObject({ sla_cumprido: true, contatado_em: h(24), estagio: 'CONTATADO' });
  });

  it('painel esforço×resultado agrega por vendedor — só vendedor ativo do atacado', async () => {
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
