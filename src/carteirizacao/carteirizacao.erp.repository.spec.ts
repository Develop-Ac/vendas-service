import { ErpApiService } from '../common/erp-api/erp-api.service';
import { CarteirizacaoErpRepository, OrcamentoIntranet } from './carteirizacao.erp.repository';

/** Orçamentos do Celta + vendas do período, como a erp-firebird-api devolve. */
function repoCom(orcsCelta: any[], vendas: Array<{ CLI_CODIGO: number; DT_EMISSAO: string }>) {
  const erp = {
    consultar: jest.fn(async (recurso: string) => (recurso === 'orcamentos' ? orcsCelta : vendas)),
  };
  return new CarteirizacaoErpRepository(erp as unknown as ErpApiService);
}

function intranet(over: Partial<OrcamentoIntranet>): OrcamentoIntranet {
  return {
    id: 'orc-500',
    numero: 500,
    created_at: new Date('2026-10-01T15:00:00Z'),
    cli_codigo: 7,
    cli_nome: 'CLI 7',
    rep_codigo: 10,
    total: 1000,
    status: 'ENVIADO',
    desfecho_em: null,
    ...over,
  };
}

describe('orçamentos com fechamento: Celta + intranet', () => {
  it('orçamento da intranet entra com chave negativa e a mesma inferência de venda', async () => {
    const repo = repoCom(
      [{ ORCAMENTO: 500, EMISSAO: '2026-10-01', CLI_CODIGO: 1, CLI_NOME: 'CLI 1', REP_CODIGO: 10, TOTAL: 300 }],
      [{ CLI_CODIGO: 8, DT_EMISSAO: '2026-10-03' }],
    );
    const r = await repo.orcamentosComFechamento('2026-09-25', '2026-10-05', 7, [
      intranet({ numero: 500 }),
      intranet({ numero: 501, cli_codigo: 8 }),
    ]);

    // Mesmo número 500 no Celta e na intranet: o sinal separa as duas chaves.
    expect(r.map((o) => [o.orcamento, o.origem])).toEqual([
      [500, 'CELTA'],
      [-500, 'INTRANET'],
      [-501, 'INTRANET'],
    ]);
    expect(r.find((o) => o.orcamento === -500)).toMatchObject({ numero_intranet: 500, fechou: false, emissao_ymd: '2026-10-01' });
    expect(r.find((o) => o.orcamento === -501)!.fechou).toBe(true); // cliente 8 comprou em 03/10
  });

  it('desfecho dado na tela de orçamento vale: FECHADO fechou, PERDIDO já tem motivo', async () => {
    const perdido = new Date('2026-10-04T12:00:00Z');
    const r = await repoCom([], []).orcamentosComFechamento('2026-09-25', '2026-10-05', 7, [
      intranet({ numero: 1, status: 'FECHADO' }),
      intranet({ numero: 2, status: 'PERDIDO', desfecho_em: perdido }),
    ]);
    expect(r.find((o) => o.numero_intranet === 1)!.fechou).toBe(true);
    expect(r.find((o) => o.numero_intranet === 2)).toMatchObject({ fechou: false, motivo_em: perdido });
  });

  it('o dia do orçamento da intranet é o de Cuiabá e respeita a janela de emissão', async () => {
    const r = await repoCom([], []).orcamentosComFechamento('2026-10-01', '2026-10-05', 7, [
      // 02h UTC de 01/10 ainda é 30/09 em Cuiabá: fora da janela.
      intranet({ numero: 1, created_at: new Date('2026-10-01T02:00:00Z') }),
      intranet({ numero: 2, created_at: new Date('2026-10-05T20:00:00Z') }),
      intranet({ numero: 3, created_at: new Date('2026-10-06T12:00:00Z') }),
    ]);
    expect(r.map((o) => o.numero_intranet)).toEqual([2]);
  });
});
