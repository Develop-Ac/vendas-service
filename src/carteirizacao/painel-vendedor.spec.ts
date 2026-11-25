import { blocoMeta, blocoMetaAuxiliar, blocoPeriodo, chavesProibidas, montarCarteira, montarOfertas, montarRetornar } from './painel-vendedor';
import type { ProdutoOrcamento } from '../orcamento/orcamento.service';
import { cliente } from '../../test/mocks/cliente-carteira';
import { diaDaSemana, somarDias } from './supervisao.indicadores';

/** Seg–sex a partir de `ini` (o BI manda a lista real; aqui basta o desenho). */
const uteis = (ini: string, n: number): string[] => {
  const r: string[] = [];
  for (let d = ini; r.length < n; d = somarDias(d, 1)) if (![0, 6].includes(diaDaSemana(d))) r.push(d);
  return r;
};

const DIAS = uteis('2026-11-02', 22);
const INICIO = '2026-11-01';
const FIM = DIAS[21];

describe('painel do vendedor — meta', () => {
  it('meta 130 mil, 14 dias fechados, 81,3 mil com 4,3 mil hoje → em risco', () => {
    const hoje = DIAS[14];
    const serie = [...DIAS.slice(0, 14).map((dia) => ({ dia, valor: 5500 })), { dia: hoje, valor: 4300 }];
    const m = blocoMeta({ meta: 130000, serie, diasUteis: DIAS, inicio: INICIO, fim: FIM, hoje });

    expect(m.faturado).toBe(81300);
    expect(m.venda_hoje).toBe(4300);
    expect(m.ritmo).toBe(5500);
    expect(m.previsao).toBe(121000);
    expect(Math.round(m.previsao_pct!)).toBe(93);
    expect(m.veredito).toBe('EM_RISCO');
    expect(m.falta).toBe(48700);
    expect(m.precisa_dia).toBeCloseTo(48700 / 7);
    expect(m.meta_dia).toBeCloseTo(5909.09, 1);
    expect(m.serie).toHaveLength(15);
    expect(m.serie[0]).toEqual({ dia: DIAS[0], valor: 5500, bateu: false });
    expect(m.serie[14]).toEqual({ dia: hoje, valor: 4300, bateu: false });

    const p = blocoPeriodo({ inicio: INICIO, fim: FIM, diasUteis: DIAS, hoje });
    expect(p).toEqual({
      inicio: INICIO,
      fim: FIM,
      dias_uteis_total: 22,
      dias_uteis_fechados: 14,
      dias_uteis_restantes: 7,
      hoje_dia_util: true,
    });
  });

  it('auxiliar sem meta própria mostra só o fechado do mês', () => {
    expect(blocoMetaAuxiliar(12345)).toEqual({ sem_meta: true, fechado_mes: 12345 });
  });

  it('nenhum dia útil fechado → ritmo, previsão e veredito nulos', () => {
    const hoje = DIAS[0];
    const m = blocoMeta({ meta: 130000, serie: [{ dia: hoje, valor: 2000 }], diasUteis: DIAS, inicio: INICIO, fim: FIM, hoje });
    expect(m.ritmo).toBeNull();
    expect(m.previsao).toBeNull();
    expect(m.previsao_pct).toBeNull();
    expect(m.veredito).toBeNull();
    expect(m.faturado).toBe(2000);
  });

  it('sem calendário → ritmo, previsão e veredito nulos', () => {
    const hoje = DIAS[5];
    const m = blocoMeta({ meta: 130000, serie: [{ dia: hoje, valor: 2000 }], diasUteis: [], inicio: INICIO, fim: FIM, hoje });
    expect(m.ritmo).toBeNull();
    expect(m.previsao).toBeNull();
    expect(m.veredito).toBeNull();
    expect(m.meta_dia).toBeNull();
    expect(m.serie).toEqual([]);
  });
});

describe('painel do vendedor — retornar', () => {
  const hoje = new Date('2026-11-24T00:00:00Z');
  const ontem = new Date('2026-11-23T00:00:00Z');
  const amanha = new Date('2026-11-25T00:00:00Z');

  it('adiado de ontem, enviado que vence amanhã e sem desfecho, nessa ordem e sem repetir', () => {
    const r = montarRetornar({
      hoje,
      fonePorCliente: new Map([[1, '65999990001']]),
      intranet: [
        { id: 'env', numero: 20, cli_codigo: 2, cli_nome: 'CLIENTE B', total: 200, status: 'ENVIADO', retorno_em: null, validade: amanha },
        { id: 'adi', numero: 10, cli_codigo: 1, cli_nome: 'CLIENTE A', total: 100, status: 'ADIADO', retorno_em: ontem, validade: null },
      ],
      semDesfecho: [
        // o mesmo orçamento enviado também caiu no sem desfecho: fica só em VENCE
        { orcamento: -20, origem: 'INTRANET', numero_intranet: 20, intranet_id: 'env', motivo_em: null, emissao: ontem, cli_codigo: 2, cli_nome: 'CLIENTE B', rep_codigo: 10, total: 200, dias_desde_emissao: 5 },
        { orcamento: 555, origem: 'CELTA', numero_intranet: null, intranet_id: null, motivo_em: null, emissao: ontem, cli_codigo: 3, cli_nome: 'CLIENTE C', rep_codigo: 10, rep_nome: 'VENDEDOR', total: 300, dias_desde_emissao: 4 },
      ],
    });

    expect(r.map((i) => [i.motivo, i.numero, i.cli_nome])).toEqual([
      ['RETORNO', 10, 'CLIENTE A'],
      ['VENCE', 20, 'CLIENTE B'],
      ['SEM_DESFECHO', 555, 'CLIENTE C'],
    ]);
    expect(r[0]).toMatchObject({ id: 'adi', fone: '65999990001', dias: 1 });
    expect(r[1].dias).toBe(1);
    expect(r[2]).toMatchObject({ id: null, sem_desfecho: { orcamento: 555, origem: 'CELTA', rep_nome: 'VENDEDOR' } });
  });
});

describe('painel do vendedor — carteira', () => {
  const inicioMes = '2026-11-01';
  const emRisco = (cli_codigo: number, curva_abc: 'A' | 'B', faturamento_12m: number) =>
    cliente({ cli_codigo, curva_abc, faturamento_12m, risco_inativacao: true, quadrante: 'TRABALHADA', data_ult_compra: new Date('2026-11-10') });

  it('cliente em risco que já está na fila: fora da lista, dentro da contagem', () => {
    const c = montarCarteira({ clientes: [emRisco(1, 'A', 10), emRisco(2, 'A', 5)], rep: 10, inicioMes, foraDaLista: new Set([1]) });
    expect(c.em_risco.total).toBe(2);
    expect(c.em_risco.clientes.map((x) => x.cli_codigo)).toEqual([2]);
  });

  it('7 em risco (3 A, 4 B): os 3 A e os 2 B de maior faturamento, total 7, sem margem nem lucro', () => {
    const clientes = [
      emRisco(1, 'B', 100), emRisco(2, 'A', 1), emRisco(3, 'B', 400), emRisco(4, 'A', 3),
      emRisco(5, 'B', 300), emRisco(6, 'A', 2), emRisco(7, 'B', 200),
      emRisco(8, 'A', 999), // outro vendedor
    ];
    clientes[7].rep_codigo = 99;
    const c = montarCarteira({ clientes, rep: 10, inicioMes, foraDaLista: new Set() });
    expect(c.em_risco.total).toBe(7);
    expect(c.em_risco.clientes.map((x) => x.cli_codigo)).toEqual([4, 6, 2, 3, 5]);
    expect(Object.keys(c.em_risco.clientes[0])).toEqual(
      ['cli_codigo', 'cli_nome', 'curva', 'fone', 'dias_sem_compra', 'data_ult_compra', 'faturamento_3m'],
    );
    expect(c.perda_silenciosa.total).toBe(0);
    expect(c.sem_compra_mes.total).toBe(0);
  });

  it('compra no 1º dia do mês comissional (DATE à meia-noite UTC) não é "sem compra no mês"', () => {
    const ativo = (cli_codigo: number, dia: string) =>
      cliente({ cli_codigo, status: 'ATIVO', risco_inativacao: false, quadrante: 'TRABALHADA', data_ult_compra: new Date(`${dia}T00:00:00Z`) });
    const c = montarCarteira({ clientes: [ativo(1, '2026-11-26'), ativo(2, '2026-11-25')], rep: 10, inicioMes: '2026-11-26', foraDaLista: new Set() });
    expect(c.sem_compra_mes.clientes.map((x) => x.cli_codigo)).toEqual([2]);
  });
});

describe('painel do vendedor — ofertas', () => {
  const produto = (pro_codigo: number, tipo: 'PROMOCAO' | 'LIQUIDACAO' | 'CAMPANHA', preco: number, ganho_unit: number | undefined, fim: string) =>
    ({
      pro_codigo, descricao: `P${pro_codigo}`, preco_tabela: preco, custo: 10, custo_bolsa: 9,
      promocao: { codigo: 1, descricao: 'x', data_final: fim, somente_avista: false, tipo, oferta_item_id: pro_codigo, restam: 5, limite_cliente: null, ganho_unit, proxima_faixa: null },
    }) as unknown as ProdutoOrcamento;

  it('liquidação 12,40 e campanha 5,60 em ganho nessa ordem; promoção só em promoções, sem ganho', () => {
    const t2 = [produto(1, 'CAMPANHA', 50, 5.6, '2026-11-30'), produto(2, 'PROMOCAO', 30, undefined, '2026-11-28'), produto(3, 'LIQUIDACAO', 40, 12.4, '2026-12-05')];
    const t5 = [produto(3, 'LIQUIDACAO', 44, 12.4, '2026-12-05')];
    const o = montarOfertas(t2, t5);
    expect(o.ganho.map((i) => [i.pro_codigo, i.ganho_unit])).toEqual([[3, 12.4], [1, 5.6]]);
    expect(o.ganho[0]).toMatchObject({ preco_atacado: 40, preco_especial: 44 });
    expect(o.ganho[1].preco_especial).toBeNull();
    expect(o.promocoes).toEqual([expect.objectContaining({ pro_codigo: 2, tipo: 'PROMOCAO', ganho_unit: null })]);
    expect(chavesProibidas(o)).toEqual([]);
  });

  it('chavesProibidas acusa custo em qualquer nível e passa em objeto limpo', () => {
    expect(chavesProibidas({ a: { custo_bolsa: 1 } })).toEqual(['custo_bolsa']);
    expect(chavesProibidas({ a: [{ b: 1 }], c: null, preco: 2 })).toEqual([]);
  });
});
