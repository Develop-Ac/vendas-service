import { AnaliseItem, CandidatoEquivalente, EntradaAnaliseItem, analisarItem, analisarPacote } from './analise';

// abaixo do mínimo da régua; curva A vendida no médio do canal; varejo 20 %; estoque sobra acima do mínimo
const base: EntradaAnaliseItem = {
  preco_unit: 100, preco_minimo: 110, acima_alcada: false, quantidade: 10,
  custo_ref: 80, markup_regua: 1.58, estoque_disponivel: 50,
  giro: { curva_abc: 'A', demanda_media_dia: 2, estoque_min_sugerido: 20, qtd_varejo_12m: 20, qtd_atacado_12m: 80, venda_perdida_12m: 4 },
  canal: { medio: 100, clientes: 7, qtd: 30 },
  chegada: null,
  equivalentes: [],
};
const item = (p: Partial<EntradaAnaliseItem> = {}) => analisarItem({ ...base, ...p }) as AnaliseItem;
const giro = (p: Partial<NonNullable<EntradaAnaliseItem['giro']>>) => ({ giro: { ...base.giro!, ...p } });

describe('analisarItem — gate', () => {
  it('dentro da régua não é analisado', () => {
    expect(analisarItem({ ...base, preco_unit: 110 })).toBeNull();
    expect(analisarItem({ ...base, preco_minimo: null })).toBeNull();
  });
  it('abaixo do mínimo ou acima da alçada é analisado', () => {
    expect(analisarItem(base)).not.toBeNull();
    expect(analisarItem({ ...base, preco_unit: 120, acima_alcada: true })).not.toBeNull();
  });
  it('números crus: markup da linha, régua, cobertura e perdida', () => {
    expect(item()).toMatchObject({
      markup_linha: 1.25, markup_regua: 1.58, venda_perdida_12m: 4,
      curva: { curva_abc: 'A', medio: 100, clientes: 7, qtd: 30 },
      estoque: { saldo_apos: 40, min: 20, cobertura_dias: 20 },
    });
    expect(item({ custo_ref: null }).markup_linha).toBeNull();
    expect(item(giro({ demanda_media_dia: 0 })).estoque.cobertura_dias).toBeNull();
  });
});

describe('analisarItem — Curva', () => {
  it('curva A: abaixo de médio × 0,95 vermelho, abaixo do médio amarelo, no médio verde', () => {
    expect(item({ preco_unit: 94.99 }).curva.cor).toBe('VERMELHO');
    expect(item({ preco_unit: 95 }).curva.cor).toBe('AMARELO');
    expect(item({ preco_unit: 100, preco_minimo: 110 }).curva.cor).toBe('VERDE');
  });
  it('curva B/C/D é sempre verde', () => {
    expect(item({ preco_unit: 50, ...giro({ curva_abc: 'B' }) }).curva.cor).toBe('VERDE');
  });
  it('sem curva ou sem venda no canal é cinza', () => {
    expect(item(giro({ curva_abc: null })).curva.cor).toBe('CINZA');
    expect(item({ canal: null }).curva.cor).toBe('CINZA');
    expect(item({ canal: { medio: 0, clientes: 0, qtd: 0 } }).curva).toMatchObject({ cor: 'CINZA', medio: null });
    expect(item({ giro: null }).curva.cor).toBe('CINZA');
  });
});

describe('analisarItem — Varejo', () => {
  it('≥ 50 % vermelho, ≥ 30 % amarelo, < 30 % verde', () => {
    expect(item(giro({ qtd_varejo_12m: 50, qtd_atacado_12m: 50 })).varejo).toMatchObject({ cor: 'VERMELHO', pct_varejo: 0.5, qtd_varejo_12m: 50, qtd_atacado_12m: 50 });
    expect(item(giro({ qtd_varejo_12m: 30, qtd_atacado_12m: 70 })).varejo.cor).toBe('AMARELO');
    expect(item().varejo).toMatchObject({ cor: 'VERDE', pct_varejo: 0.2 });
  });
  it('divisão varejo × atacado do BI (canal) vale sobre a da análise de estoque', () => {
    const v = item({ canal: { ...base.canal!, qtd_varejo_12m: 93, qtd_atacado_12m: 16 } }).varejo;
    expect(v).toMatchObject({ cor: 'VERMELHO', pct_varejo: 0.8532, qtd_varejo_12m: 93, qtd_atacado_12m: 16 });
    expect(v.motivo).toBe('85% das 109 un vendidas em 12 meses saíram no varejo (93 un no balcão, 16 un no atacado): o balcão vende este item sem desconto.');
  });
  it('motivo explica cada nota', () => {
    expect(item({ preco_unit: 80 }).curva.motivo).toBe('Curva A: o atacado pagou R$ 100,00 nos últimos 90 dias (7 clientes, 30 un); o pedido de R$ 80,00 fica 20% abaixo. Este item vende sem esse desconto.');
    expect(item(giro({ curva_abc: 'B' })).curva.motivo).toMatch(/^Curva B: item de giro menor/);
    expect(item({ canal: null }).curva.motivo).toBe('Curva A, mas sem venda no atacado nos últimos 90 dias: não há preço de referência.');
    expect(item().estoque.motivo).toBe('Ficam 40 un depois deste orçamento, no mínimo sugerido (20 un) ou acima: 20 dias de cobertura.');
    expect(item({ quantidade: 45 }).estoque.motivo).toBe('Ficam 5 un depois deste orçamento, abaixo do mínimo sugerido (20 un), sem chegada prevista: o balcão fica sem.');
    expect(item({ quantidade: 45, chegada: { qtd: 30, data: '2026-11-05' } }).estoque.motivo).toBe('Ficam 5 un depois deste orçamento, abaixo do mínimo sugerido (20 un); chegam 30 un em 05/11/2026 e cobrem a falta.');
  });
  it('sem venda em 12 m é cinza', () => {
    expect(item(giro({ qtd_varejo_12m: 0, qtd_atacado_12m: 0 })).varejo).toMatchObject({ cor: 'CINZA', pct_varejo: null, qtd_varejo_12m: null });
    expect(item(giro({ qtd_varejo_12m: null, qtd_atacado_12m: null })).varejo.cor).toBe('CINZA');
  });
});

describe('analisarItem — Estoque', () => {
  it('saldo após ≥ mínimo é verde', () => {
    expect(item({ estoque_disponivel: 30 }).estoque.cor).toBe('VERDE');
  });
  it('abaixo do mínimo: amarelo se a chegada cobre, vermelho se não cobre', () => {
    const chegada = { qtd: 5, data: '2026-11-10' };
    expect(item({ estoque_disponivel: 25, chegada }).estoque).toMatchObject({ cor: 'AMARELO', saldo_apos: 15, chegada });
    expect(item({ estoque_disponivel: 24, chegada }).estoque.cor).toBe('VERMELHO');
    expect(item({ estoque_disponivel: 29 }).estoque.cor).toBe('VERMELHO');
  });
  it('sem mínimo sugerido é cinza', () => {
    expect(item(giro({ estoque_min_sugerido: null })).estoque.cor).toBe('CINZA');
  });
});

describe('analisarItem — equivalente', () => {
  const eq = (p: Partial<CandidatoEquivalente>): CandidatoEquivalente => ({ pro_codigo: 1, descricao: 'X', saldo: 100, curva: 'C', min: 10, ...p });
  const equivalentes = [
    eq({ pro_codigo: 1, saldo: 500, curva: 'A' }),            // curva A: fora
    eq({ pro_codigo: 2, saldo: 300, min: 295 }),               // 300 − 10 < 295: fora
    eq({ pro_codigo: 3, saldo: 200, min: null }),              // sem mínimo: fora
    eq({ pro_codigo: 4, saldo: 40, curva: 'B' }),
    eq({ pro_codigo: 5, saldo: 60, descricao: 'Similar', curva: 'C' }),
  ];
  it('só sugere quando Curva ou Estoque não estão verdes, pelo maior saldo elegível', () => {
    expect(item({ equivalentes }).equivalente).toBeNull();
    expect(item({ preco_unit: 90, equivalentes }).equivalente).toEqual({ pro_codigo: 5, descricao: 'Similar', saldo: 60, curva: 'C' });
    expect(item({ estoque_disponivel: 25, equivalentes }).equivalente?.pro_codigo).toBe(5);
  });
  it('nenhum elegível → null', () => {
    expect(item({ preco_unit: 90, equivalentes: equivalentes.slice(0, 3) }).equivalente).toBeNull();
  });
});

describe('analisarPacote', () => {
  const piso = { piso: 1.48, linha: 1.586, piso_item: 1.25 };
  const linha = (pro_codigo: number, preco_unit: number, quantidade: number, custo_ref: number | null) => ({ pro_codigo, preco_unit, quantidade, total: preco_unit * quantidade, custo_ref });
  it('soma receita e custo, conta itens abaixo de custo × piso do item e no custo, e os alertas', () => {
    const vermelho = item({ preco_unit: 90 });                                                  // curva vermelha
    const amarelo = item({ preco_unit: 95, ...giro({ qtd_varejo_12m: 30, qtd_atacado_12m: 70 }) }); // curva + varejo amarelos
    const r = analisarPacote([
      linha(1, 200, 2, 100),  // mk 2
      linha(2, 120, 1, 100),  // abaixo de custo × 1,25
      linha(3, 100, 1, 100),  // no custo (e abaixo de × 1,25)
      linha(4, 50, 3, null),  // sem custo: neutro
    ], [null, vermelho, amarelo, null], piso, new Set());
    expect(r).toEqual({
      receita: 770, custo: 400, markup: 1.55, piso_bolsa: 1.48, linha_4pct: 1.586,
      itens_abaixo_piso_custo: 2, itens_no_custo: 1, alertas: { vermelho: 1, amarelo: 2 },
    });
  });
  it('sem nenhum custo o markup fica nulo', () => {
    expect(analisarPacote([linha(1, 10, 1, 0)], [], piso, new Set())).toMatchObject({ receita: 10, custo: 0, markup: null, itens_no_custo: 0 });
  });
  it('serviço fica fora do pacote e o piso do item segue o parâmetro', () => {
    const r = analisarPacote([linha(1, 128, 1, 100), linha(9, 50, 1, 40)], [], { ...piso, piso_item: 1.3 }, new Set([9]));
    expect(r).toMatchObject({ receita: 128, custo: 100, itens_abaixo_piso_custo: 1, itens_no_custo: 0 });
  });
});
