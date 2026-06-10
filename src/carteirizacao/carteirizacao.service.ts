import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  CarteirizacaoSqlServerRepository,
  ClienteBaseRow,
} from './carteirizacao.sqlserver.repository';
import { CarteirizacaoPrismaRepository } from './carteirizacao.prisma.repository';
import {
  AtribuirDto,
  AtribuirLoteDto,
  ListarClientesQuery,
  RemoverDto,
  SeedDto,
  StatusCliente,
  TransferirDto,
} from './dto/carteirizacao.dto';

export interface ClienteCarteira {
  cli_codigo: number;
  cli_nome: string;
  uf: string | null;
  cidade: string | null;
  fone: string | null;
  contato: string | null;
  localizacao: string | null;
  tabela_preco: string | null;
  // carteira (overlay)
  em_carteira: boolean;
  rep_codigo: number | null;
  rep_nome: string | null;
  origem: string | null;
  // referência do cadastro ERP
  rep_codigo_cadastro: number | null;
  rep_nome_cadastro: string | null;
  // métricas
  data_ult_compra: Date | null;
  dias_sem_compra: number | null;
  faturamento_total: number;
  faturamento_3m: number;
  faturamento_12m: number;
  ticket_medio: number;
  qtd_pedidos: number;
  // classificação
  status: StatusCliente;
  alto_faturamento: boolean;
  queda: boolean;
  novo: boolean;
}

const DEFAULT_JANELA_DIAS = 90;
const BASE_CACHE_TTL_MS = 60_000;

@Injectable()
export class CarteirizacaoService {
  private readonly logger = new Logger(CarteirizacaoService.name);

  private baseCache: { at: number; rows: ClienteBaseRow[] } | null = null;
  private vendedorNomeCache = new Map<number, string>();

  constructor(
    private readonly sql: CarteirizacaoSqlServerRepository,
    private readonly overlay: CarteirizacaoPrismaRepository,
  ) {}

  // ---------------------------------------------------------------- helpers
  private async getBase(force = false): Promise<ClienteBaseRow[]> {
    const now = Date.now();
    if (!force && this.baseCache && now - this.baseCache.at < BASE_CACHE_TTL_MS) {
      return this.baseCache.rows;
    }
    const rows = await this.sql.listarBaseAtacado();
    this.baseCache = { at: now, rows };
    return rows;
  }

  private num(v: unknown): number {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private maxData(a: Date | null, b: Date | null): Date | null {
    if (!a) return b;
    if (!b) return a;
    return new Date(a) > new Date(b) ? a : b;
  }

  private diasDesde(d: Date | null): number | null {
    if (!d) return null;
    const ms = Date.now() - new Date(d).getTime();
    return Math.floor(ms / 86_400_000);
  }

  /** Monta a lista mesclada (base atacado x overlay) com métricas e classificação. */
  private async montar(janelaDias: number): Promise<ClienteCarteira[]> {
    const [base, carteira] = await Promise.all([
      this.getBase(),
      this.overlay.listarCarteira(),
    ]);

    const carteiraMap = new Map(carteira.map((c) => [c.cli_codigo, c]));

    // limiar de "alto faturamento" = 80º percentil do faturamento 12m (entre quem comprou)
    const fats = base
      .map((b) => this.num(b.faturamento_12m))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    const limiarAlto =
      fats.length > 0 ? fats[Math.floor(fats.length * 0.8)] ?? fats[fats.length - 1] : Infinity;

    return base.map((b) => {
      const ov = carteiraMap.get(b.cli_codigo);
      const emCarteira = !!ov && ov.trash === 0 && ov.rep_codigo != null;
      const ultima = this.maxData(b.data_ult_compra, b.ult_compra_venda);
      const dias = this.diasDesde(ultima);
      const qtd = this.num(b.qtd_pedidos);
      const fatTotal = this.num(b.faturamento_total);
      const fat3m = this.num(b.faturamento_3m);
      const fat3mAnt = this.num(b.faturamento_3m_ant);
      const fat12m = this.num(b.faturamento_12m);

      let status: StatusCliente;
      if (!emCarteira) status = 'SEM_CARTEIRA';
      else if (dias != null && dias <= janelaDias) status = 'ATIVO';
      else status = 'INATIVO';

      return {
        cli_codigo: b.cli_codigo,
        cli_nome: b.cli_nome,
        uf: b.uf,
        cidade: b.cidade,
        fone: b.fone,
        contato: b.contato,
        localizacao: b.localizacao_completa,
        tabela_preco: b.tabela_preco,
        em_carteira: emCarteira,
        rep_codigo: emCarteira ? ov!.rep_codigo : null,
        rep_nome: emCarteira ? ov!.rep_nome : null,
        origem: ov?.origem ?? null,
        rep_codigo_cadastro: b.rep_codigo,
        rep_nome_cadastro: b.rep_cadastro_nome,
        data_ult_compra: ultima,
        dias_sem_compra: dias,
        faturamento_total: fatTotal,
        faturamento_3m: fat3m,
        faturamento_12m: fat12m,
        ticket_medio: qtd > 0 ? fatTotal / qtd : 0,
        qtd_pedidos: qtd,
        status,
        alto_faturamento: fat12m >= limiarAlto && fat12m > 0,
        queda: fat3mAnt > 0 && fat3m < fat3mAnt * 0.7,
        novo: fatTotal > 0 && Math.abs(fatTotal - fat3m) < 0.01,
      };
    });
  }

  // ----------------------------------------------------------------- listar
  async listarClientes(q: ListarClientesQuery) {
    const janela = q.janelaDias ?? DEFAULT_JANELA_DIAS;
    const todos = await this.montar(janela);

    const resumoGeral = {
      total: todos.length,
      ativos: todos.filter((c) => c.status === 'ATIVO').length,
      inativos: todos.filter((c) => c.status === 'INATIVO').length,
      sem_carteira: todos.filter((c) => c.status === 'SEM_CARTEIRA').length,
      alto_faturamento: todos.filter((c) => c.alto_faturamento).length,
      queda: todos.filter((c) => c.queda).length,
      novos: todos.filter((c) => c.novo).length,
    };

    let lista = todos;
    if (q.status) lista = lista.filter((c) => c.status === q.status);
    if (q.semVendedor) lista = lista.filter((c) => !c.em_carteira);
    if (q.rep_codigo != null) lista = lista.filter((c) => c.rep_codigo === Number(q.rep_codigo));
    if (q.uf) lista = lista.filter((c) => (c.uf ?? '').toUpperCase() === q.uf!.toUpperCase());
    if (q.faturamentoMin != null) lista = lista.filter((c) => c.faturamento_total >= Number(q.faturamentoMin));
    if (q.faturamentoMax != null) lista = lista.filter((c) => c.faturamento_total <= Number(q.faturamentoMax));
    if (q.busca) {
      const termo = q.busca.trim().toLowerCase();
      lista = lista.filter(
        (c) =>
          String(c.cli_codigo) === termo ||
          (c.cli_nome ?? '').toLowerCase().includes(termo),
      );
    }

    const ordenarPor = q.ordenarPor ?? 'faturamento_total';
    const dir = q.ordem === 'asc' ? 1 : -1;
    lista = [...lista].sort((a, b) => {
      const va = (a as any)[ordenarPor];
      const vb = (b as any)[ordenarPor];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return va.localeCompare(String(vb)) * dir;
      if (va instanceof Date || vb instanceof Date)
        return (new Date(va).getTime() - new Date(vb).getTime()) * dir;
      return (Number(va) - Number(vb)) * dir;
    });

    const page = Math.max(1, Number(q.page ?? 1));
    const pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 50)));
    const total = lista.length;
    const inicio = (page - 1) * pageSize;
    const itens = lista.slice(inicio, inicio + pageSize);

    return { itens, page, pageSize, total, totalPaginas: Math.ceil(total / pageSize), resumoGeral };
  }

  // ------------------------------------------------------------- vendedores
  async listarVendedores() {
    const [base, carteira] = await Promise.all([
      this.sql.listarVendedoresAtacado(),
      this.overlay.listarCarteira(),
    ]);

    const nomeMap = new Map<number, string>();
    base.forEach((v) => {
      nomeMap.set(v.rep_codigo, v.rep_nome);
      this.vendedorNomeCache.set(v.rep_codigo, v.rep_nome);
    });

    // reps presentes só no overlay (atribuídos manualmente)
    const repsOverlay = new Set(
      carteira.filter((c) => c.rep_codigo != null).map((c) => c.rep_codigo as number),
    );
    const faltantes = [...repsOverlay].filter((r) => !nomeMap.has(r));
    if (faltantes.length) {
      const nomes = await this.sql.nomesRepresentantes(faltantes);
      nomes.forEach((n) => {
        nomeMap.set(n.rep_codigo, n.rep_nome);
        this.vendedorNomeCache.set(n.rep_codigo, n.rep_nome);
      });
      // fallback: nome guardado no overlay
      carteira.forEach((c) => {
        if (c.rep_codigo != null && !nomeMap.has(c.rep_codigo)) {
          nomeMap.set(c.rep_codigo, c.rep_nome ?? `Rep ${c.rep_codigo}`);
        }
      });
    }

    const contagem = new Map<number, number>();
    carteira
      .filter((c) => c.trash === 0 && c.rep_codigo != null)
      .forEach((c) => contagem.set(c.rep_codigo as number, (contagem.get(c.rep_codigo as number) ?? 0) + 1));

    const codigos = new Set<number>([...nomeMap.keys(), ...repsOverlay]);
    return [...codigos]
      .map((rep_codigo) => ({
        rep_codigo,
        rep_nome: nomeMap.get(rep_codigo) ?? `Rep ${rep_codigo}`,
        clientes_carteira: contagem.get(rep_codigo) ?? 0,
      }))
      .sort((a, b) => a.rep_nome.localeCompare(b.rep_nome));
  }

  private async resolverNomeRep(rep_codigo: number): Promise<string | null> {
    if (this.vendedorNomeCache.has(rep_codigo)) return this.vendedorNomeCache.get(rep_codigo)!;
    const nomes = await this.sql.nomesRepresentantes([rep_codigo]);
    const nome = nomes[0]?.rep_nome ?? null;
    if (nome) this.vendedorNomeCache.set(rep_codigo, nome);
    return nome;
  }

  // -------------------------------------------------------------- atribuir
  async atribuir(dto: AtribuirDto) {
    if (dto.cli_codigo == null || dto.rep_codigo == null) {
      throw new BadRequestException('cli_codigo e rep_codigo são obrigatórios.');
    }
    const atual = await this.overlay.obterCliente(dto.cli_codigo);
    const rep_nome = await this.resolverNomeRep(dto.rep_codigo);

    await this.overlay.upsertAtribuicao({
      cli_codigo: dto.cli_codigo,
      rep_codigo: dto.rep_codigo,
      rep_nome,
      canal: dto.canal ?? null,
      origem: 'MANUAL',
      observacao: dto.observacao ?? null,
      atribuido_por: dto.usuario_id ?? null,
    });

    const tinhaRep = atual && atual.trash === 0 && atual.rep_codigo != null;
    await this.overlay.registrarHistorico({
      cli_codigo: dto.cli_codigo,
      rep_codigo_anterior: tinhaRep ? atual!.rep_codigo : null,
      rep_nome_anterior: tinhaRep ? atual!.rep_nome : null,
      rep_codigo_novo: dto.rep_codigo,
      rep_nome_novo: rep_nome,
      acao: tinhaRep ? 'ALTERACAO' : 'ATRIBUICAO',
      motivo: dto.motivo ?? null,
      usuario_id: dto.usuario_id ?? null,
      usuario_nome: dto.usuario_nome ?? null,
    });

    return { ok: true, cli_codigo: dto.cli_codigo, rep_codigo: dto.rep_codigo, rep_nome };
  }

  // --------------------------------------------------------- atribuir lote
  async atribuirLote(dto: AtribuirLoteDto) {
    if (!dto.cli_codigos?.length || dto.rep_codigo == null) {
      throw new BadRequestException('cli_codigos[] e rep_codigo são obrigatórios.');
    }
    const lote_id = `lote_${Date.now()}`;
    const rep_nome = await this.resolverNomeRep(dto.rep_codigo);
    let afetados = 0;

    for (const cli of dto.cli_codigos) {
      const atual = await this.overlay.obterCliente(cli);
      await this.overlay.upsertAtribuicao({
        cli_codigo: cli,
        rep_codigo: dto.rep_codigo,
        rep_nome,
        origem: 'LOTE',
        atribuido_por: dto.usuario_id ?? null,
      });
      const tinhaRep = atual && atual.trash === 0 && atual.rep_codigo != null;
      await this.overlay.registrarHistorico({
        cli_codigo: cli,
        rep_codigo_anterior: tinhaRep ? atual!.rep_codigo : null,
        rep_nome_anterior: tinhaRep ? atual!.rep_nome : null,
        rep_codigo_novo: dto.rep_codigo,
        rep_nome_novo: rep_nome,
        acao: 'LOTE',
        motivo: dto.motivo ?? null,
        usuario_id: dto.usuario_id ?? null,
        usuario_nome: dto.usuario_nome ?? null,
        lote_id,
      });
      afetados++;
    }
    return { ok: true, afetados, lote_id, rep_codigo: dto.rep_codigo, rep_nome };
  }

  // ------------------------------------------------------------ transferir
  async transferir(dto: TransferirDto) {
    if (dto.rep_origem == null || dto.rep_destino == null) {
      throw new BadRequestException('rep_origem e rep_destino são obrigatórios.');
    }
    const carteira = await this.overlay.listarCarteira();
    let alvo = carteira.filter((c) => c.trash === 0 && c.rep_codigo === Number(dto.rep_origem));
    if (dto.cli_codigos?.length) {
      const set = new Set(dto.cli_codigos.map(Number));
      alvo = alvo.filter((c) => set.has(c.cli_codigo));
    }
    if (!alvo.length) return { ok: true, afetados: 0 };

    const lote_id = `transf_${Date.now()}`;
    const rep_nome = await this.resolverNomeRep(dto.rep_destino);
    for (const c of alvo) {
      await this.overlay.upsertAtribuicao({
        cli_codigo: c.cli_codigo,
        rep_codigo: dto.rep_destino,
        rep_nome,
        origem: 'TRANSFERENCIA',
        atribuido_por: dto.usuario_id ?? null,
      });
      await this.overlay.registrarHistorico({
        cli_codigo: c.cli_codigo,
        rep_codigo_anterior: c.rep_codigo,
        rep_nome_anterior: c.rep_nome,
        rep_codigo_novo: dto.rep_destino,
        rep_nome_novo: rep_nome,
        acao: 'TRANSFERENCIA',
        motivo: dto.motivo ?? null,
        usuario_id: dto.usuario_id ?? null,
        usuario_nome: dto.usuario_nome ?? null,
        lote_id,
      });
    }
    return { ok: true, afetados: alvo.length, lote_id, rep_destino: dto.rep_destino, rep_nome };
  }

  // ---------------------------------------------------------------- remover
  async remover(cli_codigo: number, dto: RemoverDto) {
    const atual = await this.overlay.obterCliente(cli_codigo);
    if (!atual || atual.trash !== 0) {
      throw new BadRequestException('Cliente não está em nenhuma carteira.');
    }
    await this.overlay.removerCliente(cli_codigo);
    await this.overlay.registrarHistorico({
      cli_codigo,
      rep_codigo_anterior: atual.rep_codigo,
      rep_nome_anterior: atual.rep_nome,
      rep_codigo_novo: null,
      rep_nome_novo: null,
      acao: 'REMOCAO',
      motivo: dto.motivo ?? null,
      usuario_id: dto.usuario_id ?? null,
      usuario_nome: dto.usuario_nome ?? null,
    });
    return { ok: true, cli_codigo };
  }

  // --------------------------------------------------------------- histórico
  async historicoCliente(cli_codigo: number) {
    return this.overlay.listarHistoricoCliente(cli_codigo);
  }

  // -------------------------------------------------------------------- seed
  async seed(dto: SeedDto) {
    const estrategia = dto.estrategia ?? 'rep_codigo';
    if (estrategia !== 'rep_codigo') {
      throw new BadRequestException(
        `Estratégia "${estrategia}" não habilitada na Fase 1. Use "rep_codigo".`,
      );
    }
    const base = await this.getBase(true);
    const candidatos = base.filter((b) => b.rep_codigo != null);
    const rows = candidatos.map((b) => ({
      cli_codigo: b.cli_codigo,
      rep_codigo: b.rep_codigo,
      rep_nome: b.rep_cadastro_nome ?? null,
      origem: 'SEED_ERP',
    }));

    if (dto.dryRun) {
      return {
        dryRun: true,
        estrategia,
        universo_atacado: base.length,
        seriam_carteirizados: rows.length,
        ficariam_sem_carteira: base.length - rows.length,
      };
    }

    const res = await this.overlay.semearMuitos(rows);
    // histórico do seed (somente os efetivamente inseridos não é trivial saber via createMany;
    // registramos a intenção do seed por cliente candidato)
    await this.overlay.registrarHistoricoMuitos(
      rows.map((r) => ({
        cli_codigo: r.cli_codigo,
        rep_codigo_novo: r.rep_codigo,
        rep_nome_novo: r.rep_nome,
        acao: 'ATRIBUICAO',
        motivo: 'Carga inicial (SEED_ERP por rep_codigo)',
        lote_id: 'seed_erp',
      })),
    );

    return {
      dryRun: false,
      estrategia,
      universo_atacado: base.length,
      inseridos: res.count,
      candidatos: rows.length,
    };
  }

  // ------------------------------------------------------------------ export
  async exportarCsv(q: ListarClientesQuery): Promise<string> {
    const { itens } = await this.listarClientes({ ...q, page: 1, pageSize: 100000 });
    const cols = [
      'cli_codigo',
      'cli_nome',
      'uf',
      'cidade',
      'rep_codigo',
      'rep_nome',
      'status',
      'data_ult_compra',
      'dias_sem_compra',
      'faturamento_total',
      'faturamento_3m',
      'faturamento_12m',
      'ticket_medio',
      'qtd_pedidos',
    ];
    const head = cols.join(';');
    const esc = (v: unknown) => {
      if (v == null) return '';
      if (v instanceof Date) return new Date(v).toLocaleDateString('pt-BR');
      const s = String(v).replace(/"/g, '""');
      return /[;"\n]/.test(s) ? `"${s}"` : s;
    };
    const linhas = itens.map((it) => cols.map((c) => esc((it as any)[c])).join(';'));
    return ['﻿' + head, ...linhas].join('\n');
  }
}
