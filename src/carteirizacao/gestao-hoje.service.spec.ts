import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { GestaoHojeService } from './gestao-hoje.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { CarteirizacaoService } from './carteirizacao.service';
import { GestaoService } from './gestao.service';
import { SupervisaoService } from './supervisao.service';
import { MssqlService } from '../common/mssql/mssql.service';
import { chavesProibidas } from './painel-vendedor';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';
import { cliente } from '../../test/mocks/cliente-carteira';

jest.mock('../common/analytics/analytics-atacado', () => ({ analyticsAtacadoGet: jest.fn() }));
const analytics = analyticsAtacadoGet as jest.Mock;

/** Todas as chaves do objeto, em qualquer nível. */
const chaves = (o: unknown): string[] =>
  Array.isArray(o) ? o.flatMap(chaves) : o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => [k, ...chaves(v)]) : [];

describe('GestaoHojeService.hoje', () => {
  let hub: string;
  // Margem e lucro existem na origem e não podem sair.
  const clientes = [
    cliente({ cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 40, faturamento_12m: 120_000, margem_custo_pct: 31, lucro_12m: 9_000 }),
    cliente({ cli_codigo: 2, curva_abc: 'B', faturamento_12m: 60_000, margem_custo_pct: 28, lucro_12m: 4_000 }),
    cliente({ cli_codigo: 3, curva_abc: 'A', faturamento_12m: 240_000, margem_custo_pct: 25, lucro_12m: 7_000 }),
  ];
  const repo = {
    usuarioVendas: jest.fn(async () => ({ id: 'u1', codigo: 'G', nome: 'Gestor', setor: 'VENDAS', vendas_hub_inicial: hub, vendas_rep_codigo: null })),
    resgatesAbertos: jest.fn(async () => [
      { cli_codigo: 1, cli_nome: 'C1', rep_codigo: 10, rep_nome: 'V', curva: 'A', estagio: 'CONTATO', faturamento_total: 1, aberto_em: new Date() },
    ]),
    tarefasEscaladas: jest.fn(async () => [
      { cli_codigo: 2, cli_nome: 'C2', rep_codigo: 10, rep_nome: 'V', curva: 'B', motivo_geracao: 'x', escalada_em: new Date() },
    ]),
    orcamentosParaRetornar: jest.fn(async () => [
      { id: 'o1', numero: 101, cli_codigo: 1, cli_nome: 'C1', total: 900, status: 'ADIADO', retorno_em: new Date('2026-11-01T00:00:00Z'),
        validade: null, piso_bolsa: 1, rep_codigo: 10, rep_nome: 'V' },
    ]),
  };
  const carteirizacao = {
    orcamentosSemDesfecho: jest.fn(async () => ({ itens: [] })),
    painelSupervisao: jest.fn(async () => ({ vendedores: ['ANA', 'BIA'], data_inicio: '2026-10-26', data_fim: '2026-11-25' })),
    vendedoresAtivosAtacado: jest.fn(async () => new Set([10])),
  };
  const avisosVendas = { usuariosDoRep: jest.fn(async (): Promise<string[]> => ['uv10']), avisoDoGestor: jest.fn() };
  const mssql = {
    queryLinhas: jest.fn(async () => ({
      colunas: [{ name: 'mix' }, { name: 'faixa' }, { name: 'valor_comissao' }],
      linhas: [[1, 'A', 100], [1, 'TOTAL', 100], [99, 'TOTAL GERAL', 1_234.5]] as unknown[][],
    })),
  };
  const gestao = {
    validarPeriodo: jest.fn(() => ({ ano: 2026, mes: 11, hoje: '2026-11-25', padrao: { inicio: '2026-10-26', fim: '2026-11-25' } })),
    motivosPerda: jest.fn(async (mes: string) => ({
      mes, quantidade: 3, valor: 5_000, motivos: [{ motivo: 'PRECO', pct: 60 }], orcamentos: [{ custo: 1 }],
    })),
  };
  const supervisao = {
    indicadoresDoMes: jest.fn(async () => ({
      kpis: [{ chave: 'RECUPERACAO_AB_PCT', detalhe: { fechados: 12, recuperados: 7 } }],
      clientes,
    })),
  };
  const erp = { faturamentoPorClientePeriodo: jest.fn(async () => new Map([[1, 500]])) };
  const service = new GestaoHojeService(
    repo as unknown as CarteirizacaoPrismaRepository,
    carteirizacao as unknown as CarteirizacaoService,
    gestao as unknown as GestaoService,
    supervisao as unknown as SupervisaoService,
    erp as unknown as CarteirizacaoErpRepository,
    mssql as unknown as MssqlService,
    avisosVendas as unknown as AvisosVendasService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    hub = 'SUPERVISAO_ATACADO';
    analytics.mockResolvedValue([{ cli: 1, dias_sem_compra: 40, intervalo_dias: 20 }]);
  });

  it('403 para vendedor do atacado', async () => {
    hub = 'ATACADO';
    await expect(service.hoje('u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('monta os cinco blocos', async () => {
    const r = await service.hoje('u1');
    expect(r.avisos).toEqual([]);
    expect(r.recuperacao).toMatchObject({ fechados: 12, recuperados: 7, total: 1 });
    expect(r.curva_a_sem_compra).toMatchObject({ curva_a: 2, comprando: 1, itens: [expect.objectContaining({ cli_codigo: 3 })] });
    expect(r.em_risco!.itens.map((i) => [i.cli_codigo, i.motivo])).toEqual([[1, 'FORA_DO_CICLO'], [2, 'ESCALADO']]);
    expect(r.orcamentos!.itens).toEqual([expect.objectContaining({ numero: 101, rep_codigo: 10, motivo: 'RETORNO' })]);
    expect(r.perdidos).toEqual({ mes: '2026-11', quantidade: 3, valor: 5_000, principal_motivo: 'PRECO', pct: 60 });
    expect(repo.orcamentosParaRetornar).toHaveBeenCalledWith(null, expect.any(Date));
    expect(erp.faturamentoPorClientePeriodo).toHaveBeenCalledWith('2026-10-26', '2026-11-25');
  });

  it('critério 10: serviço de análise fora → em risco só com escalados e aviso; demais blocos normais', async () => {
    analytics.mockResolvedValue(null);
    const r = await service.hoje('u1');
    expect(r.em_risco!.itens.map((i) => [i.cli_codigo, i.motivo])).toEqual([[2, 'ESCALADO']]);
    expect(r.avisos).toEqual([{ bloco: 'em_risco.ciclo', motivo: 'indisponível' }]);
    expect(r.recuperacao).not.toBeNull();
    expect(r.curva_a_sem_compra).not.toBeNull();
    expect(r.orcamentos).not.toBeNull();
    expect(r.perdidos).not.toBeNull();
  });

  it('ERP fora: curva A sem compra null com aviso; os outros blocos vêm', async () => {
    erp.faturamentoPorClientePeriodo.mockRejectedValueOnce(new Error('ERP fora do ar'));
    const r = await service.hoje('u1');
    expect(r.curva_a_sem_compra).toBeNull();
    expect(r.avisos).toEqual([{ bloco: 'curva_a_sem_compra', motivo: 'indisponível' }]);
    expect(r.recuperacao).not.toBeNull();
    expect(r.em_risco).not.toBeNull();
    expect(r.orcamentos).not.toBeNull();
    expect(r.perdidos).not.toBeNull();
  });

  it('critério 4: nenhuma chave de custo, markup, margem, lucro ou prêmio', async () => {
    const r = await service.hoje('u1');
    expect(chavesProibidas(r)).toEqual([]);
    expect(chaves(r).filter((k) => /premio/i.test(k))).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('piso');
  });

  it('critério 16: supervisão → comissão da linha TOTAL GERAL (mix 99), com a equipe e o período do painel', async () => {
    const r = await service.hoje('u1');
    expect(r.comissao).toEqual({ atual: 1_234.5 });
    const [texto, params] = mssql.queryLinhas.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params).toMatchObject({ de: '2026-10-26', ate: '2026-11-25' });
    expect(Object.values(params)).toEqual(expect.arrayContaining(['ANA', 'BIA']));
    expect(texto).not.toContain('{{');
  });

  it('critério 16: gerência → comissão null sem consultar o BI', async () => {
    hub = 'GERENCIA';
    const r = await service.hoje('u1');
    expect(r.comissao).toBeNull();
    expect(r.avisos).toEqual([]);
    expect(mssql.queryLinhas).not.toHaveBeenCalled();
    expect(carteirizacao.painelSupervisao).not.toHaveBeenCalled();
  });

  it('BI fora → comissão null com aviso; os outros blocos vêm', async () => {
    mssql.queryLinhas.mockRejectedValueOnce(new Error('BI fora do ar'));
    const r = await service.hoje('u1');
    expect(r.comissao).toBeNull();
    expect(r.avisos).toEqual([{ bloco: 'comissao', motivo: 'indisponível' }]);
    expect(r.recuperacao).not.toBeNull();
    expect(r.curva_a_sem_compra).not.toBeNull();
    expect(r.em_risco).not.toBeNull();
    expect(r.orcamentos).not.toBeNull();
    expect(r.perdidos).not.toBeNull();
  });

  it('equipe vazia → comissão null com aviso, sem consultar (lista vazia seria a empresa toda)', async () => {
    carteirizacao.painelSupervisao.mockResolvedValueOnce({ vendedores: [], data_inicio: '2026-10-26', data_fim: '2026-11-25' });
    const r = await service.hoje('u1');
    expect(r.comissao).toBeNull();
    expect(r.avisos).toEqual([{ bloco: 'comissao', motivo: 'indisponível' }]);
    expect(mssql.queryLinhas).not.toHaveBeenCalled();
  });
});

describe('GestaoHojeService.avisarVendedor', () => {
  let hub: string;
  const repo = {
    usuarioVendas: jest.fn(async () => ({ id: 'u1', codigo: 'G', nome: 'Gestor', setor: 'VENDAS', vendas_hub_inicial: hub, vendas_rep_codigo: null })),
  };
  const carteirizacao = { vendedoresAtivosAtacado: jest.fn(async () => new Set([10])) };
  const avisosVendas = { usuariosDoRep: jest.fn(async (): Promise<string[]> => ['uv10']), avisoDoGestor: jest.fn() };
  const service = new GestaoHojeService(
    repo as unknown as CarteirizacaoPrismaRepository,
    carteirizacao as unknown as CarteirizacaoService,
    {} as GestaoService,
    {} as SupervisaoService,
    {} as CarteirizacaoErpRepository,
    {} as MssqlService,
    avisosVendas as unknown as AvisosVendasService,
  );
  const corpo = { rep_codigo: 10, texto: '  Ligue para o cliente 123 hoje  ', canais: ['badge', 'whatsapp'] };

  beforeEach(() => {
    jest.clearAllMocks();
    hub = 'SUPERVISAO_ATACADO';
  });

  it('403 para vendedor do atacado', async () => {
    hub = 'ATACADO';
    await expect(service.avisarVendedor('u1', corpo)).rejects.toBeInstanceOf(ForbiddenException);
    expect(avisosVendas.avisoDoGestor).not.toHaveBeenCalled();
  });

  it('400 para vendedor fora da equipe ativa do atacado', async () => {
    await expect(service.avisarVendedor('u1', { ...corpo, rep_codigo: 99 })).rejects.toBeInstanceOf(BadRequestException);
    expect(avisosVendas.avisoDoGestor).not.toHaveBeenCalled();
  });

  it('409 quando o vendedor não tem usuário na intranet', async () => {
    avisosVendas.usuariosDoRep.mockResolvedValueOnce([]);
    await expect(service.avisarVendedor('u1', corpo)).rejects.toBeInstanceOf(ConflictException);
    expect(avisosVendas.avisoDoGestor).not.toHaveBeenCalled();
  });

  it('critério 13: envia o texto editado pelos dois canais, com o nome do gestor', async () => {
    await expect(service.avisarVendedor('u1', { ...corpo, link: '/vendas/estacao?cli=123' })).resolves.toEqual({ ok: true });
    expect(avisosVendas.avisoDoGestor).toHaveBeenCalledWith({
      usuarios: ['uv10'],
      gestor: 'Gestor',
      texto: 'Ligue para o cliente 123 hoje',
      canais: ['badge', 'whatsapp'],
      link: '/vendas/estacao?cli=123',
      ref: expect.stringMatching(/^10:\d+$/),
    });
  });
});
