import {
  comOfertas,
  OfertaParaOrcamento,
  conferirItem,
  conflito,
  cruza,
  excedeLimite,
  foraDaBolsa,
  ItemExistente,
  minimoOferta,
  niveisDaTabela,
  resolverCondicoes,
  NivelOferta,
  precoNoNivel,
  montarPorMarca,
  msgPar,
  msgTeto,
  motivoEncerramento,
  precoDaOferta,
  precoT5Sugerido,
  reaprova,
  restam,
  vigente,
} from './oferta';

const base = {
  tipo: 'LIQUIDACAO' as const,
  custo: 100,
  piso: 1.3,
  t2: { preco: 130, tabela: 200, minimoRegua: 150 },
  t5: { preco: null, tabela: 220, minimoRegua: 160 },
  inicio: '2026-11-17',
  fim: '2026-12-16',
  qtd_minima: 1,
  niveis: [] as NivelOferta[],
  pro_codigo: 1,
  par_pro_codigo: null as number | null,
  par_proporcao: null as number | null,
};

describe('agarradinho: cadastro do par (critério 10)', () => {
  it('par igual ao item e proporção 0 recusam; par válido passa', () => {
    expect(conferirItem({ ...base, par_pro_codigo: 1, par_proporcao: 1 })).toEqual(['O par não pode ser o próprio produto.']);
    expect(conferirItem({ ...base, par_pro_codigo: 2, par_proporcao: 0 })).toEqual(['Proporção do par deve ser maior que zero.']);
    expect(conferirItem({ ...base, par_pro_codigo: 2, par_proporcao: 2 })).toEqual([]);
  });
});

describe('tipo e mínimo', () => {
  it('liquidação e campanha ficam fora da bolsa; promoção não', () => {
    expect(foraDaBolsa('LIQUIDACAO')).toBe(true);
    expect(foraDaBolsa('CAMPANHA')).toBe(true);
    expect(foraDaBolsa('PROMOCAO')).toBe(false);
  });
  it('liquidação = custo × piso; promoção = mínimo da régua', () => {
    expect(minimoOferta('LIQUIDACAO', 100, 150, 1.3)).toBe(130);
    expect(minimoOferta('PROMOCAO', 100, 150, 1.3)).toBe(150);
  });
});

describe('conferirItem', () => {
  it('critério 2: liquidação a custo 100 recusa 129,99 e aceita 130,00', () => {
    expect(conferirItem({ ...base, t2: { ...base.t2, preco: 129.99 } })).toHaveLength(1);
    expect(conferirItem(base)).toEqual([]);
  });
  it('critério 2: promoção abaixo do mínimo da régua recusa', () => {
    const e = conferirItem({ ...base, tipo: 'PROMOCAO', t2: { ...base.t2, preco: 149.99 } });
    expect(e[0]).toContain('abaixo do mínimo (150.00)');
    expect(conferirItem({ ...base, tipo: 'PROMOCAO', t2: { ...base.t2, preco: 150 } })).toEqual([]);
  });
  it('critério 3: preço igual ou acima da tabela recusa; sem custo recusa', () => {
    expect(conferirItem({ ...base, t2: { ...base.t2, preco: 200 } })[0]).toContain('menor que a tabela');
    expect(conferirItem({ ...base, t2: { ...base.t2, preco: 210 } })[0]).toContain('menor que a tabela');
    expect(conferirItem({ ...base, custo: null })).toContain('Produto sem custo no ERP.');
    expect(conferirItem({ ...base, custo: 0 })).toContain('Produto sem custo no ERP.');
  });
  it('preço zero, sem tabela, nenhum preço e início depois do fim', () => {
    expect(conferirItem({ ...base, t2: { ...base.t2, preco: 0 } })[0]).toContain('maior que zero');
    expect(conferirItem({ ...base, t5: { preco: 150, tabela: null, minimoRegua: null } })).toContain('Produto sem preço na tabela 5.');
    expect(conferirItem({ ...base, t2: { ...base.t2, preco: null } })).toContain('Informe o preço de ao menos uma tabela.');
    expect(conferirItem({ ...base, inicio: '2026-12-17' })).toContain('Início depois do fim.');
  });
  it('preço nulo numa tabela não confere aquela tabela', () => {
    expect(conferirItem({ ...base, t2: { preco: null, tabela: 0, minimoRegua: null }, t5: { preco: 140, tabela: 220, minimoRegua: 160 } })).toEqual([]);
  });
});

describe('sobreposição', () => {
  const outros: ItemExistente[] = [
    { id: 1, pro_codigo: 50129, status: 'RASCUNHO', grupo: 'Black Friday', inicio: '2026-11-17', fim: '2026-12-16' },
  ];
  it('cruza com fim inclusivo', () => {
    expect(cruza({ inicio: '2026-12-16', fim: '2026-12-31' }, outros[0])).toBe(true);
    expect(cruza({ inicio: '2026-12-17', fim: '2026-12-31' }, outros[0])).toBe(false);
  });
  it('critério 4: 10/12–31/12 recusa com grupo e período; 17/12 em diante aceita', () => {
    expect(conflito({ pro_codigo: 50129, inicio: '2026-12-10', fim: '2026-12-31' }, outros)).toBe(
      'Produto 50129 já está na oferta "Black Friday" de 17/11/2026 a 16/12/2026.',
    );
    expect(conflito({ pro_codigo: 50129, inicio: '2026-12-17', fim: '2026-12-31' }, outros)).toBeNull();
  });
  it('ignora o próprio item, outro produto e encerrado', () => {
    const p = { pro_codigo: 50129, inicio: '2026-12-10', fim: '2026-12-31' };
    expect(conflito({ ...p, id: 1 }, outros)).toBeNull();
    expect(conflito({ ...p, pro_codigo: 1 }, outros)).toBeNull();
    expect(conflito(p, [{ ...outros[0], status: 'ENCERRADO' }])).toBeNull();
  });
});

describe('decisão 22: preço da tabela 5 sugerido', () => {
  it('mesmo percentual de desconto da tabela 2', () => {
    expect(precoT5Sugerido(180, 200, 220, 150)).toBe(198);
  });
  it('limitado ao mínimo; sem tabela 5 não sugere', () => {
    expect(precoT5Sugerido(100, 200, 220, 130)).toBe(130);
    expect(precoT5Sugerido(180, 200, 0, 150)).toBeNull();
  });
});

describe('vigência e limite', () => {
  const item = { status: 'APROVADO' as const, inicio: '2026-11-17', fim: '2026-12-16', limite_qtd: 10 };
  it('critério 11: limite 10, vendidas 7 → restam 3; 10 vendidas → LIMITE', () => {
    expect(restam(10, 7)).toBe(3);
    expect(restam(null, 7)).toBeNull();
    expect(motivoEncerramento(item, '2026-11-20', 10, 5)).toBe('LIMITE');
    expect(motivoEncerramento(item, '2026-11-20', 7, 5)).toBeNull();
  });
  it('encerra por data (fim inclusivo) e por saldo', () => {
    expect(motivoEncerramento(item, '2026-12-16', 0, 5)).toBeNull();
    expect(motivoEncerramento(item, '2026-12-17', 0, 5)).toBe('DATA');
    expect(motivoEncerramento(item, '2026-11-20', 0, 0)).toBe('SALDO');
  });
  it('critério 10: fora do período, pendente, encerrado ou sem saldo não é oferta', () => {
    expect(vigente(item, '2026-11-17', 7, 5)).toBe(true);
    expect(vigente(item, '2026-11-16', 0, 5)).toBe(false);
    expect(vigente(item, '2026-12-17', 0, 5)).toBe(false);
    expect(vigente({ ...item, status: 'PENDENTE' }, '2026-11-20', 0, 5)).toBe(false);
    expect(vigente({ ...item, status: 'ENCERRADO' }, '2026-11-20', 0, 5)).toBe(false);
    expect(vigente(item, '2026-11-20', 0, 0)).toBe(false);
    expect(vigente(item, '2026-11-20', 10, 5)).toBe(false);
  });
});

describe('reaprova', () => {
  const a = { preco_t2: 130, preco_t5: 140, inicio: '2026-11-17', fim: '2026-12-16', limite_qtd: 10, tipo: 'LIQUIDACAO' as const, premio_valor: 0.05, limite_cliente: null, qtd_minima: 1, niveis: [] as NivelOferta[], par_pro_codigo: null as number | null, par_descricao: null, par_proporcao: null as number | null };
  it('mudou preço, datas, limite, tipo ou bônus', () => {
    expect(reaprova(a, { ...a, tipo: 'PROMOCAO' })).toBe(true);
    expect(reaprova(a, { ...a, premio_valor: 0.08 })).toBe(true);
    expect(reaprova(a, { ...a })).toBe(false);
    expect(reaprova(a, { ...a, preco_t2: 131 })).toBe(true);
    expect(reaprova(a, { ...a, preco_t5: null })).toBe(true);
    expect(reaprova(a, { ...a, fim: '2026-12-20' })).toBe(true);
    expect(reaprova(a, { ...a, limite_qtd: null })).toBe(true);
    expect(reaprova(a, { ...a, limite_cliente: 10 })).toBe(true);
    expect(reaprova(a, { ...a, qtd_minima: 6 })).toBe(true);
    expect(reaprova(a, { ...a, niveis: [{ a_partir_de: 6, preco_t2: 125, preco_t5: null }] })).toBe(true);
    expect(reaprova({ ...a, niveis: [{ a_partir_de: 6, preco_t2: 125, preco_t5: null }] }, { ...a, niveis: [{ a_partir_de: 6, preco_t2: 125, preco_t5: null }] })).toBe(false);
    // jsonb devolve as chaves em outra ordem: mesmo nível não reaprova
    expect(reaprova({ ...a, niveis: [{ preco_t2: 85, preco_t5: 88, a_partir_de: 6 }] }, { ...a, niveis: [{ a_partir_de: 6, preco_t2: 85, preco_t5: 88 }] })).toBe(false);
    expect(reaprova(a, { ...a, par_pro_codigo: 2, par_proporcao: 1 })).toBe(true);
    expect(reaprova({ ...a, par_pro_codigo: 2, par_proporcao: 1 }, { ...a, par_pro_codigo: 2, par_proporcao: 2 })).toBe(true);
  });
});

describe('decisão 23: preço da oferta pela coluna do preço normal', () => {
  const o = { preco_t2: 130, preco_t5: 150 };
  it('PRECO2 → preco_t2, PRECO5 → preco_t5, outra coluna → null', () => {
    expect(precoDaOferta(o, 'PRECO2', 200)).toBe(130);
    expect(precoDaOferta(o, 'PRECO5', 220)).toBe(150);
    expect(precoDaOferta(o, 'PRECO_VENDA', 300)).toBeNull();
  });
  it('tabela 5 por substituição usa a coluna de onde veio o preço; oferta ≥ normal não aplica', () => {
    expect(precoDaOferta(o, 'PRECO2', 200)).toBe(130);
    expect(precoDaOferta(o, 'PRECO2', 130)).toBeNull();
    expect(precoDaOferta({ preco_t2: 130, preco_t5: null }, 'PRECO5', 220)).toBeNull();
  });
});

describe('comOfertas (orçamento lê as ofertas)', () => {
  const hoje = '2026-11-20';
  const oferta = (o: Partial<OfertaParaOrcamento> = {}): OfertaParaOrcamento => ({
    id: 7, pro_codigo: 1, preco_t2: 80, preco_t5: 90, inicio: '2026-11-17', fim: '2026-12-16',
    limite_qtd: null, status: 'APROVADO', tipo: 'LIQUIDACAO', grupo: 'Liquida verão', vendidas: 0, limite_cliente: null, qtd_minima: 1, niveis: [], par_pro_codigo: null, par_descricao: null, par_proporcao: null, vendidas_cliente: 0, premio: null, ...o,
  });
  const prod = (o: Record<string, number> = {}) => ({ PRO_CODIGO: 1, ESTOQUE_DISPONIVEL: 5, PRECO2: 100, PRECO5: 110, PRECO_VENDA: 150, ...o });
  const rodar = (ofertas: OfertaParaOrcamento[], tabela = '2', p = prod(), promos = new Map()) =>
    comOfertas(promos, ofertas, [p], tabela, hoje).get(1) ?? null;

  it('critério 8: tabela 2 sai com preco_t2, tabela 5 com preco_t5', () => {
    expect(rodar([oferta()], '2')).toMatchObject({ prom_codigo: -1, valor: 80, descricao: 'Liquida verão', data_final: '2026-12-16', valor_balcao: null, oferta: { item_id: 7, tipo: 'LIQUIDACAO', restam: null } });
    expect(rodar([oferta()], '5')?.valor).toBe(90);
  });

  it('critério 10: fora do período, pendente, encerrado, sem saldo e limite atingido não entram', () => {
    expect(rodar([oferta({ inicio: '2026-11-21' })])).toBeNull();
    expect(rodar([oferta({ fim: '2026-11-19' })])).toBeNull();
    expect(rodar([oferta({ status: 'PENDENTE' })])).toBeNull();
    expect(rodar([oferta({ status: 'ENCERRADO' })])).toBeNull();
    expect(rodar([oferta()], '2', prod({ ESTOQUE_DISPONIVEL: 0 }))).toBeNull();
    expect(rodar([oferta({ limite_qtd: 10, vendidas: 10 })])).toBeNull();
    expect(rodar([oferta({ limite_qtd: 10, vendidas: 7 })])?.oferta?.restam).toBe(3);
  });

  it('máximo por cliente: leva o teto e o que resta para o cliente', () => {
    expect(rodar([oferta({ limite_cliente: 10, vendidas_cliente: 6 })])?.oferta).toMatchObject({ limite_cliente: 10, restam_cliente: 4 });
    expect(rodar([oferta()])?.oferta).toMatchObject({ limite_cliente: null, restam_cliente: null });
  });

  it('preço progressivo: leva qtd_minima e os níveis da tabela do cliente', () => {
    const niveis = [{ a_partir_de: 6, preco_t2: 75, preco_t5: null }];
    expect(rodar([oferta({ qtd_minima: 2, niveis })])?.oferta).toMatchObject({ qtd_minima: 2, niveis: [{ a_partir_de: 6, preco: 75 }] });
    expect(rodar([oferta({ qtd_minima: 2, niveis })], '5')?.oferta).toMatchObject({ qtd_minima: 2, niveis: [] });
  });

  it('critério 10: par sem saldo não entra (sem encerrar); com saldo leva o par', () => {
    const casada = oferta({ par_pro_codigo: 2, par_descricao: 'Cola', par_proporcao: 2 });
    expect(comOfertas(new Map(), [casada], [prod()], '2', hoje).get(1)).toBeUndefined();
    expect(comOfertas(new Map(), [casada], [prod()], '2', hoje, new Map([[2, 0]])).get(1)).toBeUndefined();
    expect(comOfertas(new Map(), [casada], [prod()], '2', hoje, new Map([[2, 3]])).get(1)?.oferta?.par).toEqual({ pro_codigo: 2, descricao: 'Cola', proporcao: 2 });
    expect(motivoEncerramento(casada, hoje, 0, 5)).toBeNull();
    expect(rodar([oferta()])?.oferta?.par).toBeNull();
  });

  it('critério 14: produto já no mapa pelo portal fica com o portal', () => {
    const portal = { pro_codigo: 1, prom_codigo: 0, descricao: 'Portal', data_final: '2026-11-30', somente_avista: false, durar_estoque: false, valor: 95, valor_balcao: null };
    expect(rodar([oferta()], '2', prod(), new Map([[1, portal]]))).toBe(portal);
  });

  it('decisão 23: tabela substituída segue a coluna; oferta ≥ normal não entra', () => {
    // cliente da 5 sem PRECO5: o normal vem da PRECO2, vale preco_t2
    expect(rodar([oferta()], '5', prod({ PRECO5: 0 }))?.valor).toBe(80);
    // substituição para PRECO_VENDA: nenhuma coluna da oferta
    expect(rodar([oferta()], '2', prod({ PRECO2: 0, PRECO5: 0 }))).toBeNull();
    expect(rodar([oferta({ preco_t2: 100 })])).toBeNull();
    expect(rodar([oferta({ preco_t5: null })], '5')).toBeNull();
  });

  it('ganho por unidade: liquidação sobre o custo, campanha em R$ ou % do preço, promoção sem ganho', () => {
    const liq = rodar([oferta({ premio: { tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] } })], '2', prod({ PRECO_CUSTO: 180 }));
    expect(liq?.oferta).toMatchObject({ ganho_unit: 9, proxima_faixa: null });
    const camp = rodar([oferta({ tipo: 'CAMPANHA', premio: { tipo: 'VALOR_UNIDADE', valor: 3, faixas: [{ a_partir_de: 50, valor: 4 }] } })]);
    expect(camp?.oferta).toMatchObject({ ganho_unit: 3, proxima_faixa: { valor: 4, a_partir_de: 50 } });
    expect(rodar([oferta({ tipo: 'CAMPANHA', premio: { tipo: 'PCT_VENDA', valor: 0.02, faixas: [] } })])?.oferta?.ganho_unit).toBe(1.6);
    const promo = rodar([oferta({ tipo: 'PROMOCAO' })])?.oferta;
    expect(promo).toBeDefined();
    expect(promo).not.toHaveProperty('ganho_unit');
    expect(promo).not.toHaveProperty('proxima_faixa');
  });

  it('critérios 1 e 2: grupo misto — cada item sai com o seu tipo e o bônus do seu percentual', () => {
    const ofertas = [
      oferta({ id: 7, pro_codigo: 1, tipo: 'PROMOCAO' }),
      oferta({ id: 8, pro_codigo: 2, premio: { tipo: 'PCT_CUSTO', valor: 0.08, faixas: [] } }),
      oferta({ id: 9, pro_codigo: 3, premio: { tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] } }),
    ];
    const ps = [1, 2, 3].map((c) => prod({ PRO_CODIGO: c, PRECO_CUSTO: 180 }));
    const r = comOfertas(new Map(), ofertas, ps, '2', hoje);
    expect(r.get(1)?.oferta?.tipo).toBe('PROMOCAO');
    expect(r.get(1)?.oferta).not.toHaveProperty('ganho_unit');
    expect(r.get(2)?.oferta).toMatchObject({ tipo: 'LIQUIDACAO', ganho_unit: 14.4 });
    expect(r.get(3)?.oferta).toMatchObject({ tipo: 'LIQUIDACAO', ganho_unit: 9 });
  });
});

describe('excedeLimite (limite da oferta no orçamento)', () => {
  // critério 11: limite 10, vendidas 7 → restam 3
  const restamPorItem = new Map<number, number | null>([[5, restam(10, 7)], [6, null]]);
  const linha = (quantidade: number, extra = {}) => ({ item: 1, descricao: 'Palheta', quantidade, oferta_item_id: 5, ...extra });

  it('3 unidades aceita; 4 recusa dizendo que restam 3', () => {
    expect(excedeLimite([linha(3)], restamPorItem)).toEqual([]);
    expect(excedeLimite([linha(4)], restamPorItem)).toEqual(['Item 1 (Palheta): restam 3 unidades na oferta — reduza a quantidade ou venda fora da oferta.']);
  });

  it('soma as linhas do mesmo item; vendida fora e item sem limite não contam', () => {
    expect(excedeLimite([linha(2), linha(2, { item: 2 })], restamPorItem)).toEqual([expect.stringMatching(/^Item 2 \(Palheta\): restam 3 /)]);
    expect(excedeLimite([linha(3), linha(9, { item: 2, fora_promocao: true })], restamPorItem)).toEqual([]);
    expect(excedeLimite([linha(99, { oferta_item_id: 6 }), linha(99, { oferta_item_id: null })], restamPorItem)).toEqual([]);
  });
});

describe('montarPorMarca', () => {
  const p = { pro_codigo: 1, descricao: 'A', custo: 100, saldo: 5, tabela_2: 200, tabela_5: 220, minimo_t2: 130, minimo_t5: 130 };

  it('critério 2: 10% dá tabela × 0,90 nas duas tabelas', () => {
    expect(montarPorMarca([p], 0.1).incluidos).toEqual([{ ...p, preco_t2: 180, preco_t5: 198, no_minimo: false }]);
  });
  it('abaixo de custo × 1,30 sai no mínimo e marca no_minimo', () => {
    const [i] = montarPorMarca([p], 0.4).incluidos;
    expect(i).toMatchObject({ preco_t2: 130, preco_t5: 132, no_minimo: true });
  });
  it('mínimo ≥ tabela 2, sem tabela 2 e sem custo vão para excluídos; t5 null sem tabela 5 ou com mínimo ≥ tabela 5', () => {
    const r = montarPorMarca([
      { ...p, pro_codigo: 2, tabela_2: 130 },
      { ...p, pro_codigo: 3, tabela_2: null, minimo_t2: null },
      { ...p, pro_codigo: 4, custo: null, minimo_t2: null, minimo_t5: null },
      { ...p, pro_codigo: 5, tabela_5: null, minimo_t5: null },
      { ...p, pro_codigo: 6, tabela_5: 125 },
    ], 0.1);
    expect(r.excluidos).toEqual([
      { pro_codigo: 2, descricao: 'A', motivo: 'Mínimo 130.00 maior ou igual à tabela 130.00.' },
      { pro_codigo: 3, descricao: 'A', motivo: 'Produto sem preço na tabela 2.' },
      { pro_codigo: 4, descricao: 'A', motivo: 'Produto sem custo no ERP.' },
    ]);
    expect(r.incluidos.map((i) => [i.pro_codigo, i.preco_t5])).toEqual([[5, null], [6, null]]);
  });
});

describe('máximo por cliente (critérios 4 e 5)', () => {
  // teto 10; o cliente A já fechou 6, o cliente B nenhum; item 6 sem teto
  const teto = new Map<number, number | null>([[5, 10], [6, null]]);
  const doCliente = (fechadas: number) => new Map<number, number | null>([[5, restam(10, fechadas)], [6, null]]);
  const linha = (quantidade: number, extra = {}) => ({ item: 1, descricao: 'Palheta', quantidade, oferta_item_id: 5, ...extra });
  const recusa = (linhas: ReturnType<typeof linha>[], fechadas: number) => excedeLimite(linhas, doCliente(fechadas), msgTeto(teto));

  it('cliente com 6 fechadas: 5 recusa dizendo restam 4; 4 passa', () => {
    expect(recusa([linha(5)], 6)).toEqual(['Item 1 (Palheta): máximo de 10 por cliente na oferta — restam 4 para este cliente; reduza a quantidade ou venda fora da oferta.']);
    expect(recusa([linha(4)], 6)).toEqual([]);
  });

  it('outro cliente (0 fechadas) passa; item sem teto passa; linha fora da oferta não conta', () => {
    expect(recusa([linha(5)], 0)).toEqual([]);
    expect(recusa([linha(99, { oferta_item_id: 6 })], 6)).toEqual([]);
    expect(recusa([linha(4), linha(9, { item: 2, fora_promocao: true })], 6)).toEqual([]);
  });
});

describe('preço progressivo', () => {
  const niveis = [{ a_partir_de: 6, preco: 85 }, { a_partir_de: 12, preco: 80 }];
  it('critério 6: tabela 100, 90 a partir de 1, 85 de 6, 80 de 12', () => {
    expect(precoNoNivel(90, 1, niveis, 5)).toBe(90);
    expect(precoNoNivel(90, 1, niveis, 6)).toBe(85);
    expect(precoNoNivel(90, 1, niveis, 12)).toBe(80);
    expect(precoNoNivel(90, 1, niveis, 30)).toBe(80);
  });
  it('critério 7: primeiro nível em 6, 5 un fica fora da oferta', () => {
    expect(precoNoNivel(90, 6, [], 5)).toBeNull();
    expect(precoNoNivel(90, 6, [], 6)).toBe(90);
  });
  it('níveis da tabela do cliente, só os com preço', () => {
    const item = { niveis: [{ a_partir_de: 6, preco_t2: 85, preco_t5: null }, { a_partir_de: 12, preco_t2: 80, preco_t5: 95 }] };
    expect(niveisDaTabela(item, 'PRECO2', 100)).toEqual([{ a_partir_de: 6, preco: 85 }, { a_partir_de: 12, preco: 80 }]);
    expect(niveisDaTabela(item, 'PRECO5', 110)).toEqual([{ a_partir_de: 12, preco: 95 }]);
    expect(niveisDaTabela(item, 'PRECO1', 100)).toEqual([]);
  });
  describe('critério 8: cadastro dos níveis', () => {
    const c = { ...base, t2: { ...base.t2, preco: 150 }, niveis: [{ a_partir_de: 6, preco_t2: 140, preco_t5: null }, { a_partir_de: 12, preco_t2: 135, preco_t5: null }] };
    it('níveis válidos passam', () => expect(conferirItem(c)).toEqual([]));
    it('quantidade não crescente recusa', () => {
      expect(conferirItem({ ...c, niveis: [c.niveis[0], { ...c.niveis[1], a_partir_de: 6 }] })[0]).toContain('maior que a do nível anterior');
      expect(conferirItem({ ...c, qtd_minima: 6 })[0]).toContain('Nível 2: a quantidade (6)');
    });
    it('preço maior ou igual ao anterior recusa', () => {
      expect(conferirItem({ ...c, niveis: [c.niveis[0], { ...c.niveis[1], preco_t2: 140 }] })[0]).toContain('menor que o do nível anterior (140.00)');
      expect(conferirItem({ ...c, niveis: [{ ...c.niveis[0], preco_t2: 150 }] })[0]).toContain('menor que o do nível anterior (150.00)');
    });
    it('preço abaixo do mínimo recusa', () => {
      expect(conferirItem({ ...c, niveis: [{ ...c.niveis[0], preco_t2: 129.99 }] })[0]).toContain('abaixo do mínimo (130.00)');
    });
    it('nível sem preço, preço sem base, mais de 2 níveis e quantidade mínima < 1', () => {
      expect(conferirItem({ ...c, niveis: [{ ...c.niveis[0], preco_t2: null }] })).toContain('Nível 2 sem preço na tabela 2.');
      expect(conferirItem({ ...c, niveis: [{ ...c.niveis[0], preco_t5: 140 }] })[0]).toContain('tabela 5, que não tem preço');
      expect(conferirItem({ ...c, niveis: [...c.niveis, { a_partir_de: 20, preco_t2: 131, preco_t5: null }] })).toContain('No máximo 2 níveis além do primeiro.');
      expect(conferirItem({ ...c, qtd_minima: 0 })).toContain('Quantidade do primeiro nível deve ser ao menos 1.');
    });
  });
});

describe('resolverCondicoes (preço do item no orçamento)', () => {
  const cond = (o = {}) => ({ item_id: 7, preco: 90, qtd_minima: 1, niveis: [{ a_partir_de: 6, preco: 85 }, { a_partir_de: 12, preco: 80 }], par: null, ...o });
  it('critério 6: duas linhas do mesmo item com 4 e 8 saem a 80', () => {
    const r = resolverCondicoes([{ pro_codigo: 1, quantidade: 4, oferta_item_id: 7 }, { pro_codigo: 1, quantidade: 8, oferta_item_id: 7 }], [cond()]);
    expect(r.get(7)).toEqual({ preco: 80, liberado: null });
  });
  it('critério 7: primeiro nível em 6 com 5 un fica fora da oferta', () => {
    expect(resolverCondicoes([{ pro_codigo: 1, quantidade: 5, oferta_item_id: 7 }], [cond({ qtd_minima: 6, niveis: [] })]).get(7)?.preco).toBeNull();
  });
  it('linha pedida fora (sem oferta_item_id) não soma', () => {
    const r = resolverCondicoes([{ pro_codigo: 1, quantidade: 5, oferta_item_id: 7 }, { pro_codigo: 1, quantidade: 10, oferta_item_id: null }], [cond()]);
    expect(r.get(7)?.preco).toBe(90);
  });
});

describe('agarradinho no orçamento (critério 9)', () => {
  const cond = (item_id: number) => ({ item_id, preco: 90, qtd_minima: 1, niveis: [], par: { pro_codigo: 50, proporcao: 2 } });
  const par = { pro_codigo: 50, quantidade: 3, oferta_item_id: null };
  it('1 para 2 com 3 do par e 6 do item fica na oferta', () => {
    const r = resolverCondicoes([par, { pro_codigo: 1, quantidade: 6, oferta_item_id: 7 }], [cond(7)]);
    expect(r.get(7)).toEqual({ preco: 90, liberado: 6 });
    expect(excedeLimite([{ item: 2, descricao: 'X', quantidade: 6, oferta_item_id: 7 }], new Map([[7, 6]]))).toEqual([]);
  });
  it('7 do item recusa dizendo que o par libera 6', () => {
    const liberado = resolverCondicoes([par, { pro_codigo: 1, quantidade: 7, oferta_item_id: 7 }], [cond(7)]).get(7)!.liberado;
    const erros = excedeLimite([{ item: 2, descricao: 'X', quantidade: 7, oferta_item_id: 7 }], new Map([[7, liberado]]), msgPar(new Map([[7, { pro_codigo: 50, descricao: 'PAR' }]])));
    expect(erros).toEqual(['Item 2 (X): o par 50 (PAR) libera 6 unidades na oferta — inclua mais do par ou reduza a quantidade.']);
  });
  it('sem o par a linha sai da oferta', () => {
    expect(resolverCondicoes([{ pro_codigo: 1, quantidade: 6, oferta_item_id: 7 }], [cond(7)]).get(7)).toEqual({ preco: null, liberado: 0 });
  });
  it('duas ofertas com o mesmo par são liberadas pelas mesmas unidades', () => {
    const r = resolverCondicoes([par, { pro_codigo: 1, quantidade: 6, oferta_item_id: 7 }, { pro_codigo: 2, quantidade: 6, oferta_item_id: 8 }], [cond(7), cond(8)]);
    expect([r.get(7)!.liberado, r.get(8)!.liberado]).toEqual([6, 6]);
  });
});
