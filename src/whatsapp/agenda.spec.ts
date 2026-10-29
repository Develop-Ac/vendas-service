import { codigoDaAgenda } from './agenda';

describe('codigoDaAgenda', () => {
  const validos = new Set([40289, 316]);

  it('código antes ou depois do nome', () => {
    expect(codigoDaAgenda('40289 João', validos)).toEqual({ cli_codigo: 40289, contato_nome: 'João' });
    expect(codigoDaAgenda('João 40289', validos)).toEqual({ cli_codigo: 40289, contato_nome: 'João' });
  });

  it('código colado em letra ("C40289") conta; nome vazio vira null', () => {
    expect(codigoDaAgenda('C40289', validos)).toEqual({ cli_codigo: 40289, contato_nome: null });
    expect(codigoDaAgenda('C40289 Maria', validos)).toEqual({ cli_codigo: 40289, contato_nome: 'Maria' });
    expect(codigoDaAgenda('40289', validos)).toEqual({ cli_codigo: 40289, contato_nome: null });
  });

  it('dois códigos válidos não vinculam', () => {
    expect(codigoDaAgenda('40289 João 316', validos)).toBeNull();
  });

  it('número longo no nome não vira código', () => {
    expect(codigoDaAgenda('Maria 66940289123', validos)).toBeNull();
    expect(codigoDaAgenda('40289 Oficina CNPJ 31600000000190', validos)).toEqual({
      cli_codigo: 40289,
      contato_nome: 'Oficina CNPJ 31600000000190',
    });
  });

  it('sem código ou código que não é cliente do atacado → null', () => {
    expect(codigoDaAgenda('João Comprador', validos)).toBeNull();
    expect(codigoDaAgenda('99999 João', validos)).toBeNull();
    expect(codigoDaAgenda(null, validos)).toBeNull();
  });
});
