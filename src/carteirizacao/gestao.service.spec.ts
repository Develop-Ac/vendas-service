import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GestaoService } from './gestao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { somarDias } from './supervisao.indicadores';
import { SupervisaoService } from './supervisao.service';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { REP_DISPONIVEL } from './carteirizacao.service';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';

jest.mock('../common/analytics/analytics-atacado', () => ({ analyticsAtacadoGet: jest.fn(async () => null) }));
const analytics = analyticsAtacadoGet as jest.Mock;

/** 25 dias úteis seguidos a partir de 26/10 (novembro comissional). */
const DIAS = Array.from({ length: 25 }, (_, i) => somarDias('2026-10-26', i));
const HOJE = DIAS[11]; // 12º dia útil

describe('GestaoService.visaoGeral', () => {
  let porDia: Array<{ dia: string; venda: number; custo: number; mix1: number }>;
  let cal: { inicio: string; fim: string; dias: string[] } | null;

  const bi = {
    diasUteisPeriodo: jest.fn(async () => cal),
    faturadoCanalPorDia: jest.fn(async () => porDia),
    faturadoCanalMeses: jest.fn(async () => [{ ano: 2026, mes: 10, faturado: 480_000 }]),
    vendedoresAtivosComissao: jest.fn(async () => [
      { rep_codigo: 1, nome: 'A', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 2, nome: 'B', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 3, nome: 'AUX', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 9, nome: 'VAREJO', papel: 'VENDEDOR', local_venda: 'VAREJO' },
    ]),
    faturadoCanalPorVendedor: jest.fn(async () => [
      { rep_codigo: 1, rep_nome: 'A', total: 150_000, ate_ontem: 145_000 }, // faltam 100 mil
      { rep_codigo: 2, rep_nome: 'B', total: 75_500, ate_ontem: 72_100 }, // faltam 114,5 mil → mais distante
    ]),
  };
  const repo = {
    listarMetasPeriodo: jest.fn(async () => [
      { rep_codigo: 1, valor_meta: 250_000 },
      { rep_codigo: 2, valor_meta: 190_000 },
      { rep_codigo: 3, valor_meta: 130_000 },
      { rep_codigo: 9, valor_meta: 999_000 }, // varejo não entra
    ]),
    emNegociacaoPorRep: jest.fn(async () => [
      { rep_codigo: 1, valor: 40_000, quantidade: 3 },
      { rep_codigo: 2, valor: 12_000, quantidade: 2 },
    ]),
    fechamentoAtacado: jest.fn(async () => null), // sem foto: mês encerrado calcula ao vivo
    resgatesAbertos: jest.fn(async () => [{ id: 'r1' }, { id: 'r2' }]),
    escaladasPorRep: jest.fn(async () => [{ rep_codigo: 1, _count: { _all: 3 } }]),
    metasAtacado: jest.fn(async () => [
      { indicador: 'CUSTO_DEPARTAMENTO', valor: custoDepto, faixa_amarela: 10, vigente_desde: '2026-10-26' },
      { indicador: 'PREMIO_N1', valor: 800, faixa_amarela: 10, vigente_desde: '2026-10-26' },
      { indicador: 'PREMIO_N2', valor: 1500, faixa_amarela: 10, vigente_desde: '2026-10-26' },
      { indicador: 'PREMIO_N3', valor: 2000, faixa_amarela: 10, vigente_desde: '2026-10-26' },
    ]),
    usuarioVendas: jest.fn(async (id?: string) =>
      id === 'ger' ? { id, setor: 'VENDAS', vendas_hub_inicial: 'GERENCIA' } : id ? { id, setor: 'VENDAS', vendas_hub_inicial: 'SUPERVISAO_ATACADO' } : null,
    ),
  };
  const kpi = (chave: string, valor: number | null, meta: number, semaforo: string | null, detalhe: Record<string, number> | null = null) => ({
    chave, nome: chave, unidade: chave === 'CLIENTES_ATIVOS_MES' ? 'qtd' : 'pct', valor, meta, semaforo, detalhe,
  });
  // Os KPIs e a carteira vêm da mesma montagem do contexto da supervisão.
  const supervisao = {
    indicadoresDoMes: jest.fn(async () => ({
      kpis: [
        kpi('CLIENTES_ATIVOS_MES', 260, 250, 'verde'),
        kpi('RECUPERACAO_AB_PCT', 32, 35, 'amarelo', { fechados: 25, recuperados: 8 }),
        kpi('CURVA_A_COMPRANDO_PCT', 50, 70, 'vermelho', { curva_a: 40, comprando: 20 }),
        kpi('RESGATE_SLA_PCT', 95, 90, 'verde'),
        kpi('MOTIVOS_APONTADOS_PCT', 85, 80, 'verde'),
        kpi('VAZAMENTO_TRIMESTRE', 3, 2, 'vermelho'),
      ],
      clientes: [
        { cli_codigo: 1, em_carteira: true, rep_codigo: REP_DISPONIVEL },
        { cli_codigo: 2, em_carteira: true, rep_codigo: 1 },
        { cli_codigo: 3, em_carteira: true, rep_codigo: 2 },
        { cli_codigo: 4, em_carteira: false, rep_codigo: null },
      ],
    })),
  };
  let bolsa: Promise<number | null>;
  const orcamento = { bolsaCanal: jest.fn(() => bolsa) };
  let custoDepto: number;
  const service = new GestaoService(
    bi as unknown as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    supervisao as unknown as SupervisaoService,
    orcamento as unknown as OrcamentoService,
  );

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(`${HOJE}T15:00:00Z`),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    cal = { inicio: '2026-10-26', fim: '2026-11-25', dias: DIAS };
    custoDepto = 157_000;
    bolsa = Promise.resolve(12_000);
    porDia = [
      { dia: DIAS[0], venda: 100_000, custo: 70_000, mix1: 30_000 },
      { dia: DIAS[10], venda: 117_100, custo: 80_000, mix1: 40_000 },
      { dia: HOJE, venda: 8_400, custo: 6_000, mix1: 2_000 },
    ];
  });
  afterEach(() => jest.useRealTimers());

  it('aceite de novembro: ritmo sem o dia corrente, previsão e ritmo para a meta', async () => {
    const r = await service.visaoGeral(2026, 11);
    expect(r.periodo).toMatchObject({
      dias_uteis_total: 25,
      dias_uteis_fechados: 11,
      dias_uteis_restantes: 13,
      dia_util_corrente: 12,
      corrente: true,
      fechado: false,
    });
    expect(r.canal.meta).toBe(570_000);
    expect(r.canal.faturado).toBeCloseTo(225_500);
    expect(r.canal.faturado_hoje).toBe(8_400);
    expect(r.canal.ritmo! / 1000).toBeCloseTo(19.7, 1);
    expect(Math.abs(r.canal.previsao! / 1000 - 493.5)).toBeLessThan(0.2);
    expect(r.canal.ritmo_para_meta! / 1000).toBeCloseTo(26.5, 1);
    expect(r.canal.alvo_n3).toBeCloseTo(655_500);
    expect(r.canal.piso).not.toBeNull();
    expect(r.canal.serie).toHaveLength(12);
    expect(r.canal.serie[11].acumulado).toBeCloseTo(225_500);
    expect(r.canal.historico).toHaveLength(5);
    expect(r.canal.historico[4]).toEqual({ ano: 2026, mes: 10, faturado: 480_000 });
    expect(bi.faturadoCanalMeses).toHaveBeenLastCalledWith({ ano: 2026, mes: 6 }, { ano: 2026, mes: 10 });
  });

  it('período do cabeçalho: dias úteis do calendário do BI', async () => {
    expect(await service.periodo(2026, 11)).toMatchObject({ inicio: '2026-10-26', fim: '2026-11-25', dia_util_corrente: 12, dias_uteis_total: 25 });
  });

  it('sem meta cadastrada no mês: nível 0, mesmo com a margem cobrindo o custo', async () => {
    custoDepto = 1_000;
    repo.listarMetasPeriodo.mockResolvedValueOnce([]);
    const r = await service.visaoGeral(2026, 11, 'ger');
    expect(r.canal.meta).toBe(0);
    expect(r.premio).toMatchObject({ nivel_atual: 0, nivel_previsto: 0 });
    expect(r.gerencia!.premio).toBe(0);
  });

  it('mês encerrado: previsão = faturado, sem dias restantes', async () => {
    cal = { inicio: '2026-09-26', fim: '2026-10-25', dias: DIAS.map((d) => somarDias(d, -31)) };
    porDia = [{ dia: '2026-10-01', venda: 480_000, custo: 300_000, mix1: 0 }];
    const r = await service.visaoGeral(2026, 10);
    expect(r.periodo.corrente).toBe(false);
    expect(r.periodo.dias_uteis_restantes).toBe(0);
    expect(r.periodo.dia_util_corrente).toBeNull();
    expect(r.canal.previsao).toBe(r.canal.faturado);
    expect(r.canal.ritmo_para_meta).toBeNull();
  });

  it('período futuro ou inválido → 400', async () => {
    await expect(service.visaoGeral(2027, 3)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.visaoGeral(2026, 13)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prêmio: pontos somam os semáforos; disciplina com componentes', async () => {
    const r = await service.visaoGeral(2026, 11, 'sup');
    const pts = Object.fromEntries(r.premio.indicadores.map((i) => [i.chave, i.pontos]));
    expect(pts).toEqual({ CLIENTES_ATIVOS_MES: 30, RECUPERACAO_AB_PCT: 15, CURVA_A_COMPRANDO_PCT: 0, DISCIPLINA: 25 });
    expect(r.premio.pontos).toBe(70);
    expect(r.premio.indicadores[1]).toMatchObject({ num: 8, den: 25, peso: 30 });
    expect(r.premio.indicadores[3]).toMatchObject({
      chave: 'DISCIPLINA',
      componentes: [{ chave: 'RESGATE_SLA_PCT' }, { chave: 'MOTIVOS_APONTADOS_PCT' }],
    });
    expect(r.premio.trava_bolsa).toBe(false);
  });

  it('usuário comum não recebe a chave gerencia; gerência recebe', async () => {
    const r = await service.visaoGeral(2026, 11, 'sup');
    expect('gerencia' in r).toBe(false);
    const g = await service.visaoGeral(2026, 11, 'ger');
    expect(g.gerencia).toMatchObject({ custo_departamento: 157_000, niveis: { n1: 800, n2: 1500, n3: 2000 } });
  });

  it('bolsa do canal negativa zera o prêmio em reais e mantém o nível', async () => {
    custoDepto = 1_000; // margem do mês cobre o custo: nível 1
    const livre = await service.visaoGeral(2026, 11, 'ger');
    expect(livre.premio.nivel_atual).toBe(1);
    expect(livre.gerencia!.premio).toBe(560); // 800 × 70 pts
    bolsa = Promise.resolve(-500);
    const travado = await service.visaoGeral(2026, 11, 'ger');
    expect(travado.premio.trava_bolsa).toBe(true);
    expect(travado.premio.nivel_atual).toBe(1);
    expect(travado.gerencia!.premio).toBe(0);
  });

  it('falha na bolsa do canal: sem trava e a resposta segue', async () => {
    bolsa = Promise.reject(new Error('BI fora'));
    const r = await service.visaoGeral(2026, 11, 'ger');
    expect(r.premio.trava_bolsa).toBe(false);
    expect(r.canal.faturado).toBeCloseTo(225_500);
  });

  it('kpis: em negociação soma os reps; mix 1 em p.p.; bolsa; pool × carteira', async () => {
    const r = await service.visaoGeral(2026, 11);
    expect(r.kpis.em_negociacao).toEqual({ valor: 52_000, quantidade: 5 });
    // mix 1 = 72 mil / 225,5 mil = 31,93% → degrau 3, sem próximo
    expect(r.kpis.mix1).toEqual({ participacao: 31.93, degrau_atual: 3, proximo_minimo: null, falta_pp: null });
    expect(r.kpis.bolsa_canal).toBe(12_000);
    expect(r.kpis.clientes).toEqual({ pool: 1, carteira: 2 });
  });

  it('analytics null: resposta completa sem FORA_DO_CICLO; nunca mais de quatro alertas', async () => {
    const r = await service.visaoGeral(2026, 11);
    expect(r.alertas.map((a) => a.tipo)).toEqual(['VENDEDOR_DISTANTE', 'CURVA_A_SEM_COMPRA', 'RESGATES']);
    expect(r.alertas[0].texto).toContain('B:');
    expect(r.alertas[0].aba).toBe('equipe');
    expect(r.alertas[1].texto).toContain('20 clientes');
    expect(r.alertas[2].texto).toMatch(/2 resgates abertos · 3 tarefas escaladas/);
    expect(r.canal.faturado).toBeCloseTo(225_500);

    analytics.mockResolvedValueOnce([{ cli: 1 }, { cli: 2 }]);
    const c = await service.visaoGeral(2026, 11);
    expect(c.alertas).toHaveLength(4);
    expect(c.alertas[3]).toMatchObject({ tipo: 'FORA_DO_CICLO', aba: 'carteira' });
  });

  it('falha numa leitura de alerta ou kpi não derruba a resposta', async () => {
    repo.resgatesAbertos.mockRejectedValueOnce(new Error('pg fora'));
    repo.escaladasPorRep.mockRejectedValueOnce(new Error('pg fora'));
    bi.faturadoCanalPorVendedor.mockRejectedValueOnce(new Error('bi fora'));
    repo.emNegociacaoPorRep.mockRejectedValueOnce(new Error('pg fora'));
    const r = await service.visaoGeral(2026, 11);
    expect(r.alertas.map((a) => a.tipo)).toEqual(['CURVA_A_SEM_COMPRA']);
    expect(r.kpis.em_negociacao).toEqual({ valor: 0, quantidade: 0 });
    expect(r.kpis.clientes).toEqual({ pool: 1, carteira: 2 });
  });
});

describe('GestaoService.equipe', () => {
  // 25 dias úteis, 11 fechados: previsão = até ontem ÷ 11 × 25.
  const porVendedor = [
    { rep_codigo: 1, rep_nome: 'A', total: 110_000, ate_ontem: 104_500 }, // 237,5 mil / 250 mil = 95% → em risco
    { rep_codigo: 2, rep_nome: 'B', total: 92_000, ate_ontem: 90_000 }, // 204,5 mil / 190 mil → vai bater
    { rep_codigo: 4, rep_nome: 'D', total: 30_000, ate_ontem: 30_000 }, // 68,2 mil / 100 mil → não bate
    { rep_codigo: 9, rep_nome: 'VAREJO', total: 20_000, ate_ontem: 20_000 }, // rep do varejo com nota no canal
    { rep_codigo: 777, rep_nome: 'INATIVO', total: 10_000, ate_ontem: 10_000 },
  ];
  const bi = {
    diasUteisPeriodo: jest.fn(async () => ({ inicio: '2026-10-26', fim: '2026-11-25', dias: DIAS })),
    faturadoCanalPorVendedor: jest.fn(async () => porVendedor),
    vendedoresAtivosComissao: jest.fn(async () => [
      { rep_codigo: 1, nome: 'A', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 2, nome: 'B', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 3, nome: 'AUX', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 4, nome: 'D', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 9, nome: 'VAREJO', papel: 'VENDEDOR', local_venda: 'VAREJO' },
    ]),
  };
  type Fechado = { id: string; numero: number; rep_codigo: number; cli_codigo: number; desfecho_em: Date; total: number };
  type Linha = { empresa: number; serie: string; nfs: number; emissao: Date; rep_codigo: number; quantidade: number; liquido: number; devolucao: boolean };
  let fechados: Fechado[] = [];
  /** Casamento do extrato da bolsa por rep do orçamento (OrcamentoService.casamentoDoRep). */
  let casamentos: Map<number, { linhas: Linha[]; porOrcamento: Map<string, Array<{ linha: number; quantidade: number }>> }>;
  const repo = {
    listarMetasPeriodo: jest.fn(async () => [
      { rep_codigo: 1, valor_meta: 250_000 },
      { rep_codigo: 2, valor_meta: 190_000 },
      { rep_codigo: 3, valor_meta: 130_000 },
      { rep_codigo: 4, valor_meta: 100_000 },
    ]),
    orcamentosFechadosNoMes: jest.fn(async () => fechados),
    emNegociacaoPorRep: jest.fn(async () => [
      { rep_codigo: 1, valor: 40_000, quantidade: 3 },
      { rep_codigo: 3, valor: 5_000, quantidade: 1 },
    ]),
  };
  const esforco = { janela: { desde: '2026-11-09', ate: HOJE }, vendedores: [] };
  const supervisao = { esforco: jest.fn(async () => esforco) };
  const orcamento = {
    casamentoDoRep: jest.fn(async (rep: number) => casamentos.get(rep) ?? { linhas: [], porOrcamento: new Map() }),
  };
  const service = new GestaoService(
    bi as unknown as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    supervisao as unknown as SupervisaoService,
    orcamento as unknown as OrcamentoService,
  );

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(`${HOJE}T15:00:00Z`),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    fechados = [];
    casamentos = new Map();
  });
  afterEach(() => jest.useRealTimers());

  /** Auxiliar 3 fecha três orçamentos: dois saem em nota nos vendedores 1 e 2, um ainda sem nota. */
  const comAuxiliar = () => {
    fechados = [
      { id: 'o1', numero: 101, rep_codigo: 3, cli_codigo: 50, desfecho_em: new Date('2026-11-03T15:00:00Z'), total: 20_000 },
      { id: 'o2', numero: 102, rep_codigo: 3, cli_codigo: 60, desfecho_em: new Date('2026-11-05T15:00:00Z'), total: 15_000 },
      { id: 'o3', numero: 103, rep_codigo: 3, cli_codigo: 70, desfecho_em: new Date('2026-11-06T15:00:00Z'), total: 8_000 },
      { id: 'o4', numero: 104, rep_codigo: 1, cli_codigo: 80, desfecho_em: new Date('2026-11-06T15:00:00Z'), total: 9_000 }, // vendedor: não é auxiliar
    ];
    const linha = (nfs: number, rep: number, dia: string, quantidade: number, liquido: number): Linha => ({
      empresa: 3, serie: '1', nfs, emissao: new Date(`${dia}T00:00:00`), rep_codigo: rep, quantidade, liquido, devolucao: false,
    });
    // o1: NF 100 do vendedor 1, em dois produtos; o2: metade da linha da NF 101 do vendedor 2; o3: nada casou.
    casamentos.set(3, {
      linhas: [linha(100, 1, '2026-11-04', 10, 12_000), linha(100, 1, '2026-11-04', 4, 7_800), linha(101, 2, '2026-11-05', 20, 30_000)],
      porOrcamento: new Map([
        ['o1', [{ linha: 0, quantidade: 10 }, { linha: 1, quantidade: 4 }]],
        ['o2', [{ linha: 2, quantidade: 10 }]],
      ]),
    });
  };

  it('auxiliar com notas em dois vendedores: vendeu, por_vendedor e veio_dos_auxiliares fecham; faturado do canal não muda', async () => {
    const sem = await service.equipe(2026, 11);
    comAuxiliar();
    const r = await service.equipe(2026, 11);

    expect(r.auxiliares).toHaveLength(1);
    const a = r.auxiliares[0];
    expect(a).toMatchObject({ rep_codigo: 3, rep_nome: 'AUX', orcamentos_fechados: 3, vendeu: 34_800, meta: 130_000, pct_da_meta: 26.8 });
    expect(a.sem_nota).toEqual({ valor: 8_000, quantidade: 1 });
    expect(a.por_vendedor).toEqual([
      { rep_codigo: 1, rep_nome: 'A', valor: 19_800 },
      { rep_codigo: 2, rep_nome: 'B', valor: 15_000 },
    ]);
    expect(a.orcamentos.find((o) => o.id === 'o1')!.notas).toEqual([
      { empresa: 3, serie: '1', nfs: 100, emissao: '2026-11-04', valor: 19_800, rep_codigo: 1, rep_nome: 'A' },
    ]);
    expect(a.orcamentos.find((o) => o.id === 'o3')!.notas).toEqual([]);

    const veio = Object.fromEntries(r.vendedores.map((v) => [v.rep_codigo, v.veio_dos_auxiliares]));
    expect(veio).toEqual({ 1: 19_800, 2: 15_000, 4: 0 });
    expect(a.por_vendedor.reduce((s, v) => s + v.valor, 0)).toBe(r.vendedores.reduce((s, v) => s + v.veio_dos_auxiliares, 0));
    expect(r.totais).toMatchObject({ vendido_auxiliares: 34_800, meta_auxiliares: 130_000 });
    expect(r.totais.faturado_canal).toBe(sem.totais.faturado_canal);
    expect(r.totais.outros).toBe(sem.totais.outros);
    expect(orcamento.casamentoDoRep).toHaveBeenCalledWith(3);
    expect(orcamento.casamentoDoRep).not.toHaveBeenCalledWith(1);
  });

  it('auxiliar com nota no próprio código no mês vai para vendedores', async () => {
    comAuxiliar();
    bi.faturadoCanalPorVendedor.mockResolvedValueOnce([...porVendedor, { rep_codigo: 3, rep_nome: 'AUX', total: 5_000, ate_ontem: 5_000 }]);
    const r = await service.equipe(2026, 11);
    expect(r.auxiliares).toEqual([]);
    expect(r.vendedores.map((v) => v.rep_codigo)).toContain(3);
    expect(r.totais.vendido_auxiliares).toBe(0);
  });

  it('vendedores + outros fecham com o faturado do canal; rep ativo sem nota fica fora', async () => {
    const r = await service.equipe(2026, 11, '2026-11-02', '2026-11-08');
    expect(r.vendedores.map((v) => v.rep_codigo)).toEqual([1, 2, 4]);
    expect(r.totais.faturado_canal).toBe(262_000);
    expect(r.totais.outros).toBe(30_000);
    expect(r.vendedores.reduce((s, v) => s + v.faturado, 0) + r.totais.outros).toBe(r.totais.faturado_canal);
    expect(r.totais.meta_canal).toBe(670_000);
    expect(r.totais.meta_vendedores).toBe(540_000);
    expect(r.totais.em_negociacao).toEqual({ valor: 45_000, quantidade: 4 });
    expect(r.vendedores[0].em_negociacao).toEqual({ valor: 40_000, quantidade: 3 });
    expect(r.vendedores[0].atingimento).toBe(44);
    expect(r.auxiliares).toEqual([]);
    expect(r.esforco).toBe(esforco);
    expect(supervisao.esforco).toHaveBeenLastCalledWith({ desde: '2026-11-02', ate: '2026-11-08' }, true);
    expect(bi.faturadoCanalPorVendedor).toHaveBeenLastCalledWith(2026, 11, HOJE);
  });

  it('fechamento (aoVivo) de mês encerrado mede a última semana do mês, sem reconciliar', async () => {
    await service.equipe(2026, 10, undefined, undefined, undefined, true);
    // fim do outubro comissional: 25/10/2026 (domingo) → semana de 19/10 a 25/10
    expect(supervisao.esforco).toHaveBeenLastCalledWith({ desde: '2026-10-19', ate: '2026-10-25' }, false);
  });

  it('veredito por vendedor nos três cortes, sem piso', async () => {
    const r = await service.equipe(2026, 11);
    const ver = Object.fromEntries(r.vendedores.map((v) => [v.rep_codigo, v.veredito]));
    expect(ver).toEqual({ 1: 'EM_RISCO', 2: 'VAI_BATER', 4: 'NAO_BATE' });
    expect(r.vendedores[0].previsao! / 1000).toBeCloseTo(237.5, 1);
    expect(r.totais).toMatchObject({ vao_bater: 1, em_risco: 1, nao_batem: 1 });
  });
});

describe('GestaoService.fechamento', () => {
  const linhas = new Map<string, Record<string, unknown>>();
  const repo = {
    usuarioVendas: jest.fn(async (id?: string) =>
      id === 'ger'
        ? { id, codigo: 'G1', nome: 'Gerente', setor: 'VENDAS', vendas_hub_inicial: 'GERENCIA' }
        : id
          ? { id, codigo: 'S1', nome: 'Sup', setor: 'VENDAS', vendas_hub_inicial: 'SUPERVISAO_ATACADO' }
          : null,
    ),
    gravarFechamentoAtacado: jest.fn(async (d: Record<string, unknown>) => {
      const chave = `${d.ano}-${d.mes}`;
      const linha = { id: (linhas.get(chave)?.id as string) ?? `id-${chave}`, ...d, fechado_em: new Date() };
      linhas.set(chave, linha);
      return linha;
    }),
    fechamentoAtacado: jest.fn(async (ano: number, mes: number) => linhas.get(`${ano}-${mes}`) ?? null),
  };
  const service = new GestaoService(
    {} as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    {} as SupervisaoService,
    {} as OrcamentoService,
  );
  let faturado: number;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(`${HOJE}T15:00:00Z`), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] });
    linhas.clear();
    faturado = 480_000;
    jest.spyOn(service, 'visaoGeral').mockImplementation(async (_a, _m, _u, comoGerencia) =>
      ({
        premio: { nivel_atual: 1, pontos: 70 },
        canal: { faturado, meta: 570_000 },
        ...(comoGerencia ? { gerencia: { markup: 1.5 } } : {}),
      }) as never,
    );
    jest.spyOn(service, 'equipe').mockResolvedValue({ vendedores: [] } as never);
  });
  afterEach(() => jest.useRealTimers());

  it('POST de quem não é gerência → 403', async () => {
    await expect(service.gerenteDoFechamento('sup')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.gerenteDoFechamento(undefined)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.gerenteDoFechamento('ger')).resolves.toBe('Gerente');
  });

  it('foto calculada como gerência; usuário comum lê sem gerencia, gerência lê com', async () => {
    await service.fechar(2026, 10, 'Gerente');
    expect(service.visaoGeral).toHaveBeenLastCalledWith(2026, 10, undefined, true);
    const comum = await service.fechamento(2026, 10, 'sup');
    expect('gerencia' in comum!.foto.visao_geral).toBe(false);
    expect(comum!.foto.equipe).toEqual({ vendedores: [] });
    const ger = await service.fechamento(2026, 10, 'ger');
    expect(ger!.foto.visao_geral.gerencia).toEqual({ markup: 1.5 });
    expect(await service.fechamento(2026, 9, 'ger')).toBeNull();
  });

  it('reapurar regrava a mesma linha com quem reapurou', async () => {
    const a = await service.fechar(2026, 10, 'agendamento');
    faturado = 490_000;
    const b = await service.fechar(2026, 10, 'Gerente');
    expect(linhas.size).toBe(1);
    expect(linhas.get('2026-10')).toMatchObject({ id: 'id-2026-10', venda: 490_000, fechado_por: 'Gerente', nivel: 1, pontos: 70, meta: 570_000 });
    expect(a.fechado_por).toBe('agendamento');
    expect(b).toMatchObject({ venda: 490_000, fechado_por: 'Gerente' });
  });

  it('mês que ainda não terminou → 400', async () => {
    await expect(service.fechar(2026, 11, 'Gerente')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('GestaoService: mês fechado lido da foto', () => {
  const periodo = { ano: 2026, mes: 10, fechado: false };
  const foto = {
    visao_geral: { periodo, canal: { faturado: 480_000 }, gerencia: { markup: 1.5 } },
    equipe: { periodo, vendedores: [{ rep_codigo: 1 }] },
  };
  const bi = new Proxy({}, { get: () => jest.fn(() => { throw new Error('BI não pode ser lido'); }) });
  const repo = {
    usuarioVendas: jest.fn(async (id?: string) => (id === 'ger' ? { id, setor: 'VENDAS', vendas_hub_inicial: 'GERENCIA' } : { id, setor: 'VENDAS', vendas_hub_inicial: 'SUPERVISAO_ATACADO' })),
    fechamentoAtacado: jest.fn(async () => ({ ano: 2026, mes: 10, nivel: 1, pontos: 70, venda: 480_000, meta: 570_000, fechado_em: new Date(), fechado_por: 'agendamento', foto })),
  };
  const supervisao = { esforco: jest.fn(async () => ({ janela: { desde: '2026-10-12', ate: '2026-10-18' }, vendedores: [] })) };
  const service = new GestaoService(
    bi as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    supervisao as unknown as SupervisaoService,
    {} as OrcamentoService,
  );

  beforeEach(() => jest.useFakeTimers({ now: new Date(`${HOJE}T15:00:00Z`), doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] }));
  afterEach(() => jest.useRealTimers());

  it('duas leituras devolvem a mesma foto sem tocar no BI; gerencia só para a gerência', async () => {
    const a = await service.visaoGeral(2026, 10, 'ger');
    const b = await service.visaoGeral(2026, 10, 'ger');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ periodo: { fechado: true }, canal: { faturado: 480_000 }, gerencia: { markup: 1.5 } });
    expect('gerencia' in (await service.visaoGeral(2026, 10, 'sup'))).toBe(false);
    const e = await service.equipe(2026, 10, undefined, undefined, 'sup');
    expect(e).toMatchObject({ periodo: { fechado: true }, vendedores: [{ rep_codigo: 1 }] });
    expect(foto.visao_geral.periodo.fechado).toBe(false);
    expect(supervisao.esforco).not.toHaveBeenCalled();
  });

  it('semana pedida num mês fechado: esforço dessa semana, medido sem reconciliar', async () => {
    const e = await service.equipe(2026, 10, '2026-10-12', '2026-10-18', 'sup');
    expect(supervisao.esforco).toHaveBeenLastCalledWith({ desde: '2026-10-12', ate: '2026-10-18' }, false);
    expect(e).toMatchObject({ periodo: { fechado: true }, vendedores: [{ rep_codigo: 1 }], esforco: { janela: { desde: '2026-10-12' } } });
  });
});
