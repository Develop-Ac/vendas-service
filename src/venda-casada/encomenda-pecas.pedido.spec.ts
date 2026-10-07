import { BadRequestException } from '@nestjs/common';
import {
  ven_encomenda_pecas_itens_cotados,
  ven_encomenda_pecas_itens_encomendados,
} from '@prisma/client';
import { formatarPedidoCompras, montarItensPedidoCompras } from './encomenda-pecas.pedido';

function peca(
  over: Partial<ven_encomenda_pecas_itens_encomendados> = {},
): ven_encomenda_pecas_itens_encomendados {
  return {
    id: 'uuid-1',
    encomenda_pecas_id: 1,
    pro_codigo: 2321,
    pro_descricao: 'FECHADURA PORTA STRADA 2020/ LE DIANT',
    referencia: '2204',
    quantidade: 2,
    ...over,
  };
}

function cotado(
  over: Partial<ven_encomenda_pecas_itens_cotados> = {},
): ven_encomenda_pecas_itens_cotados {
  return {
    id: 10,
    nome: 'FECHADURA PORTA STRADA 2020/ LE DIANT',
    valor: 627.8,
    prazo: 'Ja foi feito pedido, chega amanha',
    fornecedor: 'RUFATO DISTR.PECAS E ACESS LTDA',
    marca: 'Original',
    encomenda_pecas_id: 1,
    transpostadora: null,
    autorizado: true,
    custo: 273.9,
    margem: 100,
    frete: 40,
    imposto: 0,
    for_codigo: 250,
    pro_codigo: 2321,
    ...over,
  };
}

describe('montarItensPedidoCompras', () => {
  it('monta o item com produto da peça encomendada e custo/frete/prazo da cotação', () => {
    const [item] = montarItensPedidoCompras([peca()], [cotado()]);
    expect(item).toEqual({
      pro_codigo: 2321,
      pro_descricao: 'FECHADURA PORTA STRADA 2020/ LE DIANT',
      referencia: '2204',
      mar_descricao: 'Original',
      quantidade: 2,
      for_codigo: 250,
      valor_unitario: 273.9,
      frete: 40,
      prazo: 'Ja foi feito pedido, chega amanha',
      nomeFrete: null,
      item_cotado_id: '10',
    });
  });

  it('ignora os itens cotados não selecionados', () => {
    const itens = montarItensPedidoCompras(
      [peca()],
      [cotado({ id: 1, autorizado: false }), cotado({ id: 2, autorizado: null }), cotado({ id: 3 })],
    );
    expect(itens.map((i) => i.item_cotado_id)).toEqual(['3']);
  });

  it('usa a única peça da encomenda quando a cotação não diz o produto', () => {
    const [item] = montarItensPedidoCompras([peca()], [cotado({ pro_codigo: null })]);
    expect(item.pro_codigo).toBe(2321);
    expect(item.quantidade).toBe(2);
  });

  it('com mais de uma peça, cotação sem produto é pendência', () => {
    expect(() =>
      montarItensPedidoCompras(
        [peca(), peca({ id: 'uuid-2', pro_codigo: 999 })],
        [cotado({ pro_codigo: null })],
      ),
    ).toThrow(/sem produto do Celta/);
  });

  it('lista todas as pendências de uma vez (fornecedor e produto)', () => {
    let erro: unknown;
    try {
      montarItensPedidoCompras(
        [peca(), peca({ id: 'uuid-2', pro_codigo: 999 })],
        [
          cotado({ id: 1, nome: 'A', for_codigo: null }),
          cotado({ id: 2, nome: 'B', pro_codigo: 99999 }),
          cotado({ id: 3, nome: 'C' }),
        ],
      );
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(BadRequestException);
    const msg = (erro as BadRequestException).message;
    expect(msg).toContain('"A" (sem código do fornecedor)');
    expect(msg).toContain('"B" (produto sem cadastro no Celta (99999))');
    expect(msg).not.toContain('"C"');
  });

  it('sem item selecionado não gera pedido', () => {
    expect(() => montarItensPedidoCompras([peca()], [cotado({ autorizado: false })])).toThrow(
      /Nenhum item cotado está selecionado/,
    );
  });

  it('quantidade 1 e nome da cotação quando o produto não está entre as peças', () => {
    const [item] = montarItensPedidoCompras(
      [peca(), peca({ id: 'uuid-2', pro_codigo: 999 })],
      [cotado({ pro_codigo: 555, nome: 'PEÇA X' })],
    );
    expect(item).toMatchObject({
      pro_codigo: 555,
      quantidade: 1,
      pro_descricao: 'PEÇA X',
      referencia: null,
    });
  });
});

describe('formatarPedidoCompras', () => {
  it('prefixa com E-', () => {
    expect(formatarPedidoCompras(100001)).toBe('E-100001');
    expect(formatarPedidoCompras(null)).toBeNull();
  });
});
