import { chaveIdempotencia, corpoParaCelta } from './celta';

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
    expect(c.observacao).toBe('Intranet ORC-000042\nentregar de manhã');
  });

  it('omite pagamento vazio e trava o desconto em 99,99', () => {
    const c = corpoParaCelta({ ...base, cp_codigo: null, fp_codigo: ' ', observacao: null, itens: [{ ...base.itens[0], desc_pct: 1 }] });
    expect(c).not.toHaveProperty('cp_codigo');
    expect(c).not.toHaveProperty('fp_entrada');
    expect(c.observacao).toBe('Intranet ORC-000042');
    expect(c.itens[0].perc_descto).toBe(99.99);
  });

  it('recusa orçamento sem itens e gera chave estável', () => {
    expect(() => corpoParaCelta({ ...base, itens: [] })).toThrow();
    expect(chaveIdempotencia(base)).toBe('intranet-orc-ckx1');
  });
});
