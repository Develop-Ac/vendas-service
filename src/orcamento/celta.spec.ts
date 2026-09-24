import { chaveIdempotencia, compensacaoOrcamento, corpoParaCelta, diferencasComparativo, justificativaAlcada } from './celta';

const base = {
  id: 'ckx1',
  numero: 42,
  cli_codigo: 40003,
  rep_codigo: 349,
  cp_codigo: 7,
  fp_codigo: '12',
  observacao: 'entregar de manhã',
  itens: [
    { pro_codigo: 40381, quantidade: 2, preco_tabela: 167.1, desc_pct: 0.05 },
    { pro_codigo: 500, quantidade: 1.5, preco_tabela: 10.004, desc_pct: 0 },
  ],
};

describe('corpoParaCelta', () => {
  it('desconto vai em valor: bruto menos o total da linha na intranet', () => {
    const c = corpoParaCelta(base);
    expect(c.itens).toEqual([
      // 167,10 × 0,95 = 158,745 → 158,75 por unidade (como na intranet) → 317,50; bruto 334,20
      { pro_codigo: 40381, quantidade: 2, unitario: 167.1, valor_descto: 16.7 },
      { pro_codigo: 500, quantidade: 1.5, unitario: 10, valor_descto: 0 },
    ]);
    expect(c.cp_codigo).toBe(7);
    expect(c.fp_entrada).toBe('12');
    expect(c.fp_demais_parcelas).toBe('12');
    // só ASCII: o Celta grava em ISO-8859-1 e acento vira "Ã§" na tela do ERP
    expect(c.observacao).toBe(
      'Intranet ORC-000042 - vendedor 349\n' +
        'Alcada: dentro do limite do vendedor. Desconto total 0,0%.\n' +
        'Itens com desconto: 40381 5,0% (max -, ok)\n' +
        'entregar de manha',
    );
  });

  it('omite pagamento vazio e nunca zera o item', () => {
    const c = corpoParaCelta({ ...base, cp_codigo: null, fp_codigo: ' ', observacao: null, itens: [{ ...base.itens[0], desc_pct: 1 }] });
    expect(c).not.toHaveProperty('cp_codigo');
    expect(c).not.toHaveProperty('fp_entrada');
    expect(c.observacao).toMatch(/^Intranet ORC-000042 - vendedor 349\nAlcada/);
    expect(c.observacao).not.toMatch(/\n$/);
    expect(c.itens[0].valor_descto).toBe(334.19); // nunca zera o item
  });

  it('item com acréscimo vai pelo unitário cobrado, com desconto zero', () => {
    const tabela = base.itens[0].preco_tabela;
    const c = corpoParaCelta({ ...base, itens: [{ ...base.itens[0], preco_unit: tabela + 10, desc_pct: 0 }] });
    expect(c.itens[0]).toMatchObject({ unitario: tabela + 10, valor_descto: 0 });
  });

  it('imposto fora do estado: regime no cabeçalho e valor por item só com a chave ligada', () => {
    const st = { ...base, tributacao: 'ST', itens: [{ ...base.itens[0], icms_st: 65.53 }] };
    // desligado (API atual recusa campo desconhecido): nada de tributação no corpo
    const semChave = corpoParaCelta(st);
    expect(semChave.tributacao).toBeUndefined();
    expect('icms_st' in semChave.itens[0]).toBe(false);
    const c = corpoParaCelta(st, true);
    expect(c.tributacao).toEqual({ regime: 'st' });
    expect(c.itens[0].icms_st).toBe(65.53);
    expect(c.itens[0].difal).toBeUndefined();
    const d = corpoParaCelta({ ...base, tributacao: 'DIFAL', itens: [{ ...base.itens[0], difal: 23.9 }, { ...base.itens[1], difal: 1.13 }] }, true);
    expect(d.tributacao).toEqual({ regime: 'difal' });
    expect(d.itens[0]).toMatchObject({ difal: 23.9 });
    // DIFAL cobrado do cliente: vai em "Desp. Acessórias" do orçamento do Celta (soma dos itens)
    expect(d.desp_acessorias).toBe(25.03);
    expect(c.desp_acessorias).toBeUndefined();
    // presencial ou fora do escopo: nada vai, mesmo com a chave ligada
    expect(corpoParaCelta({ ...base, tributacao: 'PRESENCIAL' }, true).tributacao).toBeUndefined();
    // meia nota: sem regime (o imposto foi estimado sobre metade), o valor vai em despesas acessórias
    const m = corpoParaCelta({ ...base, tributacao: 'ST', meia_nota: true, itens: [{ ...base.itens[0], icms_st: 32.77 }] }, true);
    expect(m.tributacao).toBeUndefined();
    expect(m.desp_acessorias).toBe(32.77);
    expect('icms_st' in m.itens[0]).toBe(false);
  });
  it('recusa orçamento sem itens e gera chave estável', () => {
    expect(() => corpoParaCelta({ ...base, itens: [] })).toThrow();
    expect(chaveIdempotencia(base)).toBe('intranet-orc-ckx1');
  });
});

describe('justificativaAlcada', () => {
  it('descreve alçada, aprovação, mês e situação por item sem valores em R$', () => {
    const t = justificativaAlcada({
      ...base,
      rep_nome: 'Alisson',
      desc_pct: 0.062,
      acima_alcada: true,
      bolsa_pct_antes: 0.031,
      bolsa_pct_depois: 0.034,
      aprovado_por: 'Carlos',
      aprovado_em: '2026-09-16T14:00:00.000Z',
      itens: [
        { pro_codigo: 1, quantidade: 1, preco_tabela: 10, desc_pct: 0.05, desc_max_pct: 0.07, faixa: '2B', classe: 'GERAL' },
        { pro_codigo: 2, quantidade: 1, preco_tabela: 10, desc_pct: 0.09, desc_max_pct: 0.07, faixa: '2B', classe: 'GERAL' },
        { pro_codigo: 3, quantidade: 1, preco_tabela: 10, desc_pct: 0.12, desc_max_pct: 0.07, acima_alcada: true },
        { pro_codigo: 4, quantidade: 1, preco_tabela: 10, desc_pct: 0 },
      ],
    });
    expect(t).toBe(
      'Intranet ORC-000042 · vendedor 349 Alisson\n' +
        'Alçada: abaixo do mínimo da régua, aprovado por Carlos em 16/09/2026. Desconto total 6,2%. Desconto do mês: 3,1% -> 3,4%.\n' +
        'Itens com desconto: 1 5,0% (máx 7,0%, 2B GERAL, ok); 2 9,0% (máx 7,0%, 2B GERAL, usa a bolsa); 3 12,0% (máx 7,0%, abaixo do mínimo)',
    );
    expect(t).not.toMatch(/R\$/);
  });

  it('orçamento compensado: diz quantos itens ficaram abaixo do limite e o resultado contra o piso', () => {
    const t = justificativaAlcada({
      ...base,
      acima_alcada: false,
      piso_bolsa: 1.5,
      itens: [
        // abaixo do limite (mínimo 140) sem aprovação: compensado; custo 100 → −5 contra o piso
        { pro_codigo: 1, quantidade: 1, preco_tabela: 160, preco_unit: 145, desc_pct: 0.09375, desc_max_pct: 0.05, preco_minimo: 152, custo_ref: 100 },
        // paga a conta: custo 100, vendido a 200 → +50
        { pro_codigo: 2, quantidade: 1, preco_tabela: 200, preco_unit: 200, desc_pct: 0, desc_max_pct: 0.05, preco_minimo: 190, custo_ref: 100 },
      ],
    });
    expect(t).toContain('Alçada: 1 item abaixo do limite, compensado no próprio orçamento (o conjunto fecha no piso ou acima), sem aprovação.');
    expect(compensacaoOrcamento({ ...base, piso_bolsa: 1.5, itens: [
      { pro_codigo: 1, quantidade: 1, preco_tabela: 160, preco_unit: 145, desc_pct: 0.09375, preco_minimo: 152, custo_ref: 100 },
      { pro_codigo: 2, quantidade: 1, preco_tabela: 200, preco_unit: 200, desc_pct: 0, preco_minimo: 190, custo_ref: 100 },
    ] })).toEqual({ itens: [1], resultado: 45 });
    expect(t).not.toMatch(/R\$/);
    expect(t).toContain('1 9,4% (máx 5,0%, compensado)');
  });

  it('avisa quando está abaixo do mínimo sem aprovação', () => {
    expect(justificativaAlcada({ ...base, acima_alcada: true, itens: [] })).toContain('SEM aprovação registrada');
  });
});

describe('desconto em valor para o Celta', () => {
  it('total digitado na intranet chega igual ao Celta (orçamento Celta 407007)', () => {
    const c = corpoParaCelta({ ...base, itens: [{ pro_codigo: 44501, quantidade: 1, preco_tabela: 209.9, desc_pct: 0.0472, preco_unit: 200, total: 200 }] });
    // em percentual iam 4,72% → 9,91 de desconto → 199,99; em valor vai 9,90 → 200,00
    expect(c.itens[0]).toEqual({ pro_codigo: 44501, quantidade: 1, unitario: 209.9, valor_descto: 9.9 });
  });
});

describe('diferencasComparativo', () => {
  const item = (o: Partial<import('./celta').ItemComparativo>) => ({
    pro_codigo: 1, pro_descricao: 'X', quantidade_orcamento: 2, quantidade_condicional: 2, quantidade_intranet: 2,
    total_orcamento: 100, total_condicional: 100, total_intranet: 100, quantidade_ok: true, valor_ok: true, ausente_em: [], situacao: 'OK', ...o,
  });
  it('mostra só o que difere, item a item, e o total', () => {
    const txt = diferencasComparativo({
      total_orcamento: 300, total_condicional: 250, total_intranet: 300,
      itens: [
        item({ pro_codigo: 10, pro_descricao: 'PALHETA 18', quantidade_condicional: 3, quantidade_ok: false, situacao: 'DIFERENTE' }),
        item({ pro_codigo: 20, pro_descricao: 'COLA PU', total_condicional: 50, valor_ok: false, situacao: 'DIFERENTE' }),
        item({ pro_codigo: 30, pro_descricao: 'PARABRISA', quantidade_condicional: null, total_condicional: null, ausente_em: ['condicional'], situacao: 'FALTANDO' }),
        item({ pro_codigo: 40 }),
      ],
    });
    expect(txt).toBe(
      'Total: orçamento Celta R$ 300,00 · condicional R$ 250,00 · intranet R$ 300,00\n' +
        '• 10 PALHETA 18 — quantidade: orçamento Celta 2 · condicional 3 · intranet 2\n' +
        '• 20 COLA PU — valor: orçamento Celta R$ 100,00 · condicional R$ 50,00 · intranet R$ 100,00\n' +
        '• 30 PARABRISA — falta no condicional (tem: orçamento Celta 2 un · intranet 2 un)',
    );
  });
  it('corta a lista e, sem item divergente, usa as mensagens da API', () => {
    const muitos = Array.from({ length: 4 }, (_, k) => item({ pro_codigo: k, quantidade_ok: false, situacao: 'DIFERENTE' }));
    expect(diferencasComparativo({ itens: muitos }, 2).split('\n').pop()).toBe('… e mais 2 item(ns) diferente(s)');
    expect(diferencasComparativo({ itens: [item({})], mensagens: ['Orçamento 5 não encontrado na intranet para a empresa 3.'] })).toBe('Orçamento 5 não encontrado na intranet para a empresa 3.');
  });
});
