import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TrocaVendedorService } from './troca-vendedor.service';
import { CarteirizacaoService } from './carteirizacao.service';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import { CarteirizacaoCeltaClient } from './carteirizacao.celta.client';

describe('TrocaVendedorService', () => {
  let overlay: Map<number, any>;
  let historico: any[];
  let tarefasCriadas: any[];
  let canceladas: string[];
  let resgates: Map<number, any>;
  let resgateAtualizado: Array<{ id: string; data: any }>;
  let usuario: any;
  let celtaRecusa: Set<number>;
  let celtaChamadas: Array<[number, number, number]>;

  const repo = {
    usuarioVendas: jest.fn(async () => usuario),
    obterCliente: jest.fn(async (cli: number) => overlay.get(cli) ?? null),
    listarCarteira: jest.fn(async () => [...overlay.values()].filter((c) => c.trash === 0)),
    upsertAtribuicao: jest.fn(async (p: any) => overlay.set(p.cli_codigo, { ...p, trash: 0 })),
    registrarHistorico: jest.fn(async (h: any) => historico.push(h)),
    tarefasEmAndamentoDoCliente: jest.fn(async (cli: number) =>
      cli === 1 ? [{ id: 't1', rep_codigo: 10, rep_nome: 'ANTIGO' }] : [],
    ),
    cancelarTarefa: jest.fn(async (id: string) => canceladas.push(id)),
    resgateAbertoDoCliente: jest.fn(async (cli: number) => resgates.get(cli) ?? null),
    atualizarResgate: jest.fn(async (id: string, data: any) => resgateAtualizado.push({ id, data })),
    criarTarefas: jest.fn(async (rows: any[]) => tarefasCriadas.push(...rows)),
  };
  const carteirizacao = {
    resolverNomeRep: jest.fn(async () => 'NOVO'),
    snapshotCarteira: jest.fn(async () => [{ cli_codigo: 1, cli_nome: 'CLI 1', curva_abc: 'B' }]),
  };
  const celta = {
    trocarRepresentante: jest.fn(async (empresa: number, cli: number, rep: number) => {
      celtaChamadas.push([empresa, cli, rep]);
      if (celtaRecusa.has(cli)) throw new Error('Cliente não encontrado');
    }),
  };

  const svc = new TrocaVendedorService(
    carteirizacao as unknown as CarteirizacaoService,
    repo as unknown as CarteirizacaoPrismaRepository,
    celta as unknown as CarteirizacaoCeltaClient,
  );

  beforeEach(() => {
    overlay = new Map([
      [1, { cli_codigo: 1, rep_codigo: 10, rep_nome: 'ANTIGO', trash: 0 }],
      [2, { cli_codigo: 2, rep_codigo: 10, rep_nome: 'ANTIGO', trash: 0 }],
      [3, { cli_codigo: 3, rep_codigo: 30, rep_nome: 'OUTRO', trash: 0 }],
    ]);
    historico = [];
    tarefasCriadas = [];
    canceladas = [];
    resgates = new Map();
    resgateAtualizado = [];
    usuario = { id: 'u1', codigo: 'SUP', nome: 'Supervisor', setor: 'VENDAS', vendas_hub_inicial: 'SUPERVISAO_ATACADO' };
    celtaRecusa = new Set();
    celtaChamadas = [];
    jest.clearAllMocks();
  });

  it('grava no Celta, espelha com histórico e passa a fila para o novo vendedor', async () => {
    const r = await svc.trocar({ cli_codigos: [1], rep_codigo: 20, motivo: 'Rota nova', usuario_id: 'u1' });

    expect(celtaChamadas).toEqual([[3, 1, 20]]);
    expect(r.trocados).toEqual([1]);
    expect(overlay.get(1)).toMatchObject({ rep_codigo: 20, rep_nome: 'NOVO', origem: 'MANUAL' });
    expect(historico[0]).toMatchObject({
      rep_codigo_anterior: 10,
      rep_codigo_novo: 20,
      acao: 'ALTERACAO',
      motivo: 'Rota nova',
      usuario_id: 'u1',
    });
    expect(canceladas).toEqual(['t1']);
    expect(tarefasCriadas).toEqual([
      expect.objectContaining({ tipo: 'CONTATO', cli_codigo: 1, rep_codigo: 20, curva: 'B' }),
    ]);
  });

  it('não muda nada aqui quando o Celta recusa, e segue com os demais do lote', async () => {
    celtaRecusa.add(1);
    const r = await svc.trocar({ cli_codigos: [1, 2], rep_codigo: 20, motivo: 'Redistribuição', usuario_id: 'u1' });

    expect(r.ok).toBe(false);
    expect(r.trocados).toEqual([2]);
    expect(r.falhas).toEqual([{ cli_codigo: 1, erro: 'Cliente não encontrado' }]);
    expect(overlay.get(1).rep_codigo).toBe(10);
    expect(historico.map((h) => h.cli_codigo)).toEqual([2]);
    expect(historico[0].acao).toBe('LOTE');
  });

  it('exige motivo e papel de gestão', async () => {
    await expect(svc.trocar({ cli_codigos: [1], rep_codigo: 20, motivo: ' ', usuario_id: 'u1' })).rejects.toThrow(
      BadRequestException,
    );
    usuario = { id: 'u2', nome: 'Vendedor', setor: 'VENDAS', vendas_hub_inicial: 'ATACADO' };
    await expect(svc.trocar({ cli_codigos: [1], rep_codigo: 20, motivo: 'Teste', usuario_id: 'u2' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(celtaChamadas).toEqual([]);
  });

  it('transfere a carteira inteira do vendedor de origem', async () => {
    const r = await svc.transferir({ rep_origem: 10, rep_codigo: 20, cli_codigos: [], motivo: 'Saiu da empresa', usuario_id: 'u1' });

    expect(r.trocados.sort()).toEqual([1, 2]);
    expect(celtaChamadas.map((c) => c[1]).sort()).toEqual([1, 2]);
    expect(historico.every((h) => h.acao === 'TRANSFERENCIA')).toBe(true);
  });

  it('resgate em andamento troca de dono e ganha SLA novo se ninguém contatou', async () => {
    resgates.set(1, { id: 'r1', curva: 'A', contatado_em: null });
    await svc.trocar({ cli_codigos: [1], rep_codigo: 20, motivo: 'Rota nova', usuario_id: 'u1' });

    expect(resgateAtualizado[0].id).toBe('r1');
    expect(resgateAtualizado[0].data).toMatchObject({ rep_codigo: 20, sla_cumprido: null });
    expect(resgateAtualizado[0].data.sla_em).toBeInstanceOf(Date);
    expect(tarefasCriadas[0].tipo).toBe('RESGATE');
  });

  it('pool 316 recebe o cliente, mas não ganha tarefa', async () => {
    await svc.trocar({ cli_codigos: [1], rep_codigo: 316, motivo: 'Inativo', usuario_id: 'u1' });
    expect(overlay.get(1).rep_codigo).toBe(316);
    expect(tarefasCriadas).toEqual([]);
  });
});
