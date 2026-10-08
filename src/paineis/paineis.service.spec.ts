import { BadRequestException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Catalogo, PaineisService } from './paineis.service';

const varejo = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalogo', 'varejo.json'), 'utf8')) as Catalogo;

const PERIODO = ['2026-09-01', '2026-09-30'] as const;

function montar(ajustes: unknown[] = []) {
  const mssql = { queryLinhas: jest.fn(async () => ({ colunas: [{ name: 'v' }], linhas: [[1]] })) };
  const layout = {
    findMany: jest.fn(async () => ajustes),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };
  const prisma = { ven_painel_layout: layout, $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)) };
  const service = new PaineisService(mssql as any, {} as any, prisma as any);
  const painel = (hub = 'VAREJO') => service.vendedor(hub, [], ...PERIODO);
  return { service, mssql, layout, prisma, painel };
}

const item = (dashcard: number, extra: Record<string, unknown> = {}) => ({
  dashcard, row: 0, col: 0, size_x: 6, size_y: 2, oculto: false, titulo: null, ...extra,
});

describe('layout do painel: mesclagem', () => {
  it('posição, tamanho, título e oculto do hub por cima do catálogo; ordem pelo layout mesclado', async () => {
    const { painel, mssql, layout } = montar([
      item(140, { row: 0, col: 0, size_x: 8, size_y: 3, titulo: 'Total' }),
      item(139, { row: 1, col: 0, size_x: 18, size_y: 6, oculto: true }),
    ]);
    const r = await painel();
    expect(layout.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { painel: 'VAREJO' } }));

    expect(r.cards[0]).toMatchObject({
      dashcard: 140, row: 0, col: 0, size_x: 8, size_y: 3, titulo: 'Total', tituloPadrao: 'Total das Vendas', oculto: false,
    });
    expect(r.cards[0].data).not.toBeNull();

    const oculto = r.cards.find((c) => c.dashcard === 139)!;
    expect(oculto).toMatchObject({ row: 1, col: 0, oculto: true, titulo: 'Vendas Mes Canal', tituloPadrao: 'Vendas Mes Canal', data: null });
    expect(oculto.erro).toBeUndefined();

    // Sem ajuste: padrão do catálogo.
    expect(r.cards.find((c) => c.dashcard === 142)).toMatchObject({ row: 2, col: 18, titulo: 'Vendas - Meta', tituloPadrao: 'Vendas - Meta', oculto: false });

    const ordem = r.cards.map((c) => c.row * 1000 + c.col);
    expect(ordem).toEqual([...ordem].sort((a, b) => a - b));
    expect(r.cards).toHaveLength(25);

    // O SQL do card oculto (vendas-mes-canal.sql, só ele o usa) não roda: uma consulta por SQL dos visíveis.
    const visiveis = varejo.cards.filter((c) => c.dashcard !== 139);
    expect(varejo.cards.filter((c) => c.sql === 'vendas-mes-canal.sql')).toHaveLength(1);
    expect(mssql.queryLinhas).toHaveBeenCalledTimes(new Set(visiveis.map((c) => c.sql).filter(Boolean)).size);
  });
});

describe('layout do painel: PUT', () => {
  const salvar = (body: unknown, hub = 'VAREJO') => montar().service.salvarLayout(hub, body, 'LUCAS');

  it.each([
    ['hub inválido', { itens: [] }, 'XPTO'],
    ['body sem itens', {}, 'VAREJO'],
    ['dashcard de outro hub', { itens: [item(295)] }, 'VAREJO'],
    ['dashcard repetido', { itens: [item(140), item(140)] }, 'VAREJO'],
    ['row negativo', { itens: [item(140, { row: -1 })] }, 'VAREJO'],
    ['col fracionário', { itens: [item(140, { col: 1.5 })] }, 'VAREJO'],
    ['size_x 0', { itens: [item(140, { size_x: 0 })] }, 'VAREJO'],
    ['size_x 25', { itens: [item(140, { size_x: 25 })] }, 'VAREJO'],
    ['col + size_x > 24', { itens: [item(140, { col: 20, size_x: 5 })] }, 'VAREJO'],
    ['size_y 0', { itens: [item(140, { size_y: 0 })] }, 'VAREJO'],
    ['oculto não booleano', { itens: [item(140, { oculto: 'sim' })] }, 'VAREJO'],
    ['titulo não texto', { itens: [item(140, { titulo: 1 })] }, 'VAREJO'],
    ['titulo com 121 caracteres', { itens: [item(140, { titulo: 'x'.repeat(121) })] }, 'VAREJO'],
  ])('400: %s', async (_caso, body, hub) => {
    await expect(salvar(body, hub)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('substitui os ajustes do hub numa transação e normaliza o título', async () => {
    const { service, layout, prisma } = montar();
    const r = await service.salvarLayout('VAREJO', {
      itens: [
        item(140, { col: 18, size_x: 6, titulo: '  Total  ' }),
        item(142, { titulo: '   ' }),
        item(141, { titulo: 'Meta de Vendas' }),
        item(139, { oculto: true, titulo: 'x'.repeat(120) }),
      ],
    }, ' LUCAS ');
    expect(r).toEqual({ ok: true, itens: 4 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(layout.deleteMany).toHaveBeenCalledWith({ where: { painel: 'VAREJO' } });
    const data = (layout.createMany.mock.calls[0] as unknown as [{ data: any[] }])[0].data;
    expect(data.map((d) => [d.dashcard, d.titulo])).toEqual([
      [140, 'Total'],
      [142, null], // vazio = título do catálogo
      [141, null], // igual ao do catálogo
      [139, 'x'.repeat(120)],
    ]);
    expect(data[0]).toEqual({ painel: 'VAREJO', dashcard: 140, row: 0, col: 18, size_x: 6, size_y: 2, oculto: false, titulo: 'Total', atualizado_por: 'LUCAS' });
    expect(data[3].oculto).toBe(true);
  });

  it('lista vazia apaga tudo (= padrão do catálogo)', async () => {
    const { service, layout } = montar();
    expect(await service.salvarLayout('VAREJO', { itens: [] })).toEqual({ ok: true, itens: 0 });
    expect(layout.deleteMany).toHaveBeenCalledWith({ where: { painel: 'VAREJO' } });
    expect((layout.createMany.mock.calls[0] as unknown as [{ data: any[] }])[0].data).toEqual([]);
  });
});

describe('layout do painel: cache', () => {
  it('salvar e restaurar derrubam o cache só do hub alterado', async () => {
    const { service, layout, painel } = montar();
    await painel('VAREJO');
    await painel('ATACADO');
    expect((await painel('VAREJO')).cache).toBe(true);
    expect(layout.findMany).toHaveBeenCalledTimes(2);

    await service.salvarLayout('VAREJO', { itens: [] });
    expect((await painel('VAREJO')).cache).toBe(false);
    expect((await painel('ATACADO')).cache).toBe(true);

    expect((await painel('VAREJO')).cache).toBe(true);
    expect(await service.restaurarLayout('VAREJO')).toEqual({ ok: true });
    expect((await painel('VAREJO')).cache).toBe(false);
  });

  it('painel montado com o layout de antes da gravação não entra no cache', async () => {
    const { service, layout, painel } = montar();
    let liberar!: (v: unknown[]) => void;
    layout.findMany.mockImplementationOnce(() => new Promise((ok) => (liberar = ok)));
    const emVoo = painel();
    await new Promise((ok) => setImmediate(ok));
    await service.salvarLayout('VAREJO', { itens: [] });
    liberar([]);
    await emVoo;
    expect((await painel()).cache).toBe(false);
  });
});

describe('layout do painel: tabela indisponível', () => {
  it('erro ao ler os ajustes cai no layout do catálogo', async () => {
    const { painel, layout } = montar();
    layout.findMany.mockRejectedValueOnce(new Error('relation "ven_painel_layout" does not exist'));
    const r = await painel();
    expect(r.cards).toHaveLength(25);
    expect(r.cards.every((c) => !c.oculto && c.titulo === c.tituloPadrao)).toBe(true);
  });
});
