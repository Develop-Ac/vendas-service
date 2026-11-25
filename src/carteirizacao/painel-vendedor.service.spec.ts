import { PainelVendedorService } from './painel-vendedor.service';
import { GestaoService } from './gestao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoSqlServerRepository } from './carteirizacao.sqlserver.repository';
import { CarteirizacaoService } from './carteirizacao.service';
import { SupervisaoService } from './supervisao.service';
import { somarDias } from './supervisao.indicadores';
import { OrcamentoService } from '../orcamento/orcamento.service';
import { FilaService } from './fila.service';
import { OfertaRepository } from '../oferta/oferta.repository';
import { chavesProibidas } from './painel-vendedor';
import { cliente } from '../../test/mocks/cliente-carteira';

/** 25 dias úteis seguidos a partir de 26/10 (novembro comissional). */
const DIAS = Array.from({ length: 25 }, (_, i) => somarDias('2026-10-26', i));
const HOJE = DIAS[11]; // 12º dia útil

describe('PainelVendedorService.painel', () => {
  let biFora: boolean;
  const fora = async () => {
    throw new Error('BI fora do ar');
  };
  const bi = {
    diasUteisPeriodo: jest.fn(async () => (biFora ? fora() : { inicio: '2026-10-26', fim: '2026-11-25', dias: DIAS })),
    vendedoresAtivosComissao: jest.fn(async () =>
      biFora ? fora() : [{ rep_codigo: 1, nome: 'A', papel: 'VENDEDOR_ATACADO', local_venda: 'ATACADO' }],
    ),
    faturadoVendedorPorDia: jest.fn(async () => [
      { dia: DIAS[0], valor: 60_000 },
      { dia: DIAS[10], valor: 44_500 },
      { dia: HOJE, valor: 5_500 },
    ]),
    // Mesma venda do rep 1 vista pela gestão: total 110 mil, 104,5 mil até ontem.
    faturadoCanalPorVendedor: jest.fn(async () => [{ rep_codigo: 1, rep_nome: 'A', total: 110_000, ate_ontem: 104_500 }]),
  };
  const repo = {
    listarMetasPeriodo: jest.fn(async () => [{ rep_codigo: 1, valor_meta: 250_000 }]),
    orcamentosFechadosNoMes: jest.fn(async () => []),
    emNegociacaoPorRep: jest.fn(async () => []),
    retornosGeradosEntre: jest.fn(async () => []),
    orcamentosParaRetornar: jest.fn(async () => [
      { id: 'o1', numero: 101, cli_codigo: 7, cli_nome: 'C7', total: 900, status: 'ADIADO', retorno_em: new Date('2026-11-01T00:00:00Z'), validade: null, piso_bolsa: 1 },
    ]),
    ultimosOrcamentos: jest.fn(async () => [{ id: 'o1', numero: 101, cli_nome: 'C7', status: 'ADIADO', total: 900, created_at: new Date() }]),
  };
  // Carteira do rep 1: os campos de margem e lucro existem na origem e não podem sair.
  const snapshot = [
    cliente({ cli_codigo: 7, rep_codigo: 1, risco_inativacao: true, margem_custo_pct: 31, lucro_12m: 9_000 }),
    cliente({ cli_codigo: 8, rep_codigo: 1, risco_inativacao: true, margem_custo_pct: 28, lucro_12m: 4_000 }),
  ];
  const carteirizacao = {
    painelCarteira: jest.fn(async () => (biFora ? fora() : { clientes_carteira: 40, clientes_com_venda: 10, positivacao: 25 })),
    orcamentosComFechamento: jest.fn(async () => [
      { rep_codigo: 1, emissao: new Date(), emissao_ymd: DIAS[2], fechou: true },
      { rep_codigo: 1, emissao: new Date(), emissao_ymd: DIAS[3], fechou: false },
      { rep_codigo: 2, emissao: new Date(), emissao_ymd: DIAS[3], fechou: true }, // outro vendedor
      { rep_codigo: 1, emissao: new Date(), emissao_ymd: HOJE, fechou: false }, // carência não venceu
    ]),
    snapshotCarteira: jest.fn(async () => snapshot),
    orcamentosSemDesfecho: jest.fn(async () => ({
      itens: [
        { orcamento: 5001, origem: 'CELTA', intranet_id: null, numero_intranet: null, emissao: '2026-11-01', dias_desde_emissao: 9,
          cli_codigo: 8, cli_nome: 'C8', fone: null, total: 700, rep_codigo: 1, rep_nome: 'A', custo: 300 },
      ],
    })),
  };
  const fila = {
    listar: jest.fn(async () => ({
      itens: [{ id: 't1', tipo: 'RESGATE', status: 'ABERTA', cli_codigo: 7, cli_nome: 'C7', fone: '65', curva: 'A', motivo_geracao: 'x', score: 80, margem_custo_pct: 31 }],
      retornos: [{ cli_codigo: 9, cli_nome: 'C9', fone: null, rep_codigo: 1, rep_nome: 'A', prazo_em: '2026-11-12', atrasada: false,
        produtos: [{ id: 'r1', pro_codigo: 55, descricao: 'P55', quantidade_pedida: 2, saldo_na_geracao: 0, custo: 4 }] }],
    })),
  };
  let fonteIntranet: boolean;
  const ofertaRepo = { fonteIntranet: jest.fn(async () => fonteIntranet) };
  const produto = (pro_codigo: number, preco: number) => ({
    pro_codigo, descricao: 'P' + pro_codigo, preco_tabela: preco, custo: 10, custo_bolsa: 9,
    promocao: { data_final: '2026-11-30', tipo: 'LIQUIDACAO', restam: 3, limite_cliente: null, ganho_unit: 4, proxima_faixa: null },
  });
  const orcamento = {
    bolsa: jest.fn(async () => ({
      bolsa: { saldo: 1_200, premio_estimado: 300, custo: 1, piso: 2 },
      em_aberto: { quantidade: 2, total: 9_000, desconto: 100 },
      comissao: { atual: { comissao: 2_500 } },
      por_cliente: [],
    })),
    casamentoDoRep: jest.fn(async () => ({ linhas: [], porOrcamento: new Map() })),
    produtosEmOferta: jest.fn(async (t: string) => [produto(1, t === '2' ? 40 : 44)]),
  };
  const supervisao = { esforco: jest.fn(async () => ({ janela: {}, vendedores: [] })) };
  const gestao = new GestaoService(
    bi as unknown as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    supervisao as unknown as SupervisaoService,
    orcamento as unknown as OrcamentoService,
  );
  const service = new PainelVendedorService(
    bi as unknown as CarteirizacaoSqlServerRepository,
    repo as unknown as CarteirizacaoPrismaRepository,
    carteirizacao as unknown as CarteirizacaoService,
    gestao,
    orcamento as unknown as OrcamentoService,
    fila as unknown as FilaService,
    ofertaRepo as unknown as OfertaRepository,
  );

  beforeEach(() => {
    jest.useFakeTimers({
      now: new Date(`${HOJE}T15:00:00Z`),
      doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'],
    });
    biFora = false;
    fonteIntranet = true;
  });
  afterEach(() => jest.useRealTimers());

  it('critério 2: meta, faturado, previsão e veredito iguais aos da aba Equipe', async () => {
    const [r, equipe] = await Promise.all([service.painel(1), gestao.equipe()]);
    const v = equipe.vendedores.find((x) => x.rep_codigo === 1)!;
    expect(r.meta).toMatchObject({ sem_meta: false, meta: v.meta, faturado: v.faturado, previsao: v.previsao, veredito: v.veredito });
    expect(r.periodo).toMatchObject({ dias_uteis_total: 25, dias_uteis_fechados: 11, hoje_dia_util: true });
    expect(r.conversao).toEqual({ pct: 50, orcamentos: 2, fechados: 1, em_aberto: { quantidade: 2, total: 9_000 } });
    expect(r.bolsa).toEqual({ saldo: 1_200, premio_estimado: 300 });
    expect(r.comissao).toEqual({ atual: 2_500 });
    expect(r.avisos).toEqual([]);
    expect(orcamento.bolsa).toHaveBeenCalledTimes(1);
  });

  it('critério 5: BI fora do ar zera meta e positivação com aviso; os demais blocos vêm', async () => {
    biFora = true;
    const r = await service.painel(1);
    expect(r.meta).toBeNull();
    expect(r.positivacao).toBeNull();
    expect(r.avisos.map((a) => a.bloco).sort()).toEqual(['meta', 'positivacao']);
    expect(r.avisos[0].motivo).toBe('indisponível');
    expect(r.periodo.inicio).toBe('2026-10-26');
    expect(r.conversao).not.toBeNull();
    expect(r.bolsa).not.toBeNull();
    expect(r.comissao).not.toBeNull();
  });

  it('critério 6: nenhuma chave de custo, markup, margem ou lucro na resposta', async () => {
    const r = await service.painel(1);
    expect(chavesProibidas(r)).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('piso');
    expect(r.contatos!.map((c) => [c.tipo, c.cli_codigo])).toEqual([['RESGATE', 7], ['PRODUTO_CHEGOU', 9]]);
    expect(r.retornar!.map((o) => [o.motivo, o.numero])).toEqual([['RETORNO', 101], ['SEM_DESFECHO', 5001]]);
    // Cliente 7 está na fila: conta em risco, mas sai da lista.
    expect(r.carteira!.em_risco).toMatchObject({ total: 2, clientes: [expect.objectContaining({ cli_codigo: 8 })] });
    expect(r.ofertas!.ganho).toEqual([expect.objectContaining({ pro_codigo: 1, preco_atacado: 40, preco_especial: 44 })]);
    expect(r.ultimos).toHaveLength(1);
    expect(r.avisos).toEqual([]);
  });

  it('critério 12: oferta com fonte no Celta vem null, sem aviso', async () => {
    fonteIntranet = false;
    orcamento.produtosEmOferta.mockClear();
    const r = await service.painel(1);
    expect(r.ofertas).toBeNull();
    expect(r.avisos).toEqual([]);
    expect(orcamento.produtosEmOferta).not.toHaveBeenCalled();
  });

  it('monta a carteira uma vez só e passa o mesmo snapshot para a fila', async () => {
    carteirizacao.snapshotCarteira.mockClear();
    fila.listar.mockClear();
    await service.painel(1);
    expect(carteirizacao.snapshotCarteira).toHaveBeenCalledTimes(1);
    expect(fila.listar).toHaveBeenCalledWith({ rep_codigo: 1 }, snapshot);
  });

  it('ERP fora: retornar segue com os da intranet e registra aviso', async () => {
    carteirizacao.orcamentosSemDesfecho.mockRejectedValueOnce(new Error('ERP fora do ar'));
    const r = await service.painel(1);
    expect(r.retornar!.map((o) => o.motivo)).toEqual(['RETORNO']);
    expect(r.avisos).toEqual([{ bloco: 'retornar.sem_desfecho', motivo: 'indisponível' }]);
  });
});
