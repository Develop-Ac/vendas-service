import {
  CfgRetorno,
  LinhaNf,
  Retorno,
  VendaPerdida,
  agruparPorCliente,
  candidatos,
  conversao,
  converteuSemContato,
  destino,
  elegivel,
  resumirRetornos,
  sinalDeContato,
  transicao,
} from './retorno-venda-perdida';

const CFG: CfgRetorno = { prazoDias: 3, validadeDias: 90, conversaoDias: 15, inicio: '2026-10-15' };
const AGORA = new Date('2026-11-13T12:00:00-04:00');
const d = (s: string) => new Date(s);

const vp = (over: Partial<VendaPerdida> = {}): VendaPerdida => ({
  id: 'vp1',
  cli_codigo: 10,
  pro_codigo: 500,
  descricao: 'Para-brisa',
  quantidade: 2,
  rep_codigo: 7,
  created_at: d('2026-11-01T10:00:00-04:00'),
  ven_orcamento: { cli_nome: 'Cliente X' },
  ...over,
});

const ret = (over: Partial<Retorno> = {}): Retorno => ({
  id: 'r1',
  cli_codigo: 10,
  cli_nome: 'Cliente X',
  pro_codigo: 500,
  descricao: 'Para-brisa',
  quantidade_pedida: 2,
  saldo_na_geracao: 5,
  venda_perdida_em: d('2026-11-01T10:00:00-04:00'),
  rep_codigo: 7,
  rep_nome: 'Ana',
  gerada_em: d('2026-11-10T05:00:00-04:00'),
  prazo_em: d('2026-11-13T05:00:00-04:00'),
  status: 'ABERTA',
  contato_em: null,
  contato_sinal: null,
  encerrada_em: null,
  convertida_em: null,
  convertida_qtd: null,
  convertida_valor: null,
  ...over,
});

const nf = (over: Partial<LinhaNf> = {}): LinhaNf => ({
  cli_codigo: 10,
  pro_codigo: 500,
  emissao: '2026-11-11',
  devolucao: false,
  quantidade: 2,
  liquido: 300,
  ...over,
});

describe('candidatos', () => {
  it('validade de 90 dias', () => {
    const agora = d('2027-03-01T12:00:00-04:00');
    const limite = new Date(agora.getTime() - 90 * 86_400_000);
    const r = candidatos(
      [vp({ id: 'velha', created_at: new Date(limite.getTime() - 1) }), vp({ id: 'ok', pro_codigo: 501, created_at: limite })],
      [],
      CFG,
      agora,
    );
    expect(r.map((c) => c.venda_perdida_id)).toEqual(['ok']);
  });

  it('corte do início na virada do dia de Cuiabá', () => {
    const r = candidatos(
      [
        vp({ id: 'antes', created_at: d('2026-10-14T23:59:59-04:00') }),
        vp({ id: 'virada', pro_codigo: 501, created_at: d('2026-10-15T00:00:00-04:00') }),
      ],
      [],
      CFG,
      AGORA,
    );
    expect(r.map((c) => c.venda_perdida_id)).toEqual(['virada']);
  });

  it('sem cliente não entra', () => {
    expect(candidatos([vp({ cli_codigo: null })], [], CFG, AGORA)).toEqual([]);
  });

  it('várias do par viram uma, com os dados da mais recente', () => {
    const r = candidatos(
      [vp({ id: 'a', quantidade: 1 }), vp({ id: 'b', quantidade: 4, created_at: d('2026-11-05T10:00:00-04:00') }), vp({ id: 'c', quantidade: 9, created_at: d('2026-10-20T10:00:00-04:00') })],
      [],
      CFG,
      AGORA,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ venda_perdida_id: 'b', quantidade_pedida: 4, cli_nome: 'Cliente X', rep_codigo: 7 });
  });

  it.each([
    ['aberto bloqueia', { status: 'ABERTA', encerrada_em: null, gerada_em: d('2026-10-20') }, 0],
    ['NEGLIGENCIADA aberta bloqueia', { status: 'NEGLIGENCIADA', encerrada_em: null, gerada_em: d('2026-10-20') }, 0],
    ['CONTATADA depois da venda perdida bloqueia', { status: 'CONTATADA', encerrada_em: d('2026-11-05'), gerada_em: d('2026-11-03') }, 0],
    ['NEGLIGENCIADA encerrada depois bloqueia', { status: 'NEGLIGENCIADA', encerrada_em: d('2026-11-05'), gerada_em: d('2026-11-03') }, 0],
    ['CANCELADA não bloqueia', { status: 'CANCELADA', encerrada_em: d('2026-11-05'), gerada_em: d('2026-11-03') }, 1],
    ['encerrado antes da venda perdida não bloqueia', { status: 'CONTATADA', encerrada_em: d('2026-10-25'), gerada_em: d('2026-10-20') }, 1],
  ])('%s', (_, e, n) => {
    expect(candidatos([vp()], [{ cli_codigo: 10, pro_codigo: 500, ...e }], CFG, AGORA)).toHaveLength(n);
  });
});

describe('elegivel', () => {
  const [c] = candidatos([vp()], [], CFG, AGORA);
  it.each([
    ['saldo positivo', { saldo: 3, inativo: false }, [], true],
    ['saldo zero', { saldo: 0, inativo: false }, [], false],
    ['inativo', { saldo: 3, inativo: true }, [], false],
    ['saldo desconhecido', undefined, [], false],
    ['comprou depois do dia da venda perdida', { saldo: 3, inativo: false }, [nf({ emissao: '2026-11-02' })], false],
    ['compra no mesmo dia não conta', { saldo: 3, inativo: false }, [nf({ emissao: '2026-11-01' })], true],
    ['devolução depois não conta', { saldo: 3, inativo: false }, [nf({ emissao: '2026-11-02', devolucao: true })], true],
    ['compra de outro produto não conta', { saldo: 3, inativo: false }, [nf({ emissao: '2026-11-02', pro_codigo: 9 })], true],
  ] as const)('%s', (_, p, linhas, esperado) => {
    expect(elegivel(c, p, [...linhas])).toBe(esperado);
  });
});

describe('destino', () => {
  const [c] = candidatos([vp()], [], CFG, AGORA);
  const cli = { em_carteira: true, status: 'ATIVO', rep_codigo: 3, rep_nome: 'Dono' };
  const ativos = new Set([7]);

  it('dono da carteira', () => {
    expect(destino(c, cli, undefined, ativos)).toEqual({ rep_codigo: 3, rep_nome: 'Dono' });
  });
  it('cobertura ativa do dono manda ao substituto', () => {
    expect(destino(c, cli, { rep_substituto_codigo: 4, rep_substituto_nome: 'Sub' }, ativos)).toEqual({ rep_codigo: 4, rep_nome: 'Sub' });
  });
  it('fora de carteira vai a quem registrou, se ativo', () => {
    expect(destino(c, { ...cli, status: 'DISPONIVEL' }, undefined, ativos)).toEqual({ rep_codigo: 7, rep_nome: null });
    expect(destino(c, undefined, undefined, ativos)).toEqual({ rep_codigo: 7, rep_nome: null });
  });
  it('fora de carteira com vendedor inativo não gera', () => {
    expect(destino(c, undefined, undefined, new Set())).toBeNull();
  });
});

describe('sinalDeContato', () => {
  const g = d('2026-11-10T05:00:00-04:00');
  it('ignora sinal anterior à geração', () => {
    expect(sinalDeContato(g, { data_ult_compra: d('2026-11-09'), ult_orcamento: null, mensagem: null })).toBeNull();
  });
  it('venda > orçamento > mensagem', () => {
    const m = d('2026-11-11T09:00:00-04:00');
    const o = d('2026-11-12T09:00:00-04:00');
    const v = d('2026-11-13T09:00:00-04:00');
    expect(sinalDeContato(g, { data_ult_compra: v, ult_orcamento: o, mensagem: m })).toEqual({ sinal: 'VENDA', em: v });
    expect(sinalDeContato(g, { ult_orcamento: o, mensagem: m })).toEqual({ sinal: 'ORCAMENTO', em: o });
    expect(sinalDeContato(g, { mensagem: m })).toEqual({ sinal: 'MENSAGEM', em: m });
  });
});

describe('transicao', () => {
  const noPrazo = d('2026-11-12T10:00:00-04:00');
  const vencido = d('2026-11-14T10:00:00-04:00');
  const msg = (em: Date) => ({ sinal: 'MENSAGEM' as const, em });

  it('contato no prazo → CONTATADA e encerra', () => {
    expect(transicao(ret(), { sinal: msg(noPrazo), agora: noPrazo }, CFG)).toEqual({
      status: 'CONTATADA', contato_em: noPrazo, contato_sinal: 'MENSAGEM', encerrada_em: noPrazo,
    });
  });
  it('contato tardio → NEGLIGENCIADA com contato, encerra', () => {
    expect(transicao(ret({ status: 'NEGLIGENCIADA' }), { sinal: msg(vencido), agora: vencido }, CFG)).toEqual({
      status: 'NEGLIGENCIADA', contato_em: vencido, contato_sinal: 'MENSAGEM', encerrada_em: vencido,
    });
  });
  it('sem sinal e prazo vencido → NEGLIGENCIADA, segue aberta', () => {
    expect(transicao(ret(), { sinal: null, saldo: 5, agora: vencido }, CFG)).toEqual({ status: 'NEGLIGENCIADA' });
  });
  it('saldo zerou dentro do prazo → CANCELADA', () => {
    expect(transicao(ret(), { sinal: null, saldo: 0, agora: noPrazo }, CFG)).toEqual({
      status: 'CANCELADA', cancelada_em: noPrazo, encerrada_em: noPrazo,
    });
  });
  it('saldo desconhecido não cancela', () => {
    expect(transicao(ret(), { sinal: null, agora: noPrazo }, CFG)).toBeNull();
  });
  it('dentro do prazo com saldo: nada a gravar', () => {
    expect(transicao(ret(), { sinal: null, saldo: 3, agora: noPrazo }, CFG)).toBeNull();
  });
  it('NEGLIGENCIADA com saldo zero encerra sem mudar estado', () => {
    expect(transicao(ret({ status: 'NEGLIGENCIADA' }), { sinal: null, saldo: 0, agora: vencido }, CFG)).toEqual({ encerrada_em: vencido });
  });
  it('NEGLIGENCIADA com saldo desconhecido segue', () => {
    expect(transicao(ret({ status: 'NEGLIGENCIADA' }), { sinal: null, agora: vencido }, CFG)).toBeNull();
  });
  it('sai da lista aos 15 dias da geração', () => {
    const quinze = d('2026-11-25T05:00:00-04:00');
    expect(transicao(ret({ status: 'NEGLIGENCIADA' }), { sinal: null, saldo: 5, agora: new Date(quinze.getTime() - 1) }, CFG)).toBeNull();
    expect(transicao(ret({ status: 'NEGLIGENCIADA' }), { sinal: null, saldo: 5, agora: quinze }, CFG)).toEqual({ encerrada_em: quinze });
  });
  it('já encerrado: nada', () => {
    expect(transicao(ret({ encerrada_em: noPrazo }), { sinal: msg(noPrazo), agora: noPrazo }, CFG)).toBeNull();
  });
});

describe('conversao', () => {
  it('devolução parcial desconta quantidade e valor', () => {
    const r = conversao(ret(), [nf({ emissao: '2026-11-12', quantidade: 3, liquido: 450 }), nf({ emissao: '2026-11-14', devolucao: true, quantidade: 1, liquido: 150 })], CFG);
    expect(r).toEqual({ convertida_em: d('2026-11-12T00:00:00Z'), convertida_qtd: 2, convertida_valor: 300 });
  });
  it('devolução total = não converteu', () => {
    const r = conversao(ret(), [nf({ quantidade: 2 }), nf({ devolucao: true, quantidade: 2 })], CFG);
    expect(r).toEqual({ convertida_em: null, convertida_qtd: null, convertida_valor: null });
  });
  it('janela: do dia da geração até +15 dias', () => {
    expect(conversao(ret(), [nf({ emissao: '2026-11-09' })], CFG).convertida_qtd).toBeNull();
    expect(conversao(ret(), [nf({ emissao: '2026-11-26' })], CFG).convertida_qtd).toBeNull();
    expect(conversao(ret(), [nf({ emissao: '2026-11-10' })], CFG).convertida_qtd).toBe(2);
    expect(conversao(ret(), [nf({ emissao: '2026-11-25' })], CFG).convertida_qtd).toBe(2);
  });
});

describe('converteuSemContato', () => {
  const conv = { convertida_em: d('2026-11-12T00:00:00Z'), convertida_qtd: 2 };
  it.each([
    ['NEGLIGENCIADA sem contato', { status: 'NEGLIGENCIADA', ...conv }, true],
    ['contato foi a própria venda', { status: 'NEGLIGENCIADA', ...conv, contato_em: d('2026-11-12T10:00:00-04:00'), contato_sinal: 'VENDA' }, true],
    ['contato depois do dia da venda', { status: 'NEGLIGENCIADA', ...conv, contato_em: d('2026-11-13T10:00:00-04:00'), contato_sinal: 'MENSAGEM' }, true],
    ['contato no dia da venda', { status: 'NEGLIGENCIADA', ...conv, contato_em: d('2026-11-12T10:00:00-04:00'), contato_sinal: 'MENSAGEM' }, false],
    ['CONTATADA', { status: 'CONTATADA', ...conv, contato_em: d('2026-11-11'), contato_sinal: 'MENSAGEM' }, false],
    ['não converteu', { status: 'NEGLIGENCIADA' }, false],
  ] as const)('%s', (_, over, esperado) => {
    expect(converteuSemContato(ret(over as Partial<Retorno>))).toBe(esperado);
  });
});

describe('agruparPorCliente', () => {
  it('dois produtos do cliente = um grupo; atrasadas primeiro; prazo mais próximo', () => {
    const g = agruparPorCliente(
      [
        ret({ id: 'a', prazo_em: d('2026-11-15T05:00:00-04:00') }),
        ret({ id: 'b', pro_codigo: 501, prazo_em: d('2026-11-14T05:00:00-04:00') }),
        ret({ id: 'c', cli_codigo: 20, cli_nome: 'Y', prazo_em: d('2026-11-16T05:00:00-04:00'), status: 'NEGLIGENCIADA' }),
        ret({ id: 'd', cli_codigo: 30, cli_nome: 'Z', prazo_em: d('2026-11-13T05:00:00-04:00') }),
      ],
      new Map([[10, '65999990000']]),
    );
    expect(g.map((x) => x.cli_codigo)).toEqual([20, 30, 10]);
    expect(g[0].atrasada).toBe(true);
    const x = g[2];
    expect(x).toMatchObject({ fone: '65999990000', atrasada: false, prazo_em: d('2026-11-14T05:00:00-04:00').toISOString() });
    expect(x.produtos.map((p) => p.id)).toEqual(['b', 'a']);
    expect(x.produtos[0]).toMatchObject({ quantidade_pedida: 2, saldo_na_geracao: 5, status: 'ABERTA' });
    expect(g[1].fone).toBeNull();
  });
  it('mesmo cliente em vendedores diferentes = grupos diferentes', () => {
    expect(agruparPorCliente([ret(), ret({ id: 'b', rep_codigo: 8 })], new Map())).toHaveLength(2);
  });
});

describe('resumirRetornos', () => {
  const dec = (n: number) => ({ toString: () => String(n) }); // Prisma.Decimal
  const linhas = [
    ret({ status: 'CONTATADA' }),
    ret({ status: 'NEGLIGENCIADA', convertida_em: d('2026-11-12'), convertida_qtd: dec(2), convertida_valor: dec(300.5) }),
    ret({ status: 'CANCELADA' }),
    ret({ status: 'ABERTA' }),
    ret({ rep_codigo: 8, rep_nome: 'Bia', status: 'CONTATADA', contato_em: d('2026-11-11'), contato_sinal: 'MENSAGEM', convertida_em: d('2026-11-12'), convertida_qtd: 1, convertida_valor: 100 }),
  ];
  it('conta por vendedor e no total, com o invariante da soma', () => {
    const r = resumirRetornos(linhas);
    expect(r.vendedores.map((v) => v.rep_codigo)).toEqual([7, 8]);
    expect(r.vendedores[0]).toMatchObject({
      rep_nome: 'Ana', geradas: 4, contatadas_no_prazo: 1, negligenciadas: 1, canceladas: 1, em_aberto: 1,
      convertidas: { valor: 300.5, quantidade: 1 }, convertidas_sem_contato: { valor: 300.5, quantidade: 1 },
    });
    expect(r.total).toEqual({
      geradas: 5, contatadas_no_prazo: 2, negligenciadas: 1, canceladas: 1, em_aberto: 1,
      convertidas: { valor: 400.5, quantidade: 2 }, convertidas_sem_contato: { valor: 300.5, quantidade: 1 },
    });
    for (const l of [...r.vendedores, r.total]) {
      expect(l.geradas).toBe(l.contatadas_no_prazo + l.negligenciadas + l.canceladas + l.em_aberto);
    }
  });
  it('vazio', () => {
    expect(resumirRetornos([]).vendedores).toEqual([]);
  });
});
