import { BadRequestException } from '@nestjs/common';
import { OrcamentoService } from './orcamento.service';

/**
 * desfecho com data de retorno ("Cliente adiou" agendado → ADIADO) e o ADIADO como orçamento
 * vivo: reagendar, fechar depois e editar itens sem perder o retorno.
 */
describe('desfecho com data de retorno', () => {
  const montar = (status = 'ENVIADO', extra: Record<string, unknown> = {}) => {
    const orc = { id: 'o1', numero: 1, status, rep_codigo: 7, rep_nome: 'V', cli_codigo: 10, observacao: null, itens: [], ajustes_bolsa: [], retorno_em: null, ...extra };
    const db = {
      obter: jest.fn(async () => orc),
      atualizar: jest.fn(async (_id: string, cab: Record<string, unknown>) => ({ ...orc, ...cab })),
      atualizarNoStatus: jest.fn(),
    };
    const avisos = { aprovacaoEncerrada: jest.fn(), retornoEncerrado: jest.fn(), orcamentoAprovacao: jest.fn() };
    const erp = { clientePorCodigo: jest.fn(async () => ({ CLI_NOME: 'C', TABELA_PRECO: 1 })) };
    const service = new OrcamentoService(erp as never, {} as never, db as never, {} as never, avisos as never, {} as never);
    // bolsa e itens fora do teste: só o status gravado importa
    Object.assign(service as unknown as Record<string, unknown>, {
      bolsaNoFechamento: async () => ({}),
      promosPortalDe: async () => undefined,
      montarItens: async () => ({ linhas: [{ pro_codigo: 99, quantidade: 1, preco_unit: 5 }], tributacao: { regime: 'NORMAL' } }),
      bolsaSnapshot: async () => ({}),
      pagamentoDe: async () => ({}),
      aplicarAlcada: () => false,
      validade: () => null,
    });
    return { service, db, avisos };
  };
  const adiar = (retorno_em: string) => ({ resultado: 'PERDIDO' as const, motivo: 'CLIENTE_ADIOU', retorno_em });

  // 23h em Cuiabá de 30/10 (03h UTC de 31/10): "hoje" é 30/10
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-31T03:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each(['2026-10-29', '2026-10-30', '2027-01-29'])('recusa retorno em %s (fora de amanhã..+90)', async (d) => {
    const { service, db } = montar();
    await expect(service.desfecho('o1', adiar(d))).rejects.toThrow('entre amanhã e 90 dias');
    expect(db.atualizar).not.toHaveBeenCalled();
  });

  it('recusa data com outro motivo ou com FECHADO', async () => {
    const { service } = montar();
    await expect(service.desfecho('o1', { resultado: 'PERDIDO', motivo: 'PRECO', retorno_em: '2026-11-05' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.desfecho('o1', { resultado: 'FECHADO', retorno_em: '2026-11-05' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('PERDIDO + CLIENTE_ADIOU + amanhã (e +90) → ADIADO com retorno_em', async () => {
    const { service, db } = montar();
    await service.desfecho('o1', adiar('2026-10-31'));
    expect(db.atualizar).toHaveBeenLastCalledWith('o1', expect.objectContaining({ status: 'ADIADO', retorno_em: new Date('2026-10-31T00:00:00Z'), desfecho_motivo: 'CLIENTE_ADIOU', devolvido_por: null }));
    await service.desfecho('o1', adiar('2027-01-28'));
    expect(db.atualizar).toHaveBeenLastCalledWith('o1', expect.objectContaining({ status: 'ADIADO', retorno_em: new Date('2027-01-28T00:00:00Z') }));
  });

  it('ADIADO reagendado troca a data e tira o aviso anterior', async () => {
    const { service, db, avisos } = montar('ADIADO', { retorno_em: '2026-11-02' });
    await service.desfecho('o1', adiar('2026-11-10'));
    expect(db.atualizar).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'ADIADO', retorno_em: new Date('2026-11-10T00:00:00Z') }));
    expect(avisos.retornoEncerrado).toHaveBeenCalledWith('o1');
  });

  it('ADIADO → FECHADO limpa retorno_em e tira o aviso', async () => {
    const { service, db, avisos } = montar('ADIADO', { retorno_em: '2026-11-02' });
    await service.desfecho('o1', { resultado: 'FECHADO' });
    expect(db.atualizar).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'FECHADO', retorno_em: null }));
    expect(avisos.retornoEncerrado).toHaveBeenCalledWith('o1');
  });

  it('PERDIDO por outro motivo segue encerrando sem data, sem mexer em aviso de retorno', async () => {
    const { service, db, avisos } = montar();
    await service.desfecho('o1', { resultado: 'PERDIDO', motivo: 'PRECO' });
    expect(db.atualizar).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'PERDIDO', retorno_em: null }));
    expect(avisos.retornoEncerrado).not.toHaveBeenCalled();
  });

  it('CLIENTE_ADIOU sem data de retorno é recusado', async () => {
    const { service, db } = montar();
    await expect(service.desfecho('o1', { resultado: 'PERDIDO', motivo: 'CLIENTE_ADIOU' })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.atualizar).not.toHaveBeenCalled();
  });

  it('atualizar com itens trocados mantém ADIADO', async () => {
    const { service, db } = montar('ADIADO', { retorno_em: '2026-11-02', itens: [{ pro_codigo: 1, quantidade: 1, preco_unit: 10 }] });
    await service.atualizar('o1', { cli_codigo: 10, rep_codigo: 7, itens: [] } as never);
    expect(db.atualizar).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'ADIADO' }), expect.anything(), true);
  });

  it.each(['2026-11-31', '2026-12-32', '2026-12-00'])('recusa dia inexistente %s', async (d) => {
    const { service, db } = montar();
    await expect(service.desfecho('o1', adiar(d))).rejects.toThrow('Data de retorno inválida');
    expect(db.atualizar).not.toHaveBeenCalled();
  });

  it('desfecho sobre ADIADO mantém o desfecho_em de quando o motivo foi apontado', async () => {
    const apontado = new Date('2026-10-20T12:00:00Z');
    const { service, db } = montar('ADIADO', { retorno_em: '2026-10-30', desfecho_em: apontado });
    await service.desfecho('o1', adiar('2026-11-10'));
    expect(db.atualizar).toHaveBeenLastCalledWith('o1', expect.objectContaining({ desfecho_em: apontado }));
    await service.desfecho('o1', { resultado: 'PERDIDO', motivo: 'PRECO' });
    expect(db.atualizar).toHaveBeenLastCalledWith('o1', expect.objectContaining({ desfecho_em: apontado }));
  });

  it('ADIADO com itens trocados acima da alçada vai a APROVAÇÃO e avisa a gerência', async () => {
    const { service, db, avisos } = montar('ADIADO', { retorno_em: '2026-11-02', itens: [{ pro_codigo: 1, quantidade: 1, preco_unit: 10 }] });
    Object.assign(service as unknown as Record<string, unknown>, { aplicarAlcada: () => true });
    await service.atualizar('o1', { cli_codigo: 10, rep_codigo: 7, itens: [] } as never);
    expect(db.atualizar).toHaveBeenCalledWith('o1', expect.objectContaining({ status: 'APROVACAO', aprovado_em: null }), expect.anything(), true);
    expect(avisos.orcamentoAprovacao).toHaveBeenCalled();
    expect(avisos.retornoEncerrado).toHaveBeenCalledWith('o1');
  });

  it('FECHADO com oferta: sob a trava dos itens, recusa item não aprovado e o que passa do limite', async () => {
    const linha = (item: number, oferta_item_id: number, quantidade: number) => ({ item, descricao: 'P', pro_codigo: item, quantidade, oferta_item_id, fora_promocao: false });
    const itens: Record<number, { status: string; limite_qtd: number | null }> = { 1: { status: 'APROVADO', limite_qtd: 10 }, 2: { status: 'ENCERRADO', limite_qtd: null } };
    const ofertas = {
      comTrava: jest.fn(async (_ids: number[], fn: () => Promise<unknown>) => fn()),
      item: jest.fn(async (x: number) => itens[x]),
      vendidas: jest.fn(async () => new Map([[1, { qtd: 7, valor: 0 }]])),
    };
    const fechar = async (linhas: unknown[]) => {
      const { service, db } = montar('ENVIADO', { itens: linhas });
      Object.assign(service as unknown as Record<string, unknown>, { ofertas });
      return { r: service.desfecho('o1', { resultado: 'FECHADO' }), db };
    };
    const ok = await fechar([linha(1, 1, 3)]);
    await expect(ok.r).resolves.toEqual(expect.objectContaining({ status: 'FECHADO' }));
    expect(ofertas.comTrava).toHaveBeenCalledWith([1], expect.any(Function));
    const limite = await fechar([linha(1, 1, 4)]);
    await expect(limite.r).rejects.toBeInstanceOf(BadRequestException);
    expect(limite.db.atualizar).not.toHaveBeenCalled();
    const encerrado = await fechar([linha(2, 2, 1)]);
    await expect(encerrado.r).rejects.toThrow();
    expect(encerrado.db.atualizar).not.toHaveBeenCalled();
  });
});
