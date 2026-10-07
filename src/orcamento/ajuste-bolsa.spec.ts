import { AjusteParaCasar, LinhaNf, casarAjustes, validarAjuste } from './ajuste-bolsa';

const base = {
  negativo_linha: -100, valor: -40, quantidade: 4, motivo: 'AVARIADO',
  justificativa: 'Caixa amassada no frete', proprio: false, servico: false,
};

describe('validarAjuste', () => {
  it('aceita valor entre o negativo e zero e guarda o assumido por unidade', () => {
    expect(validarAjuste(base)).toEqual({ ok: true, assumido_unit: 15 });
    expect(validarAjuste({ ...base, valor: 0 })).toEqual({ ok: true, assumido_unit: 25 });
  });
  it('recusa valor positivo, abaixo do negativo ou igual a ele', () => {
    expect(validarAjuste({ ...base, valor: 0.01 }).ok).toBe(false);
    expect(validarAjuste({ ...base, valor: -100.01 }).ok).toBe(false);
    expect(validarAjuste({ ...base, valor: -100 }).ok).toBe(false);
  });
  it('recusa o próprio orçamento e serviço', () => {
    expect(validarAjuste({ ...base, proprio: true }).ok).toBe(false);
    expect(validarAjuste({ ...base, servico: true }).ok).toBe(false);
  });
  it('exige motivo válido e justificativa de 10 caracteres sem espaços nas pontas', () => {
    expect(validarAjuste({ ...base, motivo: 'QUEBRADO' }).ok).toBe(false);
    expect(validarAjuste({ ...base, justificativa: '   curta     ' }).ok).toBe(false);
    expect(validarAjuste({ ...base, justificativa: '  1234567890 ' }).ok).toBe(true);
  });
});

const PISO = 1.5;
const dia = (d: string) => new Date(`${d}T00:00:00`);
const HOJE = dia('2026-09-30');

// custo 100 × piso 1,5 = 150; vendido a 120 → 30 negativos por unidade
const aj = (p: Partial<AjusteParaCasar> = {}): AjusteParaCasar => ({
  id: 'A', pro_codigo: 7, cli_codigo: 1, rep_codigo: 9, quantidade: 4, assumido_unit: 20, preco_unit: 120,
  importado_em: new Date('2026-09-01T14:30:00'), nf_orcamento: null, nfs_condicional: [], ...p,
});
const nf = (p: Partial<LinhaNf> = {}): LinhaNf => {
  const quantidade = p.quantidade ?? 4;
  const preco_unit = p.preco_unit ?? 120;
  return {
    empresa: 3, serie: '1', nfs: 1000, pro_codigo: 7, cli_codigo: 1, rep_codigo: 9, emissao: dia('2026-09-01'),
    devolucao: false, quantidade, preco_unit, liquido: preco_unit * quantidade, custo: 100 * quantidade, promocao: false, ...p,
  };
};
const casar = (a: AjusteParaCasar[], l: LinhaNf[], hoje = HOJE) => casarAjustes(a, l, { piso: PISO, hoje });

describe('casarAjustes — casamento', () => {
  it('fallback: mesmo cliente/produto/vendedor, NF do dia da importação casa inteira', () => {
    const r = casar([aj()], [nf()]);
    expect(r.ajustes[0]).toMatchObject({ qtd_casada: 4, efetivo: 80, situacao: 'APLICADO' });
    expect(r.linhas).toEqual([expect.objectContaining({ nfs: 1000, efetivo: 80 })]);
  });
  it('prioridade 1: NF gravada no orçamento vence outra NF mais antiga do fallback', () => {
    const r = casar([aj({ nf_orcamento: { empresa: 3, serie: '1', nfs: 2000 } })], [
      nf({ nfs: 1000, emissao: dia('2026-09-02') }),
      nf({ nfs: 2000, emissao: dia('2026-09-05'), cli_codigo: 55, rep_codigo: 77 }),
    ]);
    expect(r.ajustes[0].nfs.map((n) => n.nfs)).toEqual([2000]);
  });
  it('prioridade 2: NF do condicional, mesmo fora da janela e de outro vendedor', () => {
    const r = casar([aj({ nfs_condicional: [{ empresa: 3, serie: '1', nfs: 3000 }] })], [
      nf({ nfs: 1000, emissao: dia('2026-09-02') }),
      nf({ nfs: 3000, emissao: dia('2026-11-20'), rep_codigo: 77 }),
    ]);
    expect(r.ajustes[0].nfs.map((n) => n.nfs)).toEqual([3000]);
  });
  it('janela de 30 dias: último dia casa, dia seguinte não', () => {
    expect(casar([aj()], [nf({ emissao: dia('2026-10-01') })]).ajustes[0].qtd_casada).toBe(4);
    expect(casar([aj()], [nf({ emissao: dia('2026-10-02') })], dia('2026-10-02')).ajustes[0].qtd_casada).toBe(0);
    expect(casar([aj()], [nf({ emissao: dia('2026-08-31') })]).ajustes[0].qtd_casada).toBe(0);
  });
  it('preço da NF abaixo do orçado (além de 1 centavo) não casa', () => {
    expect(casar([aj()], [nf({ preco_unit: 119.99 })]).ajustes[0].qtd_casada).toBe(4);
    expect(casar([aj()], [nf({ preco_unit: 119.98 })]).ajustes[0].qtd_casada).toBe(0);
  });
  it('consome a quantidade por ordem de emissão entre duas NFs', () => {
    const r = casar([aj()], [
      nf({ nfs: 1002, quantidade: 3, emissao: dia('2026-09-10') }),
      nf({ nfs: 1001, quantidade: 3, emissao: dia('2026-09-03') }),
    ]);
    expect(r.ajustes[0].nfs.map((n) => [n.nfs, n.quantidade, n.efetivo])).toEqual([[1001, 3, 60], [1002, 1, 20]]);
    expect(r.ajustes[0]).toMatchObject({ qtd_casada: 4, efetivo: 80, situacao: 'APLICADO' });
  });
  it('parcial: só parte da quantidade saiu', () => {
    const r = casar([aj()], [nf({ quantidade: 1 })]);
    expect(r.ajustes[0]).toMatchObject({ qtd_casada: 1, efetivo: 20, situacao: 'PARCIAL' });
  });
  it('dois ajustes disputando a mesma linha: o importado antes leva', () => {
    const r = casar([
      aj({ id: 'novo', importado_em: new Date('2026-09-05T10:00:00') }),
      aj({ id: 'velho', importado_em: new Date('2026-09-02T10:00:00') }),
    ], [nf({ quantidade: 5, emissao: dia('2026-09-06') })]);
    expect(r.ajustes.map((a) => [a.id, a.qtd_casada])).toEqual([['novo', 1], ['velho', 4]]);
    expect(r.linhas[0].efetivo).toBe(100);
  });
});

describe('casarAjustes — efeito na bolsa', () => {
  it('limita ao negativo real da NF (custo da NF maior que o do orçamento)', () => {
    // assumido 40/un mas o negativo real é 30/un
    expect(casar([aj({ assumido_unit: 40 })], [nf()]).ajustes[0].efetivo).toBe(120);
    // custo subiu: negativo real 50/un, o assumido (20/un) segue sendo o limite
    expect(casar([aj()], [nf({ custo: 113.33 * 4 })]).ajustes[0].efetivo).toBe(80);
    // NF sem negativo: nada
    expect(casar([aj()], [nf({ liquido: 600 })]).ajustes[0].efetivo).toBe(0);
  });
  it('negativo real proporcional à quantidade casada', () => {
    // linha de 10 un, negativo real 300; casa 4 → 120; assumido 40 × 4 = 160 → 120
    expect(casar([aj({ assumido_unit: 40 })], [nf({ quantidade: 10 })]).ajustes[0].efetivo).toBe(120);
  });
  it('promoção: só metade do negativo real, a outra metade já é absorvida', () => {
    expect(casar([aj({ assumido_unit: 40 })], [nf({ promocao: true })]).ajustes[0].efetivo).toBe(60);
  });
  it('devolução depois da venda estorna o assumido das unidades devolvidas', () => {
    const r = casar([aj()], [
      nf({ emissao: dia('2026-09-02') }),
      nf({ nfs: 5000, devolucao: true, quantidade: 3, emissao: dia('2026-09-20'), rep_codigo: 0 }),
    ]);
    expect(r.ajustes[0].efetivo).toBe(20);
    expect(r.ajustes[0].nfs[1]).toMatchObject({ nfs: 5000, quantidade: 3, efetivo: -60, devolucao: true });
    expect(r.linhas.map((l) => [l.nfs, l.efetivo])).toEqual([[1000, 80], [5000, -60]]);
  });
  it('devolução não estorna além da qtd casada nem do que foi creditado', () => {
    const r = casar([aj({ assumido_unit: 40 })], [
      nf({ quantidade: 2, emissao: dia('2026-09-02') }), // creditado 60 (negativo real)
      nf({ nfs: 5000, devolucao: true, quantidade: 10, emissao: dia('2026-09-20') }),
    ]);
    expect(r.ajustes[0].nfs[1]).toMatchObject({ quantidade: 2, efetivo: -60 });
    expect(r.ajustes[0].efetivo).toBe(0);
  });
  it('devolução anterior à venda casada não estorna', () => {
    const r = casar([aj()], [
      nf({ emissao: dia('2026-09-10') }),
      nf({ nfs: 5000, devolucao: true, quantidade: 1, emissao: dia('2026-09-05') }),
    ]);
    expect(r.ajustes[0].efetivo).toBe(80);
  });
});

describe('casarAjustes — situação', () => {
  it('SEM_CELTA, AGUARDANDO_NF, EXPIRADO, PARCIAL e APLICADO', () => {
    const s = (a: AjusteParaCasar, l: LinhaNf[], hoje = HOJE) => casar([a], l, hoje).ajustes[0].situacao;
    expect(s(aj({ importado_em: null }), [nf()])).toBe('SEM_CELTA');
    expect(s(aj(), [], dia('2026-10-01'))).toBe('AGUARDANDO_NF');
    expect(s(aj(), [], dia('2026-10-02'))).toBe('EXPIRADO');
    expect(s(aj(), [nf({ quantidade: 2 })], dia('2026-12-01'))).toBe('PARCIAL');
    expect(s(aj(), [nf()])).toBe('APLICADO');
  });
});
