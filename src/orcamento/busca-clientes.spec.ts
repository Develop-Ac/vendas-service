import { ordenarBuscaClientes } from './orcamento.erp.repository';

const c = (CLI_CODIGO: number, CLI_NOME: string, TABELA_PRECO: string | null) => ({ CLI_CODIGO, CLI_NOME, TABELA_PRECO });

describe('ordenarBuscaClientes', () => {
  const base = [
    c(1, 'ZEBRA AUTO', '1'),
    c(2, 'POLETTO AUTO CENTER', '2'),
    c(3, 'ALFA PECAS', '5'),
    c(4, 'BETA PECAS', '2'),
    c(5, 'GAMA VIDROS', null),
  ];

  it('canal primeiro, depois compras 12m, depois nome', () => {
    const compras = new Map([[3, 1000], [4, 50_000], [1, 999_999]]);
    const r = ordenarBuscaClientes(base, compras, 20);
    expect(r.clientes.map((x) => x.CLI_CODIGO)).toEqual([4, 3, 2, 1, 5]);
    expect(r.truncado).toBe(false);
  });

  it('corta no limite e avisa; corte do ERP também marca truncado', () => {
    const r = ordenarBuscaClientes(base, new Map(), 2);
    expect(r.clientes.map((x) => x.CLI_NOME)).toEqual(['ALFA PECAS', 'BETA PECAS']);
    expect(r.truncado).toBe(true);
    expect(ordenarBuscaClientes(base, new Map(), 20, true).truncado).toBe(true);
  });
});
