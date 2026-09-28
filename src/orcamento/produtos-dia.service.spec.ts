import { ProdutosDiaService } from './produtos-dia.service';
import { OrcamentoService } from './orcamento.service';
import { OrcamentoBiRepository } from './orcamento.bi.repository';
import { OrcamentoPrismaRepository } from './orcamento.prisma.repository';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { ClienteDevido, montarProdutosDia } from './produtos-dia';

jest.mock('../common/analytics/analytics-atacado', () => ({ analyticsAtacadoGet: jest.fn() }));
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';
const analytics = analyticsAtacadoGet as jest.Mock;

/** Lote aberto mínimo: só o que a lista lê. */
const lote = (over: Partial<any>) => ({
  id: 1, pro_codigo: 100, descricao: 'FAROL', encerrado_em: null, vendedor: 50, restante: 100, estoque_disponivel: 100, ...over,
});
const giro = (over: Partial<any> = {}) => ({ grupo_chave: null, demanda_media_dia: 2, estoque_min_sugerido: 10, ...over });
const cli = (over: Partial<ClienteDevido>): ClienteDevido => ({
  cli_codigo: 1, cli_nome: 'CLI', cidade: 'CUIABA', uf: 'MT', rep_codigo: 7, dias_sem_compra: 40, qtd_por_compra: 2, proxima_esperada: '2026-09-28', status: 'atrasado', ...over,
});

describe('montarProdutosDia', () => {
  it('ordena por bolsa × demanda esperada e limita a 15', () => {
    const lotes = Array.from({ length: 20 }, (_, i) => lote({ id: i + 1, pro_codigo: i + 1, vendedor: 10 + i }));
    const g = new Map(lotes.map((l) => [l.pro_codigo, giro()]));
    const r = montarProdutosDia(lotes, g, new Map(), new Map());
    expect(r.itens).toHaveLength(15);
    expect(r.itens[0].pro_codigo).toBe(20); // maior bolsa, mesma demanda
    expect(r.itens.map((i) => i.posicao)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('clientes devidos somam à demanda e o giro do atacado substitui o de todos os canais', () => {
    const g = new Map([[100, giro({ grupo_chave: 'FAROL X' })], [200, giro()]]);
    const devidos = new Map([['G:FAROL X', [cli({ cli_codigo: 1, qtd_por_compra: 3 }), cli({ cli_codigo: 2, qtd_por_compra: null })]]]);
    const r = montarProdutosDia([lote({ id: 1, pro_codigo: 100, vendedor: 10 }), lote({ id: 2, pro_codigo: 200, vendedor: 30 })], g, new Map([[100, 1]]), devidos);
    const a = r.itens.find((i) => i.pro_codigo === 100)!;
    expect(a.chave_item).toBe('G:FAROL X');
    expect(a.giro_dia).toBe(1); // atacado, não os 2 de todos os canais
    expect(a.demanda_clientes).toBe(4); // 3 + 1 (sem qtd conhecida conta 1)
    expect(a.score).toBe(50);
    const b = r.itens.find((i) => i.pro_codigo === 200)!;
    expect(b.giro_dia).toBe(2); // sem perfil no analytics: demanda de todos os canais
    expect(b.score).toBe(60);
    expect(r.itens[0].pro_codigo).toBe(200);
  });

  it('cobertura curta ou ponto de pedido tiram o lote da lista e o registram como de fora', () => {
    const g = new Map([
      [1, giro({ demanda_media_dia: 10 })], // 100/10 = 10 dias < 15
      [2, giro({ estoque_min_sugerido: 150 })], // 100 <= 150
      [3, giro({ demanda_media_dia: null, estoque_min_sugerido: null })], // sem análise: entra
    ]);
    const r = montarProdutosDia([lote({ id: 1, pro_codigo: 1 }), lote({ id: 2, pro_codigo: 2 }), lote({ id: 3, pro_codigo: 3 })], g, new Map(), new Map());
    expect(r.itens.map((i) => i.pro_codigo)).toEqual([3]);
    expect(r.fora.map((i) => [i.pro_codigo, i.motivo_fora])).toEqual([[1, 'COBERTURA'], [2, 'PONTO_PEDIDO']]);
    expect(r.fora.every((i) => i.posicao === null)).toBe(true);
  });

  it('dois lotes no mesmo grupo viram uma linha, a de maior bolsa; até 5 clientes por linha', () => {
    const g = new Map([[1, giro({ grupo_chave: 'K' })], [2, giro({ grupo_chave: 'K' })]]);
    const devidos = new Map([['G:K', Array.from({ length: 8 }, (_, i) => cli({ cli_codigo: i + 1 }))]]);
    const r = montarProdutosDia([lote({ id: 1, pro_codigo: 1, vendedor: 5 }), lote({ id: 2, pro_codigo: 2, vendedor: 9 })], g, new Map(), devidos);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].lote_id).toBe(2);
    expect(r.itens[0].clientes).toHaveLength(5);
    expect(r.itens[0].clientes_total).toBe(8);
  });
});

describe('ProdutosDiaService', () => {
  let lotes: any[];
  let salvas: Array<{ data: string; itens: any[]; por: string | null }>;
  let semApuracao: any[];
  let apuradas: any[];
  let venda: Map<number, { qtd: number; valor: number }>;

  const orcamento = {
    listarOportunidades: jest.fn(async () => lotes),
    vendedores: jest.fn(async () => [{ rep_codigo: 7, rep_nome: 'JOAO', papel: null }]),
  } as unknown as OrcamentoService;
  const db = {
    giro: jest.fn(async (codigos: number[]) => new Map(codigos.map((c) => [c, { ...giro(), pro_codigo: c }]))),
    salvarProdutosDia: jest.fn(async (data: string, itens: any[], por: string | null) => {
      salvas.push({ data, itens, por });
    }),
    produtosDia: jest.fn(async () => (salvas.at(-1)?.itens ?? []).map((i: any, k: number) => ({ ...i, id: k + 1, gerado_em: new Date(), gerado_por: salvas.at(-1)?.por ?? null }))),
    produtosDiaSemApuracao: jest.fn(async () => semApuracao),
    apurarProdutosDia: jest.fn(async (rows: any[]) => {
      apuradas.push(...rows);
    }),
    datasProdutosDia: jest.fn(async () => []),
  } as unknown as OrcamentoPrismaRepository;
  const bi = { vendaAtacadoNoDia: jest.fn(async () => venda) } as unknown as OrcamentoBiRepository;
  const avisos = { produtosDia: jest.fn(async () => undefined) } as unknown as AvisosVendasService;
  const service = new ProdutosDiaService(orcamento, db, bi, avisos);

  beforeEach(() => {
    lotes = [];
    salvas = [];
    semApuracao = [];
    apuradas = [];
    venda = new Map();
    jest.clearAllMocks();
    analytics.mockImplementation(async (rota: string) => {
      if (rota.startsWith('/itens/devidos')) return { 'P:100': [cli({ cli_codigo: 1, rep_codigo: 7 })] };
      if (rota.startsWith('/produtos/100/')) return { vendas: { qtd_12m: 365 } };
      return null;
    });
  });

  it('gera, grava itens e lotes de fora, põe o nome do vendedor e avisa com o total', async () => {
    lotes = [lote({ id: 1, pro_codigo: 100 }), lote({ id: 2, pro_codigo: 200, restante: 5, estoque_disponivel: 5 }), lote({ id: 3, pro_codigo: 300, encerrado_em: '2026-09-01' })];
    const r = await service.gerar('2026-09-28', 'GABRIEL');
    expect(r.itens.map((i) => i.pro_codigo)).toEqual([100]);
    expect(r.fora.map((i) => i.pro_codigo)).toEqual([200]); // 5 unidades < 15 dias × 2/dia
    expect(r.itens[0].clientes[0].rep_nome).toBe('JOAO');
    expect(r.itens[0].giro_dia).toBe(1);
    expect(salvas).toHaveLength(1);
    expect(salvas[0].itens).toHaveLength(2);
    expect(salvas[0].por).toBe('GABRIEL');
    expect(avisos.produtosDia).toHaveBeenCalledWith('2026-09-28', { total: 1, bolsa: 150, fora: 1 });
  });

  it('analytics fora do ar: lista sai só por giro e bolsa, sem clientes', async () => {
    analytics.mockResolvedValue(null);
    lotes = [lote({ id: 1, pro_codigo: 100 })];
    const r = await service.gerar('2026-09-28', null);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].clientes).toEqual([]);
    expect(r.itens[0].giro_dia).toBe(2);
  });

  it('lista vazia não avisa; regenerar grava de novo o mesmo dia', async () => {
    lotes = [];
    await service.gerar('2026-09-28', null);
    expect(avisos.produtosDia).toHaveBeenCalledWith('2026-09-28', { total: 0, bolsa: 0, fora: 0 });
    // o emissor é quem cala com total 0; aqui garantimos que não gravamos nada além do dia
    lotes = [lote({ id: 1, pro_codigo: 100 })];
    await service.regenerar('ANA');
    expect(salvas).toHaveLength(2);
    expect(salvas[1].por).toBe('ANA');
  });

  it('apura a venda do atacado do dia da lista para cada item pendente', async () => {
    semApuracao = [
      { id: 11, data: '2026-09-26', pro_codigo: 100 },
      { id: 12, data: '2026-09-26', pro_codigo: 200 },
    ];
    venda = new Map([[100, { qtd: 4, valor: 812.4 }]]);
    const n = await service.apurar('2026-09-28');
    expect(n).toBe(2);
    expect(bi.vendaAtacadoNoDia).toHaveBeenCalledWith([100, 200], '20260926');
    expect(apuradas).toEqual([
      { id: 11, vendida_qtd: 4, vendida_valor: 812.4 },
      { id: 12, vendida_qtd: 0, vendida_valor: 0 },
    ]);
  });
});
