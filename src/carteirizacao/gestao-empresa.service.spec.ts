import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GestaoEmpresaService } from './gestao-empresa.service';
import { GestaoService } from './gestao.service';
import { CarteirizacaoController } from './carteirizacao.controller';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { MssqlService } from '../common/mssql/mssql.service';
import { SoPeloProxy } from '../common/so-pelo-proxy.guard';
import { hojeYmd } from './supervisao.indicadores';

describe('GestaoEmpresaService.empresa', () => {
  let hub: string;
  const hoje = hojeYmd();
  const repo = {
    usuarioVendas: jest.fn(async () => ({ id: 'u1', codigo: 'G', nome: 'Gerente', setor: 'VENDAS', vendas_hub_inicial: hub, vendas_rep_codigo: null })),
    listarMetasPeriodo: jest.fn(async () => [{ rep_codigo: 1, valor_meta: '200000.00' }]),
  };
  const bi = {
    diasUteisPeriodo: jest.fn(async () => null),
    vendaVendedoresPorDia: jest.fn(async () => [
      { rep: 1, dia: hoje, nome: 'ANA', venda: 1_000, servico: 0, custo: 600, lucro: 400, notas: 2 },
      { rep: 2, dia: hoje, nome: 'BIA', venda: 500, servico: 200, custo: 300, lucro: 200, notas: 1 },
    ]),
    metasDw: jest.fn(async () => [{ cod_vendedor: 2, vendedor: 'BIA', valor_total: 100_000 }]),
    papeisPorRep: jest.fn(async () => [
      { rep_codigo: 1, papel: 'VENDEDOR_ATACADO', inativo: false },
      { rep_codigo: 2, papel: 'VENDEDOR', inativo: false },
    ]),
    vendedoresAtivosComissao: jest.fn(async () => [
      { rep_codigo: 1, nome: 'Ana', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' },
      { rep_codigo: 2, nome: 'Bia', papel: 'VENDEDOR', local_venda: 'VAREJO' },
    ]),
  };
  // Resposta do BI pelo SQL do catálogo que chegou.
  const respostaBi = async (texto: string) => {
      if (texto.includes('conversao_rel'))
        return { colunas: [{ name: 'conversao_rel' }, { name: 'qtd_vendas' }, { name: 'qtd_orcamentos' }], linhas: [[0.25, 20, 80]] };
      if (texto.includes('razao_percentual'))
        return {
          colunas: [{ name: 'clientes_unicos' }, { name: 'clientes_carteira' }, { name: 'razao_fracionaria' }, { name: 'razao_percentual' }],
          linhas: [[30, 120, 0.25, 25]],
        };
      return { colunas: [{ name: 'count' }], linhas: [[80]] };
  };
  const mssql = { queryLinhas: jest.fn(respostaBi) };
  // GestaoService real: validarPeriodo e montarPeriodo não usam as dependências.
  const gestao = new GestaoService({} as never, {} as never, {} as never, {} as never);
  const service = new GestaoEmpresaService(
    repo as unknown as CarteirizacaoPrismaRepository,
    bi as unknown as CarteirizacaoSqlServerRepository,
    gestao,
    mssql as unknown as MssqlService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mssql.queryLinhas.mockImplementation(respostaBi);
    hub = 'GERENCIA';
  });

  it('critério 6: supervisão do atacado → 403', async () => {
    hub = 'SUPERVISAO_ATACADO';
    await expect(service.empresa(undefined, undefined, 'u1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(bi.vendaVendedoresPorDia).not.toHaveBeenCalled();
  });

  it('sem usuário → 403', async () => {
    repo.usuarioVendas.mockResolvedValueOnce(null as never);
    await expect(service.empresa()).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('critério 6: mês que ainda não começou → 400', async () => {
    await expect(service.empresa(2099, 1, 'u1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('gerência → todos os blocos', async () => {
    const r = await service.empresa(undefined, undefined, 'u1');
    expect(r.avisos).toEqual([]);
    expect(r.periodo).toMatchObject({ fechado: false });
    expect(r.vendedores!.map((v) => [v.rep_codigo, v.meta, v.faturado, v.canal])).toEqual([
      [1, 200_000, 1_000, 'atacado'],
      [2, 100_000, 500, 'varejo'],
    ]);
    expect(r.empresa).toMatchObject({ meta: 300_000, faturado: 1_500, faturado_hoje: 1_500 });
    expect(r.kpis).toMatchObject({ lucro_bruto: 600, vendas: 3 });
    expect(r.canais).not.toBeNull();
    expect(r.serie).not.toBeNull();
    expect(r.orcamentos).toEqual({ quantidade: 80, convertidos: 20, pct: 25 });
    expect(r.clientes).toEqual({ carteira: 120, com_venda: 30, pct: 25 });
    expect(typeof r.gerado_em).toBe('string');
    // Catálogo sem filtro: lista vazia vira `1 = 1` (empresa toda).
    for (const [texto] of mssql.queryLinhas.mock.calls) expect(texto).not.toContain('{{');
  });

  it('critério 7: orçamentos fora → null com aviso; os outros blocos vêm', async () => {
    mssql.queryLinhas.mockImplementation(async (texto: string) => {
      if (texto.includes('razao_percentual'))
        return { colunas: [{ name: 'clientes_unicos' }, { name: 'clientes_carteira' }, { name: 'razao_percentual' }], linhas: [[30, 120, 25]] };
      throw new Error('BI fora do ar: host 10.0.0.1');
    });
    const r = await service.empresa(undefined, undefined, 'u1');
    expect(r.orcamentos).toBeNull();
    expect(r.avisos).toEqual([{ bloco: 'orcamentos', motivo: 'indisponível' }]);
    expect(r.vendedores).not.toBeNull();
    expect(r.empresa).not.toBeNull();
    expect(r.clientes).toEqual({ carteira: 120, com_venda: 30, pct: 25 });
  });

  it('venda fora → vendedores, canais, empresa, kpis e série null com aviso', async () => {
    bi.vendaVendedoresPorDia.mockRejectedValueOnce(new Error('timeout'));
    const r = await service.empresa(undefined, undefined, 'u1');
    expect([r.vendedores, r.canais, r.empresa, r.kpis, r.serie]).toEqual([null, null, null, null, null]);
    expect(r.avisos).toEqual([{ bloco: 'venda', motivo: 'indisponível' }]);
  });
});

describe('rota gestao/empresa', () => {
  it('critério 6: só responde pelo proxy (SoPeloProxy)', () => {
    const guards = Reflect.getMetadata('__guards__', CarteirizacaoController.prototype.gestaoEmpresa);
    expect(guards).toContain(SoPeloProxy);
  });
});
