import { ForbiddenException } from '@nestjs/common';
import { SupervisaoService } from './supervisao.service';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { FilaService } from './fila.service';
import { ResgateService } from './resgate.service';

const DIA_MS = 86_400_000;
const diasAtras = (n: number) => new Date(Date.now() - n * DIA_MS);

function cli(over: Record<string, unknown>) {
  return {
    cli_codigo: 1,
    cli_nome: 'CLIENTE',
    em_carteira: true,
    rep_codigo: 10,
    rep_nome: 'ANA',
    curva_abc: 'A',
    status: 'ATIVO',
    revisao: false,
    dias_sem_compra: 5,
    dias_sem_orcamento: 5,
    faturamento_3m: 0,
    faturamento_3m_ant: 0,
    quadrante: 'TRABALHADA',
    ...over,
  };
}

describe('SupervisaoService', () => {
  let clientes: any[];
  let tarefas: any[];
  let resgatesSla: any[];
  let orcs: any[] | null;
  let desfechos: Map<number, Date>;
  let usuario: any;
  let inseridas: any[];

  const repo = {
    ultimaMensagemEnviadaPorCliente: jest.fn(async () => new Map<number, Date>([[3, diasAtras(2)]])),
    metasAtacado: jest.fn(async () => []),
    tarefasDaJanela: jest.fn(async () => tarefas),
    resgatesComSlaNaJanela: jest.fn(async () => resgatesSla),
    desfechosDosOrcamentos: jest.fn(async () => desfechos),
    resgatesAbertos: jest.fn(async () => []),
    escaladasPorRep: jest.fn(async () => []),
    resgatesFechadosDesde: jest.fn(async () => []),
    usuarioVendas: jest.fn(async () => usuario),
    inserirMetaAtacado: jest.fn(async (d: any) => inseridas.push(d)),
  };
  const carteirizacao = {
    snapshotCarteira: jest.fn(async () => clientes),
    listarVendedores: jest.fn(async () => [{ rep_codigo: 10, rep_nome: 'ANA', clientes_carteira: 3 }]),
  };
  const erp = {
    orcamentosComFechamento: jest.fn(async () => orcs),
    faturamentoPorClientePeriodo: jest.fn(async () => new Map<number, number>([[1, 1000], [2, 0]])),
  };
  const fila = { reconciliar: jest.fn(async () => undefined) };
  const resgate = { reconciliar: jest.fn(async () => undefined) };

  const svc = new SupervisaoService(
    carteirizacao as unknown as CarteirizacaoService,
    repo as unknown as CarteirizacaoPrismaRepository,
    erp as unknown as CarteirizacaoErpRepository,
    fila as unknown as FilaService,
    resgate as unknown as ResgateService,
  );

  beforeEach(() => {
    clientes = [
      cli({ cli_codigo: 1, dias_sem_compra: 30, dias_sem_orcamento: 20 }), // curva A fora da régua
      cli({ cli_codigo: 2, dias_sem_compra: 3 }), // dentro
      cli({ cli_codigo: 3, dias_sem_compra: 40, dias_sem_orcamento: 40 }), // mensagem há 2d: dentro
      cli({ cli_codigo: 4, rep_codigo: 316, rep_nome: 'POOL', status: 'DISPONIVEL' }),
    ];
    const prazo = diasAtras(1);
    tarefas = [
      { rep_codigo: 10, status: 'CONCLUIDA', prazo_em: prazo, concluida_em: diasAtras(2) },
      { rep_codigo: 10, status: 'ESCALADA', prazo_em: prazo, concluida_em: null },
    ];
    resgatesSla = [{ rep_codigo: 10, sla_cumprido: true }, { rep_codigo: 10, sla_cumprido: null }];
    orcs = [];
    desfechos = new Map();
    usuario = { id: 'g1', nome: 'Gerente', vendas_hub_inicial: 'GERENCIA', setor: 'VENDAS' };
    inseridas = [];
    jest.clearAllMocks();
  });

  it('mede os 4 critérios de esforço por vendedor, sem o pool', async () => {
    const r = await svc.esforco({});
    expect(r.vendedores.map((v) => v.rep_codigo)).toEqual([10]);
    const ana = r.vendedores[0];
    expect(ana.criterios.ESF_CURVA_A_FORA_REGUA).toMatchObject({ valor: 1, semaforo: 'vermelho' });
    expect(ana.curva_a_fora.map((c) => c.cli_codigo)).toEqual([1]);
    expect(ana.criterios.ESF_FILA_NO_PRAZO_PCT).toMatchObject({ valor: 50, num: 1, den: 2, semaforo: 'vermelho' });
    expect(ana.criterios.ESF_RESGATE_A_48H_PCT).toMatchObject({ valor: 100, den: 1, semaforo: 'verde' });
    expect(ana.criterios.ESF_MOTIVO_3DU_PCT.valor).toBeNull();
    expect(ana.semaforo).toBe('vermelho');
  });

  it('sem leitura de orçamentos o motivo fica sem cor, o resto segue', async () => {
    orcs = null;
    const r = await svc.esforco({ rep_codigo: 10 });
    expect(r.orcamentos_indisponiveis).toBe(true);
    expect(r.vendedores[0].criterios.ESF_MOTIVO_3DU_PCT.semaforo).toBeNull();
  });

  it('KPIs do mês corrente saem com meta e semáforo', async () => {
    const r = await svc.painel({});
    const ativos = r.kpis.find((k) => k.chave === 'CLIENTES_ATIVOS_MES')!;
    expect(ativos).toMatchObject({ valor: 1, meta: 290, semaforo: 'vermelho' });
    const fila = r.kpis.find((k) => k.chave === 'FILA_NO_PRAZO_PCT')!;
    expect(fila.valor).toBe(50);
    expect(r.kpis).toHaveLength(9);
  });

  it('só a gerência grava meta; o supervisor só observa', async () => {
    usuario = { id: 's1', nome: 'Supervisor', vendas_hub_inicial: 'SUPERVISAO_ATACADO', setor: 'VENDAS' };
    await expect(svc.gravarMeta({ indicador: 'RECEITA_MES', valor: 600_000, usuario_id: 's1' })).rejects.toThrow(ForbiddenException);
    usuario = { id: 'g1', nome: 'Gerente', vendas_hub_inicial: 'GERENCIA', setor: 'VENDAS' };
    await svc.gravarMeta({ indicador: 'RECEITA_MES', valor: 600_000, faixa_amarela: 5, vigente_desde: '2026-10-26', usuario_id: 'g1' });
    expect(inseridas[0]).toMatchObject({ indicador: 'RECEITA_MES', valor: 600_000, faixa_amarela: 5, criado_por: 'g1' });
  });
});
