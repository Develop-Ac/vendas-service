import { OrcamentoErpRepository } from './orcamento.erp.repository';

// Condições e formas de pagamento lidas do Celta: o filtro reproduz a regra da
// API de orçamentos (condição inativa ou do contas a pagar e forma inativa ou
// que bloqueia venda são recusadas lá — então nem chegam ao seletor).
function repoCom(linhas: Record<string, Record<string, unknown>[]>) {
  const erp = { consultar: async (tabela: string) => linhas[tabela] ?? [] };
  return new OrcamentoErpRepository(erp as never);
}

describe('condicoesPagto', () => {
  it('descarta inativas e as do contas a pagar, ordena por descrição e traz a forma sugerida', async () => {
    const repo = repoCom({
      'condicoes-pagto': [
        { CP_CODIGO: 2, CP_DESCRICAO: '30 DIAS', NRO_PARCELAS: 1, LOCAL_USO: 'A', INATIVO: 'N' },
        { CP_CODIGO: 86, CP_DESCRICAO: 'PIX ', NRO_PARCELAS: 1, LOCAL_USO: 'A', INATIVO: 'N', VEN_FP_ENTRADA: '12' },
        { CP_CODIGO: 9, CP_DESCRICAO: 'INATIVA', LOCAL_USO: 'A', INATIVO: 'S' },
        { CP_CODIGO: 7, CP_DESCRICAO: 'FORNECEDOR 28 DIAS', LOCAL_USO: 'P', INATIVO: 'N' },
      ],
    });
    const r = await repo.condicoesPagto();
    expect(r.map((c) => c.cp_codigo)).toEqual([2, 86]);
    expect(r[1]).toEqual({ cp_codigo: 86, descricao: 'PIX', parcelas: 1, fp_entrada: '12' });
  });
});

describe('formasPagto', () => {
  it('descarta inativas e as que bloqueiam venda, na ordem do Celta', async () => {
    const repo = repoCom({
      'formas-pagto': [
        { FP_CODIGO: '5  ', FP_DESCRICAO: 'CIELO', ORDEM: 2, BLOQUEIA_VENDA: 'N', INATIVO: 'N' },
        { FP_CODIGO: '1', FP_DESCRICAO: 'DINHEIRO', ORDEM: 1, BLOQUEIA_VENDA: 'N', INATIVO: 'N' },
        { FP_CODIGO: '10', FP_DESCRICAO: '10', ORDEM: 3, BLOQUEIA_VENDA: 'S', INATIVO: 'S' },
        { FP_CODIGO: '204', FP_DESCRICAO: 'SPL', ORDEM: 59, BLOQUEIA_VENDA: 'N', INATIVO: 'S' },
      ],
    });
    const r = await repo.formasPagto();
    expect(r).toEqual([
      { fp_codigo: '1', descricao: 'DINHEIRO' },
      { fp_codigo: '5', descricao: 'CIELO' },
    ]);
  });
});
