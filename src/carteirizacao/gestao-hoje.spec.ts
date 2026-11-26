import { TETO, montarCurvaASemCompra, montarEmRisco, montarOrcamentosEquipe, montarRecuperacao, recebeComissao, resumoPerdidos, totalComissao, validarAviso } from './gestao-hoje';
import { BadRequestException } from '@nestjs/common';
import { chavesProibidas } from './painel-vendedor';
import { cliente } from '../../test/mocks/cliente-carteira';

const POOL = 356;
const caro = { margem_custo_pct: 35, lucro_12m: 9000 };

describe('gestão hoje — curva A sem compra (critério 8)', () => {
  it('A com faturamento no mês fica fora; A sem vendedor e sem compra entra com rep nulo', () => {
    const clientes = [
      cliente({ ...caro, cli_codigo: 1, faturamento_12m: 120000 }),
      cliente({ ...caro, cli_codigo: 2, faturamento_12m: 60000, rep_codigo: POOL, rep_nome: 'DISPONIVEL' }),
      cliente({ ...caro, cli_codigo: 3, faturamento_12m: 240000, em_carteira: false, rep_codigo: null, rep_nome: null }),
      cliente({ ...caro, cli_codigo: 4, faturamento_12m: 36000 }),
      cliente({ ...caro, cli_codigo: 5, curva_abc: 'B' }),
    ];
    const r = montarCurvaASemCompra({ clientes, faturamento: new Map([[1, 500]]) });

    expect(r.curva_a).toBe(4);
    expect(r.comprando).toBe(1);
    expect(r.itens.map((i) => i.cli_codigo)).toEqual([3, 2, 4]);
    expect(r.itens[0]).toMatchObject({ rep_codigo: null, rep_nome: null, compra_mes: 20000, cidade: 'CUIABA' });
    expect(r.itens[1]).toMatchObject({ rep_codigo: null, rep_nome: null });
    expect(r.itens[2]).toMatchObject({ rep_codigo: 10, rep_nome: 'VENDEDOR' });
    expect(r.total).toBe(3);
    expect(r.valor_total).toBe(20000 + 5000 + 3000);
    expect(chavesProibidas(r.itens)).toEqual([]);
  });

  it('teto de 200 itens com total da lista inteira', () => {
    const clientes = Array.from({ length: 201 }, (_, i) => cliente({ cli_codigo: i + 1, faturamento_12m: 12 }));
    const r = montarCurvaASemCompra({ clientes, faturamento: new Map() });
    expect(r.total).toBe(201);
    expect(r.valor_total).toBe(201);
    expect(r.itens).toHaveLength(TETO);
  });
});

describe('gestão hoje — em risco (critério 9)', () => {
  const clientes = [
    cliente({ ...caro, cli_codigo: 1, curva_abc: 'A', faturamento_12m: 12000 }),
    cliente({ ...caro, cli_codigo: 2, curva_abc: 'C', faturamento_12m: 99000 }),
    cliente({ ...caro, cli_codigo: 3, curva_abc: 'B', faturamento_12m: 24000 }),
    // B fora do ciclo mas sem carteira: não entra; escalado no pool sai como "Sem vendedor".
    cliente({ ...caro, cli_codigo: 4, curva_abc: 'B', faturamento_12m: 1200, em_carteira: false, rep_codigo: null, rep_nome: null }),
    cliente({ ...caro, cli_codigo: 5, curva_abc: 'A', faturamento_12m: 600, rep_codigo: POOL, rep_nome: 'DISPONIVEL' }),
  ];
  const ciclo = [
    { cli: 1, dias_sem_compra: 40, intervalo_dias: 15 },
    { cli: 2, dias_sem_compra: 50, intervalo_dias: 20 },
    { cli: 3, dias_sem_compra: 30, intervalo_dias: 10 },
    { cli: 9, dias_sem_compra: 30, intervalo_dias: 10 },
    { cli: 4, dias_sem_compra: 30, intervalo_dias: 10 },
  ];
  const escaladas = [
    { cli_codigo: 5, cli_nome: 'POOL', rep_codigo: POOL, rep_nome: 'DISPONIVEL', curva: 'A' },
    { cli_codigo: 1, cli_nome: 'X', rep_codigo: 10, rep_nome: 'VENDEDOR', curva: 'A' },
    { cli_codigo: 1, cli_nome: 'X', rep_codigo: 10, rep_nome: 'VENDEDOR', curva: 'A' },
    { cli_codigo: 7, cli_nome: 'FORA DA CARTEIRA', rep_codigo: 11, rep_nome: 'OUTRO', curva: 'B' },
  ];

  it('fora do ciclo + escalado aparece uma vez como ESCALADO; curva C fora do ciclo não aparece', () => {
    const r = montarEmRisco({ clientes, ciclo, escaladas });
    expect(r.itens.map((i) => [i.cli_codigo, i.motivo])).toEqual([
      [3, 'FORA_DO_CICLO'],
      [1, 'ESCALADO'],
      [5, 'ESCALADO'],
      [7, 'ESCALADO'],
    ]);
    expect(r.itens[0]).toMatchObject({ intervalo_dias: 10, curva: 'B', compra_mes: 2000 });
    expect(r.itens[1]).toMatchObject({ intervalo_dias: null, cli_nome: 'CLIENTE TESTE' });
    expect(r.itens[2]).toMatchObject({ rep_codigo: null, rep_nome: null });
    expect(r.itens[3]).toMatchObject({ cli_nome: 'FORA DA CARTEIRA', rep_codigo: 11, curva: 'B', compra_mes: 0 });
    expect(r.total).toBe(4);
    expect(chavesProibidas(r.itens)).toEqual([]);
  });

  it('ciclo nulo = só escalados', () => {
    const r = montarEmRisco({ clientes, ciclo: null, escaladas });
    expect(r.itens.every((i) => i.motivo === 'ESCALADO')).toBe(true);
    expect(r.total).toBe(3);
  });
});

describe('gestão hoje — recuperação (critério 11)', () => {
  it('A/B ativo fora do prazo de compra entra, mesmo com orçamento recente; o resto fica fora', () => {
    const base = { ...caro, faturamento_12m: 1200 };
    const clientes = [
      cliente({ ...base, cli_codigo: 1, curva_abc: 'A', dias_sem_compra: 30, dias_sem_orcamento: 2 }), // no limite da A, em negociação
      cliente({ ...base, cli_codigo: 2, curva_abc: 'A', dias_sem_compra: 55 }),
      cliente({ ...base, cli_codigo: 3, curva_abc: 'B', dias_sem_compra: 45 }),
      cliente({ ...base, cli_codigo: 4, curva_abc: 'A', dias_sem_compra: 29 }), // dentro do prazo
      cliente({ ...base, cli_codigo: 5, curva_abc: 'B', dias_sem_compra: 44 }), // dentro do prazo da B
      cliente({ ...base, cli_codigo: 6, curva_abc: 'C', dias_sem_compra: 59 }), // curva C não tem resgate
      cliente({ ...base, cli_codigo: 7, curva_abc: 'A', dias_sem_compra: 70, status: 'INATIVO' }),
      cliente({ ...base, cli_codigo: 8, curva_abc: 'A', dias_sem_compra: 40, rep_codigo: POOL, rep_nome: 'DISPONIVEL' }),
      cliente({ ...base, cli_codigo: 9, curva_abc: 'A', dias_sem_compra: 40, em_carteira: false, rep_codigo: null, rep_nome: null }),
      cliente({ ...base, cli_codigo: 10, curva_abc: 'A', dias_sem_compra: 40, revisao: true }),
      cliente({ ...base, cli_codigo: 11, curva_abc: 'A', dias_sem_compra: null }), // nunca comprou
    ];
    const r = montarRecuperacao({ abertos: [{ cli_codigo: 2, estagio: 'A_CONTATAR' }], clientes, detalhe: { fechados: 12, recuperados: 7 } });

    expect(r).toMatchObject({ fechados: 12, recuperados: 7, total: 3, valor_total: 300 });
    expect(r.itens.map((i) => i.cli_codigo)).toEqual([2, 3, 1]);
    expect(r.itens[0]).toMatchObject({ dias_sem_compra: 55, curva: 'A', fone: '65999990000', estagio: 'A_CONTATAR', dias_sem_orcamento: null });
    expect(r.itens[2]).toMatchObject({ curva: 'A', estagio: null, dias_sem_orcamento: 2 });
    expect(chavesProibidas(r.itens)).toEqual([]);
  });

  it('detalhe nulo → fechados e recuperados 0', () => {
    expect(montarRecuperacao({ abertos: [], clientes: [], detalhe: null })).toMatchObject({ fechados: 0, recuperados: 0, total: 0 });
  });
});

describe('gestão hoje — orçamentos da equipe (critério 7)', () => {
  const hoje = new Date('2026-11-25T00:00:00Z');
  const ontem = new Date('2026-11-24T00:00:00Z');
  const amanha = new Date('2026-11-26T00:00:00Z');

  it('adiado, enviado e sem desfecho de três vendedores: com vendedor e motivo, sem repetir, por valor', () => {
    const r = montarOrcamentosEquipe({
      hoje,
      intranet: [
        { id: 'adi', numero: 10, cli_codigo: 1, cli_nome: 'A', rep_codigo: 10, rep_nome: 'ANA', total: 100, status: 'ADIADO', retorno_em: ontem, validade: null },
        { id: 'env', numero: 20, cli_codigo: 2, cli_nome: 'B', rep_codigo: 11, rep_nome: 'BIA', total: 300, status: 'ENVIADO', retorno_em: null, validade: amanha },
      ],
      semDesfecho: [
        // mesmo orçamento adiado também caiu no sem desfecho: aparece uma vez
        { orcamento: -10, origem: 'INTRANET', numero_intranet: 10, intranet_id: 'adi', motivo_em: null, emissao: ontem, cli_codigo: 1, cli_nome: 'A', rep_codigo: 10, rep_nome: 'ANA', total: 100, dias_desde_emissao: 5 },
        { orcamento: 555, origem: 'CELTA', numero_intranet: null, intranet_id: null, motivo_em: null, emissao: ontem, cli_codigo: 3, cli_nome: 'C', rep_codigo: 12, rep_nome: 'CAIO', total: 200, dias_desde_emissao: 4 },
      ],
    });

    expect(r.itens.map((i) => [i.numero, i.motivo, i.rep_codigo, i.rep_nome])).toEqual([
      [20, 'VENCE', 11, 'BIA'],
      [555, 'SEM_DESFECHO', 12, 'CAIO'],
      [10, 'RETORNO', 10, 'ANA'],
    ]);
    expect(r.total).toBe(3);
    expect(r.valor_total).toBe(600);
    expect(r.itens[1].id).toBeNull();
  });
});

describe('gestão hoje — perdidos', () => {
  it('principal motivo e percentual do primeiro; sem lista', () => {
    const r = resumoPerdidos({ mes: '2026-11', quantidade: 3, valor: 1000, motivos: [{ motivo: 'PRECO', pct: 70 }, { motivo: 'PRAZO', pct: 30 }] });
    expect(r).toEqual({ mes: '2026-11', quantidade: 3, valor: 1000, principal_motivo: 'PRECO', pct: 70 });
    expect(resumoPerdidos({ mes: '2026-11', quantidade: 0, valor: 0, motivos: [] })).toMatchObject({ principal_motivo: null, pct: null });
  });
});

describe('gestão hoje — comissão (critério 16)', () => {
  const colunas = [{ name: 'mix' }, { name: 'faixa' }, { name: 'valor_comissao' }];

  it('pega a linha TOTAL GERAL (mix 99), não a soma', () => {
    const linhas = [
      [1, 'A', 100],
      [1, 'B', 50],
      [1, 'TOTAL', 150],
      [99, 'TOTAL GERAL', '150.5'],
    ];
    expect(totalComissao(colunas, linhas)).toBe(150.5);
  });

  it('sem TOTAL GERAL ou valor nulo → null', () => {
    expect(totalComissao(colunas, [[1, 'A', 100]])).toBeNull();
    expect(totalComissao(colunas, [[99, 'TOTAL GERAL', null]])).toBeNull();
  });

  it('só o hub da supervisão recebe comissão', () => {
    expect(recebeComissao({ vendas_hub_inicial: 'GERENCIA' })).toBe(false);
    expect(recebeComissao({ vendas_hub_inicial: null })).toBe(false);
    expect(recebeComissao({ setor: 'ADMIN', vendas_hub_inicial: 'supervisao_atacado' } as { vendas_hub_inicial: string })).toBe(true);
  });
});

describe('gestão hoje — validarAviso', () => {
  const bom = { rep_codigo: 10, texto: '  Retorne o orçamento 101  ', canais: ['badge', 'whatsapp'] };

  it('caso bom: texto aparado, link interno aceito', () => {
    expect(validarAviso({ ...bom, link: '/vendas/orcamento/o1' })).toEqual({
      rep_codigo: 10, texto: 'Retorne o orçamento 101', canais: ['badge', 'whatsapp'], link: '/vendas/orcamento/o1',
    });
    expect(validarAviso({ ...bom, canais: ['whatsapp'] }).link).toBeUndefined();
  });

  it.each([
    ['texto vazio', { ...bom, texto: '   ' }],
    ['501 caracteres', { ...bom, texto: 'x'.repeat(501) }],
    ['canal desconhecido', { ...bom, canais: ['badge', 'email'] }],
    ['canal repetido', { ...bom, canais: ['badge', 'badge'] }],
    ['lista de canais vazia', { ...bom, canais: [] }],
    ['link externo', { ...bom, link: 'https://exemplo.com' }],
    ['link //host', { ...bom, link: '//exemplo.com' }],
    ['link /\\host', { ...bom, link: '/\\exemplo.com/login' }],
    ['rep não inteiro', { ...bom, rep_codigo: 1.5 }],
    ['sem rep', { ...bom, rep_codigo: undefined }],
    ['sem corpo', undefined],
  ])('400: %s', (_, corpo) => {
    expect(() => validarAviso(corpo)).toThrow(BadRequestException);
  });

  it('500 caracteres passa', () => {
    expect(validarAviso({ ...bom, texto: 'x'.repeat(500) }).texto).toHaveLength(500);
  });
});
