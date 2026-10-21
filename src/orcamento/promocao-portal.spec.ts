import { corpoParaCelta } from './celta';
import { bolsaDoOrcamento } from './extrato-bolsa';
import { PromocaoItem } from './orcamento.erp.repository';
import { comPromosDoPortal, PROMOCAO_PORTAL, PromosPortal } from './orcamento.service';

const portal = (pro: number, preco: number, fim: string): PromosPortal =>
  new Map([[pro, { preco, fim: new Date(`${fim}T00:00:00Z`), descricao: 'Promoção do portal B2B' }]]);

describe('comPromosDoPortal', () => {
  it('a promoção do portal entra como promoção, com o código do portal e o preço visto', () => {
    const promos = comPromosDoPortal(new Map(), portal(10, 89.9, '2026-11-30'), '2026-10-22');
    expect(promos.get(10)).toEqual(
      expect.objectContaining({ prom_codigo: PROMOCAO_PORTAL, valor: 89.9, data_final: '2026-11-30', valor_balcao: null }),
    );
  });

  it('promoção do Celta no mesmo item vence', () => {
    const celta = new Map<number, PromocaoItem>([
      [10, { pro_codigo: 10, prom_codigo: 77, descricao: 'Celta', data_final: '2026-11-01', somente_avista: false, durar_estoque: false, valor: 80, valor_balcao: null }],
    ]);
    const promos = comPromosDoPortal(celta, portal(10, 89.9, '2026-11-30'), '2026-10-22');
    expect(promos.get(10)?.prom_codigo).toBe(77);
  });

  it('promoção do portal vencida não vale; o último dia ainda vale', () => {
    expect(comPromosDoPortal(new Map(), portal(10, 89.9, '2026-10-21'), '2026-10-22').has(10)).toBe(false);
    expect(comPromosDoPortal(new Map(), portal(10, 89.9, '2026-10-22'), '2026-10-22').has(10)).toBe(true);
  });
});

describe('item em promoção do portal no orçamento', () => {
  const item = { pro_codigo: 10, quantidade: 2, preco_unit: 80, total: 160, custo_ref: 100 };

  it('metade do negativo da bolsa é da empresa, como na promoção do Celta', () => {
    const promo = bolsaDoOrcamento([{ ...item, promocao_codigo: PROMOCAO_PORTAL, fora_promocao: false }], [], 1, new Set());
    const fora = bolsaDoOrcamento([{ ...item, promocao_codigo: PROMOCAO_PORTAL, fora_promocao: true }], [], 1, new Set());
    const comum = bolsaDoOrcamento([{ ...item, promocao_codigo: null, fora_promocao: false }], [], 1, new Set());
    expect(fora).toEqual(comum);
    expect(JSON.stringify(promo)).not.toEqual(JSON.stringify(comum));
  });

  it('vai ao Celta como item normal: o código do portal não é enviado', () => {
    const corpo = corpoParaCelta({
      id: 'o1', numero: 1, cli_codigo: 1, rep_codigo: 9, cp_codigo: 7, fp_codigo: null, observacao: null,
      itens: [{ pro_codigo: 10, quantidade: 2, preco_tabela: 100, preco_unit: 80, total: 160, desc_pct: 0, promocao_codigo: PROMOCAO_PORTAL }],
    } as never);
    expect(JSON.stringify(corpo)).not.toContain('promocao');
    expect(corpo.itens[0]).toEqual(expect.objectContaining({ pro_codigo: 10, quantidade: 2 }));
  });
});
