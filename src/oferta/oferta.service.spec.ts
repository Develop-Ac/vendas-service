import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OfertaService, TELA_OFERTAS, TELA_OFERTAS_APROVAR, TELA_OFERTAS_GANHOS } from './oferta.service';

const usuario = (perms: Array<{ tela: string; visualizar?: boolean; editar?: boolean; criar?: boolean }>) => ({
  id: 'u1',
  nome: 'Ana',
  sis_permissoes: perms.map((p) => ({ visualizar: false, editar: false, criar: false, ...p })),
});

const item = (over: Record<string, unknown>) => ({
  id: 1, oferta_id: 7, pro_codigo: 100, descricao: 'X', preco_t2: null, preco_t5: null,
  inicio: '2026-11-17', fim: '2026-12-16', limite_qtd: null, status: 'RASCUNHO', encerrado_motivo: null,
  enviado_por: null, enviado_em: null, aprovado_por: null, aprovado_em: null, encerrado_por: null, encerrado_em: null,
  tipo: 'PROMOCAO', premio_valor: null, limite_cliente: null, qtd_minima: 1, niveis: [],
  par_pro_codigo: null, par_descricao: null, par_proporcao: null,
  ...over,
});

/** produtosPorCodigo falso: tabela 2 = 200, tabela 5 = 220 (produto 100) ou sem preço próprio (produto 200). */
const produto = (pro: number, tabela: string) => ({
  pro_codigo: pro,
  descricao: `P${pro}`,
  custo: 100,
  estoque_disponivel: 50,
  preco_tabela_2: 200,
  preco_tabela_5: pro === 100 ? 220 : 0,
  avaliacao: { preco_minimo: 0 },
  sem_promocao: { avaliacao: { preco_minimo: tabela === '2' ? 150 : 165 } },
});

function montar(perms: Parameters<typeof usuario>[0], tipo = 'PROMOCAO', extra: Record<string, unknown> = {}) {
  const repo: Record<string, jest.Mock> = {
    permissoes: jest.fn().mockResolvedValue(usuario(perms)),
    detalhe: jest.fn().mockResolvedValue({
      id: 7, nome: 'G', tipo, premio_tipo: null, premio_valor: null, criado_por: 'Ana', criado_em: new Date(),
      itens: [
        item({ id: 1, pro_codigo: 100, preco_t2: 160, preco_t5: 170, limite_qtd: 10, status: 'APROVADO', aprovado_por: 'Carlos', tipo }),
        item({ id: 2, pro_codigo: 200, preco_t2: 140, preco_t5: 150, tipo }),
      ],
    }),
    vendidas: jest.fn().mockResolvedValue(new Map([[1, { qtd: 7, valor: 1120 }]])),
    naoEncerradosDosProdutos: jest.fn().mockResolvedValue([]),
    incluirItens: jest.fn().mockResolvedValue(undefined),
    alterarItens: jest.fn().mockResolvedValue(undefined),
    removerItem: jest.fn().mockResolvedValue(undefined),
    aprovados: jest.fn().mockResolvedValue([]),
    avancar: jest.fn().mockResolvedValue(undefined),
    encerrar: jest.fn().mockResolvedValue(undefined),
    ...extra,
  };
  repo.item ??= jest.fn(async (id: number) => (await repo.detalhe(7)).itens.find((i: { id: number }) => i.id === id) ?? null);
  repo.criar ??= jest.fn().mockResolvedValue({ id: 7 });
  const orc = { produtosPorCodigo: jest.fn((codigos: number[], tabela: string) => Promise.resolve(codigos.map((c) => produto(c, tabela)))) };
  const forn = { fornecedorPorCodigo: jest.fn(async (c: number) => (c === 55 ? { FOR_CODIGO: 55, FOR_NOME: 'BOSCH LTDA', NOME_FANTASIA: 'BOSCH' } : null)) };
  return { service: new OfertaService(repo as never, orc as never, forn as never), repo, orc, forn };
}

describe('OfertaService', () => {
  it('sem a tela /estoque/promocoes → 403', async () => {
    const { service } = montar([]);
    await expect(service.detalhe('u1', 7)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('só visualizar não grava', async () => {
    const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }]);
    await expect(service.criar('u1', { nome: 'G', tipo: 'PROMOCAO' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('detalhe: mínimos da régua por tabela, vendidas/restam e conferências', async () => {
    const { service, orc } = montar([{ tela: TELA_OFERTAS, visualizar: true }]);
    const d = await service.detalhe('u1', 7);
    expect(orc.produtosPorCodigo).toHaveBeenCalledWith([100, 200], '2');
    expect(orc.produtosPorCodigo).toHaveBeenCalledWith([100, 200], '5');
    expect(d.pode_aprovar).toBe(false);
    expect(d.aprovado_por).toEqual(['Carlos']);
    const [a, b] = d.itens;
    expect(a).toMatchObject({ custo: 100, saldo: 50, tabela_2: 200, tabela_5: 220, minimo_t2: 150, minimo_t5: 165, vendidas: 7, restam: 3, erros: [] });
    // produto sem tabela 5 própria: a oferta não vale nela; preço t2 abaixo do mínimo da régua
    expect(b).toMatchObject({ tabela_5: null, minimo_t5: null, minimo_t2: 150, vendidas: 0, restam: null });
    expect(b.erros).toEqual(expect.arrayContaining(['Produto sem preço na tabela 5.', 'Preço da tabela 2 (140.00) abaixo do mínimo (150.00).']));
  });

  it('liquidação: mínimo = custo × piso e pode_aprovar com a tela de aprovação', async () => {
    const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }, { tela: TELA_OFERTAS_APROVAR, editar: true }], 'LIQUIDACAO');
    const d = await service.detalhe('u1', 7);
    expect(d.pode_aprovar).toBe(true);
    expect(d.itens[0]).toMatchObject({ minimo_t2: 130, minimo_t5: 130 });
  });

  describe('criar campanha', () => {
    const grava = [{ tela: TELA_OFERTAS, editar: true }, { tela: TELA_OFERTAS_APROVAR, editar: true }];
    const base = { nome: 'Campanha Bosch', tipo: 'CAMPANHA' as const, premio_tipo: 'VALOR_UNIDADE' as const, premio_valor: 3 };

    it('campanha sem /aprovar → 403 e não grava (o prêmio é da gestão)', async () => {
      const { service, repo } = montar([{ tela: TELA_OFERTAS, editar: true }], 'CAMPANHA');
      await expect(service.criar('u1', { ...base, origem: 'EMPRESA' })).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.criar).not.toHaveBeenCalled();
    });

    it('critério 1: campanha de fornecedor sem fornecedor → 400 e não grava', async () => {
      const { service, repo } = montar(grava, 'CAMPANHA');
      await expect(service.criar('u1', { ...base, origem: 'FORNECEDOR' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.criar).not.toHaveBeenCalled();
    });

    it('faixas fora de ordem → 400', async () => {
      const { service, repo } = montar(grava, 'CAMPANHA');
      const faixas = [{ a_partir_de: 50, valor: 4 }, { a_partir_de: 30, valor: 5 }];
      await expect(service.criar('u1', { ...base, origem: 'EMPRESA', premio_faixas: faixas })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.criar).not.toHaveBeenCalled();
    });

    it('fornecedor inexistente no ERP → 400', async () => {
      const { service } = montar(grava, 'CAMPANHA');
      await expect(service.criar('u1', { ...base, origem: 'FORNECEDOR', fornecedor_codigo: 99 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('campanha válida grava origem, nome fantasia do fornecedor e faixas', async () => {
      const { service, repo } = montar(grava, 'CAMPANHA');
      const faixas = [{ a_partir_de: 50, valor: 4 }];
      await service.criar('u1', { ...base, origem: 'FORNECEDOR', fornecedor_codigo: 55, premio_faixas: faixas });
      expect(repo.criar).toHaveBeenCalledWith({
        nome: 'Campanha Bosch', tipo: 'CAMPANHA', criado_por: 'Ana',
        campanha: { origem: 'FORNECEDOR', fornecedor_codigo: 55, fornecedor_nome: 'BOSCH', premio_tipo: 'VALOR_UNIDADE', premio_valor: 3, premio_faixas: faixas },
      });
    });

    it('liquidação e promoção seguem como antes (sem dados de campanha, sem ERP)', async () => {
      const { service, repo, forn } = montar(grava);
      await service.criar('u1', { nome: 'L', tipo: 'LIQUIDACAO' });
      await service.criar('u1', { nome: 'P', tipo: 'PROMOCAO' });
      expect(repo.criar).toHaveBeenNthCalledWith(1, { nome: 'L', tipo: 'LIQUIDACAO', criado_por: 'Ana', campanha: undefined });
      expect(repo.criar).toHaveBeenNthCalledWith(2, { nome: 'P', tipo: 'PROMOCAO', criado_por: 'Ana', campanha: undefined });
      expect(forn.fornecedorPorCodigo).not.toHaveBeenCalled();
    });
  });

  describe('itens', () => {
    const gravar = [{ tela: TELA_OFERTAS, editar: true }];
    const grupo = (itens: unknown[]) => ({ detalhe: jest.fn().mockResolvedValue({ id: 7, nome: 'G', tipo: 'PROMOCAO', premio_tipo: null, premio_valor: null, criado_por: 'Ana', criado_em: new Date(), itens }) });

    afterEach(() => jest.useRealTimers());

    it('inclusão pela sugestão: t5 pelo mesmo desconto (decisão 22), limite = qtd, hoje a hoje + 30; só código nasce no mínimo; sobreposição recusa', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-17T15:00:00Z'));
      const outra = { id: 9, pro_codigo: 300, status: 'APROVADO', grupo: 'Outra', inicio: '2026-11-01', fim: '2026-12-31' };
      const { service, repo } = montar(gravar, 'PROMOCAO', { ...grupo([]), naoEncerradosDosProdutos: jest.fn().mockResolvedValue([outra]) });
      const r = await service.incluirItens('u1', 7, [{ pro_codigo: 100, preco_t2: 160, qtd: 12 }, { pro_codigo: 200 }, { pro_codigo: 300 }]);
      expect(repo.incluirItens).toHaveBeenCalledWith(7, [
        { pro_codigo: 100, descricao: 'P100', preco_t2: 160, preco_t5: 176, inicio: '2026-11-17', fim: '2026-12-17', limite_qtd: 12, tipo: 'PROMOCAO', premio_valor: null, limite_cliente: null, qtd_minima: 1, niveis: [], par_pro_codigo: null, par_descricao: null, par_proporcao: null },
        { pro_codigo: 200, descricao: 'P200', preco_t2: 150, preco_t5: null, inicio: '2026-11-17', fim: '2026-12-17', limite_qtd: null, tipo: 'PROMOCAO', premio_valor: null, limite_cliente: null, qtd_minima: 1, niveis: [], par_pro_codigo: null, par_descricao: null, par_proporcao: null },
      ]);
      expect(r.recusados).toEqual([{ pro_codigo: 300, motivo: 'Produto 300 já está na oferta "Outra" de 01/11/2026 a 31/12/2026.' }]);
    });

    it('sugestão abaixo do mínimo de agora entra no mínimo e é avisada (a tabela 5 segue o preço ajustado)', async () => {
      const { service, repo } = montar(gravar, 'PROMOCAO', grupo([]));
      const r = await service.incluirItens('u1', 7, [{ pro_codigo: 100, preco_t2: 140, qtd: 5 }]);
      expect(repo.incluirItens.mock.calls[0][1]).toEqual([expect.objectContaining({ pro_codigo: 100, preco_t2: 150, preco_t5: 165, limite_qtd: 5 })]);
      expect(r.recusados).toEqual([]);
      expect(r.ajustados).toEqual([{ pro_codigo: 100, tabela: 2, de: 140, para: 150 }]);
    });

    it('critério 7: aprovado com preço alterado volta a PENDENTE; os outros itens ficam intactos', async () => {
      const { service, repo } = montar(gravar);
      await service.alterarItem('u1', 1, { preco_t2: 170 });
      expect(repo.alterarItens).toHaveBeenCalledTimes(1);
      expect(repo.alterarItens).toHaveBeenCalledWith([
        { id: 1, dados: { tipo: 'PROMOCAO', premio_valor: null, preco_t2: 170, preco_t5: 170, inicio: '2026-11-17', fim: '2026-12-16', limite_qtd: 10, limite_cliente: null, qtd_minima: 1, niveis: [], par_pro_codigo: null, par_descricao: null, par_proporcao: null }, voltaPendente: true },
      ]);
    });

    it('critérios 1 e 2: liquidação em grupo de promoção nasce com 5% e no mínimo custo × 1,30; a promoção do lado fica na régua', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-17T15:00:00Z'));
      const { service, repo } = montar(gravar, 'PROMOCAO', grupo([]));
      await service.incluirItens('u1', 7, [{ pro_codigo: 100, tipo: 'LIQUIDACAO' }, { pro_codigo: 200 }]);
      expect(repo.incluirItens).toHaveBeenCalledWith(7, [
        expect.objectContaining({ pro_codigo: 100, preco_t2: 130, preco_t5: 130, tipo: 'LIQUIDACAO', premio_valor: 0.05 }),
        expect.objectContaining({ pro_codigo: 200, preco_t2: 150, tipo: 'PROMOCAO', premio_valor: null }),
      ]);
    });

    it('grupo de campanha: item entra como campanha mesmo pedindo outro tipo e não troca de tipo', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-17T15:00:00Z'));
      const { service, repo } = montar(gravar, 'CAMPANHA');
      await service.incluirItens('u1', 7, [{ pro_codigo: 300, tipo: 'LIQUIDACAO' }]);
      expect(repo.incluirItens).toHaveBeenCalledWith(7, [expect.objectContaining({ tipo: 'CAMPANHA', premio_valor: null })]);
      await expect(service.alterarItem('u1', 1, { tipo: 'LIQUIDACAO' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.alterarItens).not.toHaveBeenCalled();
    });

    it('bônus em item que não é liquidação → 400', async () => {
      const { service, repo } = montar(gravar);
      await expect(service.alterarItem('u1', 2, { premio_valor: 0.08 })).rejects.toMatchObject({ response: { message: 'Só item de liquidação tem bônus.' } });
      expect(repo.alterarItens).not.toHaveBeenCalled();
    });

    it('grupo misto: detalhe confere cada item pelo seu tipo (régua na promoção, custo × 1,30 na liquidação)', async () => {
      const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }], 'PROMOCAO', grupo([
        item({ id: 1, pro_codigo: 100, preco_t2: 140, tipo: 'LIQUIDACAO', premio_valor: 0.05 }),
        item({ id: 2, pro_codigo: 100, preco_t2: 140 }),
      ]));
      const [l, p] = (await service.detalhe('u1', 7)).itens;
      expect(l).toMatchObject({ minimo_t2: 130, minimo_t5: 130, erros: [] });
      expect(p).toMatchObject({ minimo_t2: 150, erros: ['Preço da tabela 2 (140.00) abaixo do mínimo (150.00).'] });
    });

    it('critério 10: par inexistente ou inativo recusa; par válido copia a descrição com proporção 1; null remove', async () => {
      const { service, repo, orc } = montar(gravar);
      orc.produtosPorCodigo.mockImplementation((codigos: number[], tabela: string) =>
        Promise.resolve(codigos.filter((c) => c !== 999).map((c) => ({ ...produto(c, tabela), inativo: c === 888 }))));
      await expect(service.alterarItem('u1', 1, { par_pro_codigo: 999 })).rejects.toMatchObject({ response: { message: 'Produto par 999 não encontrado ou inativo no ERP.' } });
      await expect(service.alterarItem('u1', 1, { par_pro_codigo: 888 })).rejects.toMatchObject({ response: { message: 'Produto par 888 não encontrado ou inativo no ERP.' } });
      await expect(service.alterarItem('u1', 1, { par_pro_codigo: 100 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.alterarItens).not.toHaveBeenCalled();
      await service.alterarItem('u1', 1, { par_pro_codigo: 200 });
      expect(repo.alterarItens).toHaveBeenLastCalledWith([{ id: 1, dados: expect.objectContaining({ par_pro_codigo: 200, par_descricao: 'P200', par_proporcao: 1 }), voltaPendente: true }]);
      repo.item.mockResolvedValueOnce(item({ id: 1, preco_t2: 160, preco_t5: 170, par_pro_codigo: 200, par_descricao: 'P200', par_proporcao: 2 }));
      await service.alterarItem('u1', 1, { par_pro_codigo: null });
      expect(repo.alterarItens).toHaveBeenLastCalledWith([{ id: 1, dados: expect.objectContaining({ par_pro_codigo: null, par_descricao: null, par_proporcao: null }), voltaPendente: false }]);
    });

    it('critério 10: detalhe com o saldo do par e par_sem_saldo', async () => {
      const { service, orc } = montar([{ tela: TELA_OFERTAS, visualizar: true }], 'PROMOCAO', grupo([
        item({ id: 1, pro_codigo: 100, preco_t2: 160, par_pro_codigo: 300, par_descricao: 'P300', par_proporcao: 1 }),
        item({ id: 2, pro_codigo: 200, preco_t2: 160, par_pro_codigo: 100, par_descricao: 'P100', par_proporcao: 1 }),
        item({ id: 3, pro_codigo: 200, preco_t2: 160 }),
      ]));
      orc.produtosPorCodigo.mockImplementation((codigos: number[], tabela: string) =>
        Promise.resolve(codigos.map((c) => ({ ...produto(c, tabela), estoque_disponivel: c === 300 ? 0 : 50 }))));
      const [a, b, c] = (await service.detalhe('u1', 7)).itens;
      expect(orc.produtosPorCodigo).toHaveBeenCalledWith([100, 300, 200], '2');
      expect(a).toMatchObject({ par_saldo: 0, par_sem_saldo: true });
      expect(b).toMatchObject({ par_saldo: 50, par_sem_saldo: false });
      expect(c).toMatchObject({ par_saldo: null, par_sem_saldo: false });
    });

    it('alterar com preço abaixo do mínimo recusa e não grava', async () => {
      const { service, repo } = montar(gravar);
      await expect(service.alterarItem('u1', 1, { preco_t2: 120 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.alterarItens).not.toHaveBeenCalled();
    });

    it('critério 5: replicar copia início e fim para os não encerrados e o aprovado volta a PENDENTE', async () => {
      const { service, repo } = montar(gravar, 'PROMOCAO', grupo([
        item({ id: 1, status: 'APROVADO', inicio: '2026-11-17', fim: '2026-12-16' }),
        item({ id: 2, pro_codigo: 200, inicio: '2026-11-20', fim: '2026-12-31' }),
        item({ id: 3, pro_codigo: 300, status: 'RASCUNHO', inicio: '2026-11-10', fim: '2026-11-30' }),
        item({ id: 4, pro_codigo: 400, status: 'ENCERRADO', inicio: '2026-10-01', fim: '2026-10-31' }),
      ]));
      await service.replicarDatas('u1', 7, 2);
      expect(repo.alterarItens).toHaveBeenCalledWith([
        { id: 1, dados: { inicio: '2026-11-20', fim: '2026-12-31' }, voltaPendente: true },
        { id: 3, dados: { inicio: '2026-11-20', fim: '2026-12-31' }, voltaPendente: false },
      ]);
    });

    it('replicar com sobreposição em outro grupo recusa tudo com a lista', async () => {
      const outra = { id: 9, pro_codigo: 100, status: 'PENDENTE', grupo: 'Outra', inicio: '2026-12-20', fim: '2027-01-10' };
      const { service, repo } = montar(gravar, 'PROMOCAO', {
        ...grupo([item({ id: 1, inicio: '2026-11-17', fim: '2026-12-16' }), item({ id: 2, pro_codigo: 200, inicio: '2026-11-20', fim: '2026-12-31' })]),
        naoEncerradosDosProdutos: jest.fn().mockResolvedValue([outra]),
      });
      await expect(service.replicarDatas('u1', 7, 2)).rejects.toMatchObject({ response: { message: ['Produto 100 já está na oferta "Outra" de 20/12/2026 a 10/01/2027.'] } });
      expect(repo.alterarItens).not.toHaveBeenCalled();
    });

    it('remover fora de rascunho recusa', async () => {
      const { service, repo } = montar(gravar);
      await expect(service.removerItem('u1', 1)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.removerItem).not.toHaveBeenCalled();
      await service.removerItem('u1', 2);
      expect(repo.removerItem).toHaveBeenCalledWith(2);
    });

    it('incluir sem editar/criar → 403', async () => {
      const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }]);
      await expect(service.incluirItens('u1', 7, [{ pro_codigo: 100 }])).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('montagem por marca', () => {
    const gravar = [{ tela: TELA_OFERTAS, editar: true }];
    const campanha = { detalhe: jest.fn().mockResolvedValue({ id: 7, nome: 'Campanha Bosch', tipo: 'CAMPANHA', criado_por: 'Ana', criado_em: new Date(), itens: [] }) };

    it('prévia em grupo que não é campanha = 400', async () => {
      const { service } = montar(gravar, 'LIQUIDACAO');
      await expect(service.previaMarca('u1', 7, { marca: 'BOSCH', pct: 0.1 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('prévia: 10% nas duas tabelas, não grava', async () => {
      const { service, repo, orc } = montar(gravar, 'CAMPANHA', campanha);
      (orc as Record<string, jest.Mock>).produtosDaMarca = jest.fn().mockResolvedValue({ codigos: [100, 200], truncado: false });
      const r = await service.previaMarca('u1', 7, { marca: ' BOSCH ', pct: 0.1 });
      expect(r).toMatchObject({ marca: 'BOSCH', pct: 0.1, truncado: false, excluidos: [] });
      expect(r.incluidos).toEqual([
        expect.objectContaining({ pro_codigo: 100, minimo_t2: 130, minimo_t5: 130, preco_t2: 180, preco_t5: 198, no_minimo: false }),
        expect.objectContaining({ pro_codigo: 200, preco_t2: 180, preco_t5: null }),
      ]);
      expect(repo.incluirItens).not.toHaveBeenCalled();
    });

    it('confirmação: preco_t5 informado é gravado; produto já em outra oferta no período volta em recusados', async () => {
      const outra = { id: 9, pro_codigo: 200, status: 'APROVADO', grupo: 'Outra', inicio: '2026-11-01', fim: '2027-12-31' };
      const { service, repo } = montar(gravar, 'CAMPANHA', { ...campanha, naoEncerradosDosProdutos: jest.fn().mockResolvedValue([outra]) });
      const r = await service.incluirItens('u1', 7, [{ pro_codigo: 100, preco_t2: 180, preco_t5: 190 }, { pro_codigo: 200, preco_t2: 180 }]);
      expect(repo.incluirItens).toHaveBeenCalledWith(7, [expect.objectContaining({ pro_codigo: 100, preco_t2: 180, preco_t5: 190 })]);
      expect(r.recusados).toEqual([{ pro_codigo: 200, motivo: expect.stringContaining('já está na oferta "Outra"') }]);
    });
  });

  describe('fluxo', () => {
    const aprovar = [{ tela: TELA_OFERTAS, editar: true }, { tela: TELA_OFERTAS_APROVAR, editar: true }];

    afterEach(() => jest.useRealTimers());

    it('critério 6: aprovar e encerrar sem /estoque/promocoes/aprovar → 403', async () => {
      const { service, repo } = montar([{ tela: TELA_OFERTAS, editar: true, criar: true }]);
      await expect(service.aprovar('u1', 7)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.encerrar('u1', 7, [1])).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.avancar).not.toHaveBeenCalled();
      expect(repo.encerrar).not.toHaveBeenCalled();
    });

    it('enviar: rascunho com erro é recusado, o resto vai a PENDENTE com quem enviou', async () => {
      const { service, repo } = montar([{ tela: TELA_OFERTAS, editar: true }], 'PROMOCAO', {
        detalhe: jest.fn().mockResolvedValue({ id: 7, nome: 'G', tipo: 'PROMOCAO', itens: [
          item({ id: 1, preco_t2: 160, preco_t5: 170 }),
          item({ id: 2, pro_codigo: 200, preco_t2: 140 }),
          item({ id: 3, status: 'APROVADO', preco_t2: 160 }),
        ] }),
      });
      const r = await service.enviar('u1', 7);
      expect(repo.avancar).toHaveBeenCalledWith([1], 'PENDENTE', 'Ana');
      expect(r.recusados).toEqual([{ item_id: 2, pro_codigo: 200, motivo: 'Preço da tabela 2 (140.00) abaixo do mínimo (150.00).' }]);
    });

    it('aprovar item com preço abaixo do mínimo de agora recusa; fora de PENDENTE também', async () => {
      const { service, repo } = montar(aprovar, 'PROMOCAO', {
        detalhe: jest.fn().mockResolvedValue({ id: 7, nome: 'G', tipo: 'PROMOCAO', itens: [
          item({ id: 1, status: 'PENDENTE', preco_t2: 160, preco_t5: 170 }),
          item({ id: 2, pro_codigo: 200, status: 'PENDENTE', preco_t2: 149 }),
          item({ id: 3, status: 'RASCUNHO', preco_t2: 160 }),
        ] }),
      });
      const r = await service.aprovar('u1', 7, [1, 2, 3]);
      expect(repo.avancar).toHaveBeenCalledWith([1], 'APROVADO', 'Ana');
      expect(r.recusados.map((x: { item_id: number }) => x.item_id).sort()).toEqual([2, 3]);
    });

    it('encerrar: item informado com motivo MANUAL e quem encerrou', async () => {
      const { service, repo } = montar(aprovar);
      await service.encerrar('u1', 7, [1]);
      expect(repo.encerrar).toHaveBeenCalledWith([{ id: 1, motivo: 'MANUAL', por: 'Ana' }]);
    });

    it('apuração grava DATA, LIMITE e SALDO; não apura o que não começou; trava de 10 min', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-11-17T15:00:00Z'));
      const aprovados = [
        item({ id: 1, status: 'APROVADO', inicio: '2026-11-01', fim: '2026-11-16' }), // DATA
        item({ id: 2, status: 'APROVADO', limite_qtd: 10 }), // LIMITE (10 vendidas)
        item({ id: 3, pro_codigo: 500, status: 'APROVADO' }), // SALDO (estoque 0)
        item({ id: 4, status: 'APROVADO' }), // segue vigente
        item({ id: 5, pro_codigo: 500, status: 'APROVADO', inicio: '2026-11-20' }), // não começou
      ];
      const { service, repo, orc } = montar([{ tela: TELA_OFERTAS, visualizar: true }], 'PROMOCAO', {
        aprovados: jest.fn().mockResolvedValue(aprovados),
        vendidas: jest.fn().mockResolvedValue(new Map([[2, { qtd: 10, valor: 1600 }]])),
      });
      orc.produtosPorCodigo.mockImplementation((codigos: number[], tabela: string) =>
        Promise.resolve(codigos.map((c) => ({ ...produto(c, tabela), estoque_disponivel: c === 500 ? 0 : 50 }))));
      await service.apurar();
      expect(repo.encerrar).toHaveBeenCalledWith([{ id: 1, motivo: 'DATA' }, { id: 2, motivo: 'LIMITE' }, { id: 3, motivo: 'SALDO' }]);
      await service.detalhe('u1', 7);
      expect(repo.aprovados).toHaveBeenCalledTimes(1);
    });

    it('apuração que falha só loga e a leitura segue', async () => {
      const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }], 'PROMOCAO', { aprovados: jest.fn().mockRejectedValue(new Error('banco fora')) });
      await expect(service.detalhe('u1', 7)).resolves.toMatchObject({ id: 7 });
    });
  });
  describe('ganhos do mês', () => {
    const grupo = (id: number, tipo: string, itemId: number, extra: Record<string, unknown>) => ({
      id, nome: `G${id}`, tipo, origem: null, fornecedor_codigo: null, fornecedor_nome: null, inicio: '2026-10-27', fim: '2026-11-10',
      itens: [{ id: itemId, pro_codigo: 100 + itemId, descricao: `Item ${itemId}`, inicio: '2026-10-27', fim: '2026-11-10', status: 'ENCERRADO', tipo, premio_valor: tipo === 'LIQUIDACAO' ? 0.05 : null }],
      ...extra,
    });
    const linha = (nfs: number, pro: number, quantidade: number, liquido: number) => ({
      empresa: 3, serie: '1', nfs, pro_codigo: pro, cli_codigo: 1, rep_codigo: 10, emissao: new Date('2026-11-05T12:00:00-04:00'),
      devolucao: false, quantidade, preco_unit: liquido / quantidade, liquido, custo: 0, promocao: false,
    });
    const unidade = (quantidade: number, oferta_item_id: number) => ({ orcamento_id: 'o1', numero: 1, preco_unit_orc: 0, custo_ref: 100, quantidade, oferta_item_id });

    function montarGanhos(perms: Parameters<typeof usuario>[0]) {
      const m = montar(perms, 'PROMOCAO', {
        gruposComPremio: jest.fn().mockResolvedValue([
          grupo(7, 'LIQUIDACAO', 1, { premio: { tipo: 'PCT_CUSTO', valor: 0.05, faixas: [] } }),
          grupo(8, 'CAMPANHA', 2, { origem: 'FORNECEDOR', fornecedor_codigo: 55, fornecedor_nome: 'BOSCH', premio: { tipo: 'VALOR_UNIDADE', valor: 3, faixas: [] } }),
          grupo(9, 'CAMPANHA', 3, { inicio: null, fim: null, premio: { tipo: 'VALOR_UNIDADE', valor: 1, faixas: [] } }),
        ]),
        repsComOferta: jest.fn().mockResolvedValue([10]),
      });
      const orc = Object.assign(m.orc, {
        casamentoDoRep: jest.fn().mockResolvedValue({
          linhas: [linha(500, 101, 2, 360), linha(501, 102, 4, 400)],
          porLinha: new Map([[0, [unidade(2, 1)]], [1, [unidade(4, 2)]]]),
        }),
        nomesDosVendedores: jest.fn().mockResolvedValue(new Map([[10, 'JOAO']])),
        numerosNf: jest.fn().mockResolvedValue(new Map([[500, { nota_fiscal: 9500, chave_nfe: null }]])),
      });
      return { ...m, orc };
    }

    it('sem /estoque/promocoes/ganhos → 403 (critério 11)', async () => {
      const { service } = montarGanhos([{ tela: TELA_OFERTAS, visualizar: true }, { tela: TELA_OFERTAS_APROVAR, editar: true }]);
      await expect(service.ganhos('u1', '2026-11')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('mes fora do formato → 400', async () => {
      const { service } = montarGanhos([{ tela: TELA_OFERTAS_GANHOS, visualizar: true }]);
      await expect(service.ganhos('u1', '2026-13')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('vendedores, fornecedores e totais do mês a partir do casamento', async () => {
      const { service, orc, repo } = montarGanhos([{ tela: TELA_OFERTAS_GANHOS, visualizar: true }]);
      const r = await service.ganhos('u1', '2026-11');
      expect(repo.repsComOferta).toHaveBeenCalledWith([1, 2]);
      expect(orc.casamentoDoRep).toHaveBeenCalledWith(10);
      expect(orc.numerosNf).toHaveBeenCalledWith([500, 501]);
      expect(r.mes).toEqual({ ano: 2026, mes: 11, inicio: '2026-10-26', fim: '2026-11-25' });
      expect(r.vendedores).toHaveLength(1);
      expect(r.vendedores[0]).toMatchObject({ rep_codigo: 10, rep_nome: 'JOAO', bonus_liquidacao: 10, premios_campanha: 12, total: 22, em_andamento: 0 });
      expect(r.vendedores[0].linhas).toEqual(expect.arrayContaining([
        expect.objectContaining({ nfs: 500, nota_fiscal: 9500, descricao: 'Item 1', ganho: 10, situacao: 'PAGAR' }),
        expect.objectContaining({ nfs: 501, nota_fiscal: null, descricao: 'Item 2', ganho: 12, situacao: 'PAGAR' }),
      ]));
      expect(r.fornecedores).toEqual([expect.objectContaining({ fornecedor_codigo: 55, unidades: 4, valor: 12 })]);
      expect(r.totais).toEqual({ bonus_liquidacao: 10, premios_campanha: 12, total: 22, em_andamento: 0, a_cobrar: 12 });
    });

    it('detalhe repassa pode_ver_ganhos', async () => {
      const { service } = montar([{ tela: TELA_OFERTAS, visualizar: true }, { tela: TELA_OFERTAS_GANHOS, visualizar: true }]);
      await expect(service.detalhe('u1', 7)).resolves.toMatchObject({ pode_ver_ganhos: true });
    });
  });

  describe('resultado do grupo e prêmio', () => {
    const liquidacao = (extra: Record<string, unknown> = {}) => ({
      id: 7, nome: 'L', tipo: 'LIQUIDACAO', origem: null, fornecedor_codigo: null, fornecedor_nome: null,
      premio_tipo: 'PCT_CUSTO', premio_valor: 0.05, premio_faixas: [], criado_por: 'Ana', criado_em: new Date(),
      itens: [item({ id: 1, status: 'APROVADO', descricao: 'Palheta', preco_t2: 160, preco_t5: 170, tipo: 'LIQUIDACAO', premio_valor: 0.05 }), item({ id: 2, pro_codigo: 200, preco_t2: 160, tipo: 'LIQUIDACAO', premio_valor: 0.05, status: 'APROVADO' })],
      ...extra,
    });
    const casado = {
      linhas: [{ empresa: 3, serie: '1', nfs: 500, pro_codigo: 100, cli_codigo: 1, rep_codigo: 10, emissao: new Date('2026-11-18T12:00:00-04:00'), devolucao: false, quantidade: 2, preco_unit: 180, liquido: 360, custo: 0, promocao: false }],
      porLinha: new Map([[0, [{ orcamento_id: 'o1', numero: 1, preco_unit_orc: 0, custo_ref: 100, quantidade: 2, oferta_item_id: 1 }]]]),
    };
    const gestao = [{ tela: TELA_OFERTAS, visualizar: true }, { tela: TELA_OFERTAS_APROVAR, editar: true }];
    const monta = [{ tela: TELA_OFERTAS, editar: true }];

    function montarGrupo(perms: Parameters<typeof usuario>[0], extra: Record<string, unknown> = {}, grupo = liquidacao()) {
      const m = montar(perms, 'LIQUIDACAO', { detalhe: jest.fn().mockResolvedValue(grupo), repsComOferta: jest.fn().mockResolvedValue([10]), alterarPremio: jest.fn().mockResolvedValue(undefined), ...extra });
      Object.assign(m.orc, { casamentoDoRep: jest.fn().mockResolvedValue(casado), nomesDosVendedores: jest.fn().mockResolvedValue(new Map([[10, 'JOAO']])) });
      return m;
    }

    it('trocar o prêmio sem /aprovar → 403', async () => {
      const { service, repo } = montarGrupo([{ tela: TELA_OFERTAS, editar: true }]);
      await expect(service.alterarPremio('u1', 7, { premio_valor: 0.08 })).rejects.toBeInstanceOf(ForbiddenException);
      expect(repo.alterarPremio).not.toHaveBeenCalled();
    });

    const campanha = () => liquidacao({ tipo: 'CAMPANHA', origem: 'EMPRESA', premio_tipo: 'VALOR_UNIDADE', premio_valor: 3, itens: [item({ id: 1, status: 'APROVADO', tipo: 'CAMPANHA', preco_t2: 160 })] });

    it('campanha com venda faturada → 400', async () => {
      const { service, repo } = montarGrupo(gestao, {}, campanha());
      await expect(service.alterarPremio('u1', 7, { premio_valor: 4 })).rejects.toMatchObject({ response: { message: 'Prêmio não pode ser alterado: grupo já tem venda faturada.' } });
      expect(repo.alterarPremio).not.toHaveBeenCalled();
    });

    it('critério 2: prêmio de grupo em liquidação → 400 (o bônus é do item)', async () => {
      const { service, repo } = montarGrupo(gestao, { vendidas: jest.fn().mockResolvedValue(new Map()) });
      await expect(service.alterarPremio('u1', 7, { premio_valor: 0.08 })).rejects.toMatchObject({ response: { message: 'Só campanha tem prêmio de grupo; o bônus da liquidação é do item.' } });
      expect(repo.alterarPremio).not.toHaveBeenCalled();
    });

    it('critério 3: bônus de 5% para 8% sem venda faturada devolve só aquele item a PENDENTE, sem ler o casamento', async () => {
      const { service, repo, orc } = montarGrupo(monta, { vendidas: jest.fn().mockResolvedValue(new Map()) });
      await service.alterarItem('u1', 1, { premio_valor: 0.08 });
      expect(repo.alterarItens).toHaveBeenCalledWith([{ id: 1, dados: expect.objectContaining({ tipo: 'LIQUIDACAO', premio_valor: 0.08 }), voltaPendente: true }]);
      expect((orc as unknown as Record<string, jest.Mock>).casamentoDoRep).not.toHaveBeenCalled();
    });

    it('critério 3: liquidação vira promoção, zera o bônus e volta a PENDENTE', async () => {
      const { service, repo } = montarGrupo(monta, { vendidas: jest.fn().mockResolvedValue(new Map()) });
      await service.alterarItem('u1', 1, { tipo: 'PROMOCAO' });
      expect(repo.alterarItens).toHaveBeenCalledWith([{ id: 1, dados: expect.objectContaining({ tipo: 'PROMOCAO', premio_valor: null }), voltaPendente: true }]);
    });

    it('critério 3: troca de tipo ou de bônus com venda faturada no item → 400; preço segue livre', async () => {
      const { service, repo } = montarGrupo(monta);
      await expect(service.alterarItem('u1', 1, { premio_valor: 0.08 })).rejects.toMatchObject({ response: { message: 'Tipo e bônus não podem ser alterados: item já tem venda faturada.' } });
      await expect(service.alterarItem('u1', 1, { tipo: 'PROMOCAO' })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.alterarItens).not.toHaveBeenCalled();
      await service.alterarItem('u1', 1, { preco_t2: 165 });
      expect(repo.alterarItens).toHaveBeenCalledTimes(1);
    });

    it('faixas fora de ordem → 400; promoção → 400', async () => {
      const { service, repo } = montarGrupo(gestao, { vendidas: jest.fn().mockResolvedValue(new Map()) }, campanha());
      const faixas = [{ a_partir_de: 50, valor: 4 }, { a_partir_de: 30, valor: 5 }];
      await expect(service.alterarPremio('u1', 7, { premio_valor: 3, premio_faixas: faixas })).rejects.toBeInstanceOf(BadRequestException);
      const promo = montarGrupo(gestao, {}, liquidacao({ tipo: 'PROMOCAO', premio_tipo: null, premio_valor: null }));
      await expect(promo.service.alterarPremio('u1', 7, { premio_valor: 0.08 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.alterarPremio).not.toHaveBeenCalled();
    });

    it('resultado: faturado com descrição; vendedores só com a permissão de ganhos', async () => {
      const sem = await montarGrupo([{ tela: TELA_OFERTAS, visualizar: true }]).service.resultado('u1', 7);
      expect(sem).toEqual({ faturado: [{ oferta_item_id: 1, pro_codigo: 100, descricao: 'Palheta', quantidade: 2, valor: 360 }], vendedores: null });
      const com = await montarGrupo([{ tela: TELA_OFERTAS, visualizar: true }, { tela: TELA_OFERTAS_GANHOS, visualizar: true }]).service.resultado('u1', 7);
      expect(com.vendedores).toEqual([{ rep_codigo: 10, rep_nome: 'JOAO', quantidade: 2, valor: 360, ganho: 10, situacao: 'PAGAR' }]);
    });
  });
});
