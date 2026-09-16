import { aplicarDecisoes, pendenciasSaldo } from './saldo';

const itens = [
  { pro_codigo: 1, descricao: 'A', quantidade: 5, qtd_encomenda: 0, desc_pct: 0.03 },
  { pro_codigo: 2, descricao: 'B', quantidade: 4, qtd_encomenda: 0, desc_pct: 0 },
  { pro_codigo: 3, descricao: 'C', quantidade: 2, qtd_encomenda: 0, desc_pct: 0 },
  { pro_codigo: 4, descricao: 'D', quantidade: 6, qtd_encomenda: 4, desc_pct: 0 },
];
// 1: saldo 2 (parcial) · 2: zerado · 3: ok · 4: 2 a entregar agora e saldo 2 (ok) · produto 9 não existe
const saldo = new Map<number, number | undefined>([[1, 2], [2, 0], [3, 10], [4, 2]]);

describe('pendenciasSaldo', () => {
  it('lista só o que falta para a parte a entregar agora', () => {
    const p = pendenciasSaldo(itens, saldo);
    expect(p.map((x) => [x.pro_codigo, x.disponivel, x.falta])).toEqual([[1, 2, 3], [2, 0, 4]]);
  });
  it('produto sem saldo no ERP conta como zero', () => {
    expect(pendenciasSaldo([{ pro_codigo: 9, quantidade: 1 }], saldo)[0].falta).toBe(1);
  });
});

describe('aplicarDecisoes', () => {
  it('venda perdida: mantém o disponível e registra a diferença', () => {
    const r = aplicarDecisoes(itens, saldo, [
      { pro_codigo: 1, acao: 'VENDA_PERDIDA' },
      { pro_codigo: 2, acao: 'VENDA_PERDIDA' },
    ]);
    expect(r.sem_decisao).toEqual([]);
    expect(r.itens.map((i) => [i.pro_codigo, i.quantidade, i.qtd_encomenda])).toEqual([[1, 2, 0], [3, 2, 0], [4, 6, 4]]);
    expect(r.venda_perdida).toEqual([
      { pro_codigo: 1, descricao: 'A', quantidade: 3 },
      { pro_codigo: 2, descricao: 'B', quantidade: 4 },
    ]);
    expect(r.itens[0]).toMatchObject({ desc_pct: 0.03 }); // demais campos preservados
  });
  it('encomenda: quantidade fica, a diferença vira encomenda', () => {
    const r = aplicarDecisoes(itens, saldo, [
      { pro_codigo: 1, acao: 'ENCOMENDA' },
      { pro_codigo: 2, acao: 'ENCOMENDA' },
    ]);
    expect(r.itens.map((i) => [i.pro_codigo, i.quantidade, i.qtd_encomenda])).toEqual([[1, 5, 3], [2, 4, 4], [3, 2, 0], [4, 6, 4]]);
    expect(r.venda_perdida).toEqual([]);
  });
  it('retirar sem manter o disponível remove a linha inteira', () => {
    const r = aplicarDecisoes(itens, saldo, [
      { pro_codigo: 1, acao: 'RETIRAR', manter_disponivel: false },
      { pro_codigo: 2, acao: 'RETIRAR' },
    ]);
    expect(r.itens.map((i) => i.pro_codigo)).toEqual([3, 4]);
    expect(r.venda_perdida).toEqual([]);
  });
  it('pendência sem decisão é apontada e nada muda nela', () => {
    const r = aplicarDecisoes(itens, saldo, [{ pro_codigo: 1, acao: 'RETIRAR' }]);
    expect(r.sem_decisao).toEqual([2]);
    expect(r.itens.find((i) => i.pro_codigo === 2)?.quantidade).toBe(4);
  });
});
