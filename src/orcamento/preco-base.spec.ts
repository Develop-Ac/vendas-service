import { corpoParaCelta, justificativaAlcada } from './celta';
import { baseDoCliente, descBaseAcimaDoMaximo, descSobre } from './preco-base';

describe('baseDoCliente', () => {
  it('base acima da tabela: o cliente vê a base com o % sobre ela', () => {
    expect(baseDoCliente({ preco_tabela: 100, preco_unit: 108, desc_pct: 0, preco_base: 120, desc_base_pct: 0.1 })).toEqual({ base: 120, desc: 0.1 });
  });

  it('sem base: a tabela com o desconto contra ela (unitário digitado abaixo da tabela)', () => {
    expect(baseDoCliente({ preco_tabela: 100, preco_unit: 90, desc_pct: 0.1 })).toEqual({ base: 100, desc: 0.1 });
  });

  it('orçamento anterior com acréscimo: a base é o cobrado, sem desconto', () => {
    expect(baseDoCliente({ preco_tabela: 100, preco_unit: 115, desc_pct: 0 })).toEqual({ base: 115, desc: 0 });
  });
});

describe('descSobre / descBaseAcimaDoMaximo', () => {
  it('desconto de 4 casas, nunca negativo', () => {
    expect(descSobre(120, 108)).toBe(0.1);
    expect(descSobre(100, 110)).toBe(0);
  });

  it('só a linha com base e % acima do máximo em vigor', () => {
    expect(descBaseAcimaDoMaximo({ preco_base: 200, desc_base_pct: 0.5, desc_max_pct: 0.05 })).toBe(true);
    expect(descBaseAcimaDoMaximo({ preco_base: 120, desc_base_pct: 0.05, desc_max_pct: 0.05 })).toBe(false);
    expect(descBaseAcimaDoMaximo({ preco_base: null, desc_base_pct: null, desc_max_pct: 0.05 })).toBe(false);
    // canal negativo: o máximo em vigor é zero — qualquer % sobre a base vai ao gestor
    expect(descBaseAcimaDoMaximo({ preco_base: 120, desc_base_pct: 0.01, desc_max_pct: 0 })).toBe(true);
  });
});

describe('preço base no Celta', () => {
  const orc = {
    id: 'ckx1', numero: 7, cli_codigo: 1, rep_codigo: 349, cp_codigo: 7, fp_codigo: null, observacao: null,
    itens: [{ pro_codigo: 10, quantidade: 2, preco_tabela: 100, preco_unit: 108, total: 216, desc_pct: 0, preco_base: 120, desc_base_pct: 0.1, desc_max_pct: 0.05 }],
  };

  it('vai a base como unitário e o desconto sobre ela em R$ (a NF sai "120 com 10%")', () => {
    expect(corpoParaCelta(orc).itens).toEqual([{ pro_codigo: 10, quantidade: 2, unitario: 120, valor_descto: 24 }]);
  });

  it('a justificativa mostra o % sobre a base e o preço final contra a tabela, sem R$', () => {
    expect(justificativaAlcada(orc)).toContain('10 10,0% s/ preço base (liq. 8,0% acima da tabela, máx 5,0%, acima do máximo)');
  });

  it('alçada só pelo % sobre a base: o cabeçalho diz o motivo', () => {
    const t = justificativaAlcada({ ...orc, acima_alcada: true, aprovado_por: 'Carlos', aprovado_em: '2026-10-08T12:00:00Z', itens: [{ ...orc.itens[0], acima_alcada: true, preco_minimo: 95 }] });
    expect(t).toContain('Alçada: desconto sobre preço acima da tabela passa do máximo, aprovado por Carlos');
  });
});
