import { chaveIdempotencia, corpoParaCelta, justificativaAlcada } from './celta';

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
  it('traduz fração de desconto em percentual e preço bruto arredondado', () => {
    const c = corpoParaCelta(base);
    expect(c.itens).toEqual([
      { pro_codigo: 40381, quantidade: 2, unitario: 167.1, perc_descto: 5 },
      { pro_codigo: 500, quantidade: 1.5, unitario: 10, perc_descto: 0 },
    ]);
    expect(c.cp_codigo).toBe(7);
    expect(c.fp_entrada).toBe('12');
    expect(c.fp_demais_parcelas).toBe('12');
    expect(c.observacao).toBe(
      'Intranet ORC-000042 · vendedor 349\n' +
        'Alçada: dentro do limite do vendedor. Desconto total 0,0%.\n' +
        'Itens com desconto: 40381 5,0% (máx —, ok)\n' +
        'entregar de manhã',
    );
  });

  it('omite pagamento vazio e trava o desconto em 99,99', () => {
    const c = corpoParaCelta({ ...base, cp_codigo: null, fp_codigo: ' ', observacao: null, itens: [{ ...base.itens[0], desc_pct: 1 }] });
    expect(c).not.toHaveProperty('cp_codigo');
    expect(c).not.toHaveProperty('fp_entrada');
    expect(c.observacao).toMatch(/^Intranet ORC-000042 · vendedor 349\nAlçada/);
    expect(c.observacao).not.toMatch(/\n$/);
    expect(c.itens[0].perc_descto).toBe(99.99);
  });

  it('item com acréscimo vai pelo unitário cobrado, com desconto zero', () => {
    const tabela = base.itens[0].preco_tabela;
    const c = corpoParaCelta({ ...base, itens: [{ ...base.itens[0], preco_unit: tabela + 10, desc_pct: 0 }] });
    expect(c.itens[0]).toMatchObject({ unitario: tabela + 10, perc_descto: 0 });
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

  it('avisa quando está abaixo do mínimo sem aprovação', () => {
    expect(justificativaAlcada({ ...base, acima_alcada: true, itens: [] })).toContain('SEM aprovação registrada');
  });
});
