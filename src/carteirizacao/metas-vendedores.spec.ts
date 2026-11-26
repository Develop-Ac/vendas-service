import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoErpRepository } from './carteirizacao.erp.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { veioPeloProxy } from '../common/so-pelo-proxy.guard';

/**
 * GET /carteirizacao/metas: lucro, lucratividade e markup por vendedor só saem para a
 * gerência. Supervisão, vendedor e chamada sem usuário recebem os três campos nulos.
 */
describe('metasVendedores — quem vê lucro e markup', () => {
  const usuarios: Record<string, { vendas_hub_inicial: string | null; setor: string | null }> = {
    gerente: { vendas_hub_inicial: 'GERENCIA', setor: 'VENDAS' },
    diretor: { vendas_hub_inicial: null, setor: 'DIRETORIA' },
    supervisor: { vendas_hub_inicial: 'SUPERVISAO_ATACADO', setor: 'VENDAS' },
    vendedor: { vendas_hub_inicial: 'ATACADO', setor: 'VENDAS' },
  };
  const sql = {
    periodoComissional: jest.fn(async () => ({ data_inicio: '2026-10-26', data_fim: '2026-11-25', dias_uteis_total: 22, dias_uteis_decorridos: 11 })),
    vendedoresAtivosComissao: jest.fn(async () => [{ rep_codigo: 10, nome: 'ANA' }]),
    metasDw: jest.fn(async () => [{ cod_vendedor: 10, vendedor: 'ANA', valor_total: 100_000 }]),
    realizadoVendedores: jest.fn(async () => [{ vendedor_venda: 10, nome: 'ANA', realizado: 50_000, pedidos: 20, lucro: 15_000, custo: 35_000 }]),
    papeisPorRep: jest.fn(async () => [{ rep_codigo: 10, papel: 'VENDEDOR', inativo: 0 }]),
    equipeAtacadoReps: jest.fn(async () => [10]),
  };
  const overlay = {
    listarMetasPeriodo: jest.fn(async () => []),
    usuarioVendas: jest.fn(async (id: string) => usuarios[id] ?? null),
  };
  const service = new CarteirizacaoService(
    sql as unknown as CarteirizacaoSqlServerRepository,
    {} as CarteirizacaoErpRepository,
    overlay as unknown as CarteirizacaoPrismaRepository,
  );
  const linha = async (usuario?: string, canal?: string) => {
    const r = await service.metasVendedores(2026, 11, canal, usuario);
    return { ve_margem: r.ve_margem, ...r.vendedores[0] };
  };

  it.each(['gerente', 'diretor'])('%s recebe lucro, lucratividade e markup', async (quem) => {
    const l = await linha(quem);
    expect(l.ve_margem).toBe(true);
    expect(l).toMatchObject({ lucro: 15_000, lucratividade_pct: 30 });
    expect(l.markup_pct).toBeCloseTo(42.857, 2);
  });

  it.each([['supervisor', 'atacado'], ['supervisor', undefined], ['vendedor', undefined], ['quem-nao-existe', undefined], [undefined, 'gerencia']])(
    'usuário %s, canal %s: os três campos vêm nulos',
    async (quem, canal) => {
      const l = await linha(quem, canal);
      expect(l.ve_margem).toBe(false);
      expect(l).toMatchObject({ lucro: null, lucratividade_pct: null, markup_pct: null });
      // o que não é sensível continua vindo
      expect(l).toMatchObject({ meta: 100_000, realizado: 50_000, atingimento_pct: 50 });
      expect(l.projecao).toBeCloseTo(100_000, 2);
    },
  );

  it('o x-user-id só vale com o token do proxy', () => {
    const antes = process.env.APP_TOKEN;
    process.env.APP_TOKEN = 'segredo';
    expect(veioPeloProxy('segredo')).toBe(true);
    expect(veioPeloProxy('outro')).toBe(false);
    expect(veioPeloProxy(undefined)).toBe(false);
    process.env.APP_TOKEN = '';
    expect(veioPeloProxy('')).toBe(false);
    process.env.APP_TOKEN = antes;
  });
});
