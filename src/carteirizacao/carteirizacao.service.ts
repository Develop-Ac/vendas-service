import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  CarteirizacaoSqlServerRepository,
  ClienteBaseRow,
  PeriodoComissionalRow,
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
  faturamento_3m_ant: number;
  faturamento_12m: number;
  ticket_medio: number;
  qtd_pedidos: number;
  margem_custo_pct: number; // markup: lucro / custo (margem sobre o custo)
  lucro_12m: number;
  // classificação / inteligência
  status: StatusCliente;
  alto_faturamento: boolean;
  queda: boolean;
  novo: boolean;
  score: number; // 0-100
  score_faixa: 'A' | 'B' | 'C' | 'D';
  curva_abc: 'A' | 'B' | 'C';
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

    // distribuições para percentis (entre quem comprou nos últimos 12m)
    const fats = base.map((b) => this.num(b.faturamento_12m)).filter((v) => v > 0).sort((a, b) => a - b);
    const peds = base.map((b) => this.num(b.qtd_pedidos)).filter((v) => v > 0).sort((a, b) => a - b);
    const limiarAlto =
      fats.length > 0 ? fats[Math.floor(fats.length * 0.8)] ?? fats[fats.length - 1] : Infinity;
    // percentil (0-1) de um valor numa lista ordenada asc
    const pctl = (arr: number[], v: number): number => {
      if (v <= 0 || arr.length === 0) return 0;
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; }
      return lo / arr.length;
    };

    // curva ABC: acumulado do faturamento 12m (A<=80%, B<=95%, C resto)
    const totalFat12 = base.reduce((s, b) => s + this.num(b.faturamento_12m), 0);
    const ordenadosAbc = [...base].sort((a, b) => this.num(b.faturamento_12m) - this.num(a.faturamento_12m));
    const abcMap = new Map<number, 'A' | 'B' | 'C'>();
    let acum = 0;
    for (const b of ordenadosAbc) {
      const f = this.num(b.faturamento_12m);
      if (f <= 0 || totalFat12 <= 0) { abcMap.set(b.cli_codigo, 'C'); continue; }
      acum += f;
      const share = acum / totalFat12;
      abcMap.set(b.cli_codigo, share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C');
    }

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
      const lucro12 = this.num(b.lucro_12m);
      const custo12 = this.num(b.custo_12m);
      // markup: margem sobre o custo (preço = custo × (1 + markup)). ~50% no padrão do atacado.
      const margemCustoPct = custo12 > 0 ? (lucro12 / custo12) * 100 : 0;

      let status: StatusCliente;
      if (!emCarteira) status = 'SEM_CARTEIRA';
      else if (dias != null && dias <= janelaDias) status = 'ATIVO';
      else status = 'INATIVO';

      // ---- Score do cliente (0-100): RFM + tendência + margem ----
      const sValor = pctl(fats, fat12m); // valor relativo
      const sFreq = pctl(peds, qtd); // frequência relativa
      const sRecencia = dias == null ? 0 : Math.max(0, 1 - dias / 365); // recência (1 ano -> 0)
      const sTendencia = fat3mAnt > 0
        ? Math.max(0, Math.min(1, 0.5 + (fat3m - fat3mAnt) / (fat3mAnt * 2))) // crescimento centrado em 0.5
        : fat3m > 0 ? 0.7 : 0.5;
      const sMargem = Math.max(0, Math.min(1, margemCustoPct / 100)); // markup 100%+ = topo (padrão ~50%)
      const score = Math.round(
        (sValor * 0.35 + sRecencia * 0.25 + sFreq * 0.15 + sTendencia * 0.1 + sMargem * 0.15) * 100,
      );
      const score_faixa: 'A' | 'B' | 'C' | 'D' = score >= 75 ? 'A' : score >= 50 ? 'B' : score >= 25 ? 'C' : 'D';

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
        faturamento_3m_ant: fat3mAnt,
        faturamento_12m: fat12m,
        ticket_medio: qtd > 0 ? fatTotal / qtd : 0,
        qtd_pedidos: qtd,
        margem_custo_pct: margemCustoPct,
        lucro_12m: lucro12,
        status,
        alto_faturamento: fat12m >= limiarAlto && fat12m > 0,
        queda: fat3mAnt > 0 && fat3m < fat3mAnt * 0.7,
        novo: fatTotal > 0 && Math.abs(fatTotal - fat3m) < 0.01,
        score,
        score_faixa,
        curva_abc: abcMap.get(b.cli_codigo) ?? 'C',
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
    if (q.altoFaturamento) lista = lista.filter((c) => c.alto_faturamento);
    if (q.queda) lista = lista.filter((c) => c.queda);
    if (q.novo) lista = lista.filter((c) => c.novo);
    if (q.curvaAbc) lista = lista.filter((c) => c.curva_abc === q.curvaAbc);
    if (q.scoreFaixa) lista = lista.filter((c) => c.score_faixa === q.scoreFaixa);
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

  // =================================================================
  // FASE 2 — controle e acompanhamento
  // =================================================================

  /** Indicadores agregados por vendedor (carteira). */
  async indicadoresVendedores(janelaDias = DEFAULT_JANELA_DIAS) {
    const [clientes, configs, vendedores] = await Promise.all([
      this.montar(janelaDias),
      this.overlay.listarConfigs(),
      this.listarVendedores(),
    ]);
    const configMap = new Map(configs.map((c) => [c.rep_codigo, c]));
    const nomeMap = new Map(vendedores.map((v) => [v.rep_codigo, v.rep_nome]));

    const porRep = new Map<number, ClienteCarteira[]>();
    for (const c of clientes) {
      if (!c.em_carteira || c.rep_codigo == null) continue;
      const arr = porRep.get(c.rep_codigo) ?? [];
      arr.push(c);
      porRep.set(c.rep_codigo, arr);
    }

    const linhas = [...porRep.entries()].map(([rep_codigo, cs]) => {
      const cfg = configMap.get(rep_codigo);
      const fatTotal = cs.reduce((s, c) => s + c.faturamento_total, 0);
      const fat3m = cs.reduce((s, c) => s + c.faturamento_3m, 0);
      const fat3mAnt = cs.reduce((s, c) => s + c.faturamento_3m_ant, 0);
      const fat12m = cs.reduce((s, c) => s + c.faturamento_12m, 0);
      const pedidos = cs.reduce((s, c) => s + c.qtd_pedidos, 0);
      const ativos = cs.filter((c) => c.status === 'ATIVO').length;
      const inativos = cs.filter((c) => c.status === 'INATIVO').length;
      const capacidade = cfg?.capacidade_max ?? null;
      return {
        rep_codigo,
        rep_nome: nomeMap.get(rep_codigo) ?? cs[0].rep_nome ?? `Rep ${rep_codigo}`,
        qtd_clientes: cs.length,
        ativos,
        inativos,
        sem_compra_recente: inativos,
        faturamento_total: fatTotal,
        faturamento_3m: fat3m,
        faturamento_3m_ant: fat3mAnt,
        faturamento_12m: fat12m,
        ticket_medio: pedidos > 0 ? fatTotal / pedidos : 0,
        crescimento_pct: fat3mAnt > 0 ? ((fat3m - fat3mAnt) / fat3mAnt) * 100 : null,
        clientes_alto_faturamento: cs.filter((c) => c.alto_faturamento).length,
        clientes_queda: cs.filter((c) => c.queda).length,
        capacidade_max: capacidade,
        ocupacao_pct: capacidade && capacidade > 0 ? (cs.length / capacidade) * 100 : null,
        meta_faturamento: cfg?.meta_faturamento != null ? Number(cfg.meta_faturamento) : null,
        ativo: cfg?.ativo ?? true,
      };
    });

    return linhas.sort((a, b) => b.faturamento_total - a.faturamento_total);
  }

  /** Indicadores detalhados de um cliente (frequência, evolução, potencial). */
  async indicadoresCliente(cli_codigo: number, janelaDias = DEFAULT_JANELA_DIAS) {
    const clientes = await this.montar(janelaDias);
    const cliente = clientes.find((c) => c.cli_codigo === cli_codigo);
    if (!cliente) {
      throw new BadRequestException('Cliente não encontrado no universo atacado.');
    }
    const serie = await this.sql.serieMensalCliente(cli_codigo, 12);
    const mesesComCompra = serie.length;
    const frequencia_mensal = mesesComCompra > 0
      ? serie.reduce((s, m) => s + Number(m.pedidos), 0) / 12
      : 0;
    const evolucao_pct = cliente.faturamento_3m_ant > 0
      ? ((cliente.faturamento_3m - cliente.faturamento_3m_ant) / cliente.faturamento_3m_ant) * 100
      : null;

    let potencial: string;
    if (cliente.queda) potencial = 'EM_RISCO';
    else if (cliente.novo) potencial = 'CRESCENTE';
    else if (cliente.alto_faturamento) potencial = 'ALTO';
    else if (cliente.status === 'INATIVO') potencial = 'REATIVAR';
    else potencial = 'ESTAVEL';

    return {
      ...cliente,
      frequencia_mensal,
      meses_com_compra_12m: mesesComCompra,
      evolucao_pct,
      potencial,
      serie_mensal: serie.map((m) => ({
        ano: Number(m.ano),
        mes: Number(m.mes),
        faturamento: Number(m.faturamento),
        pedidos: Number(m.pedidos),
      })),
    };
  }

  /** Alertas operacionais. */
  async alertas(janelaDias = DEFAULT_JANELA_DIAS) {
    const clientes = await this.montar(janelaDias);
    const indicadores = await this.indicadoresVendedores(janelaDias);

    const semCompra = clientes
      .filter((c) => c.em_carteira && c.status === 'INATIVO')
      .sort((a, b) => b.faturamento_total - a.faturamento_total);
    const queda = clientes
      .filter((c) => c.em_carteira && c.queda)
      .sort((a, b) => b.faturamento_total - a.faturamento_total);
    const semResponsavel = clientes
      .filter((c) => !c.em_carteira)
      .sort((a, b) => b.faturamento_total - a.faturamento_total);

    // desbalanceamento: sobrecarregados (acima da capacidade) e ociosos
    const ativos = indicadores.filter((i) => i.ativo);
    const contagens = ativos.map((i) => i.qtd_clientes);
    const media = contagens.length ? contagens.reduce((s, n) => s + n, 0) / contagens.length : 0;
    const sobrecarregados = ativos.filter(
      (i) => (i.capacidade_max != null && i.qtd_clientes > i.capacidade_max) ||
             (media > 0 && i.qtd_clientes > media * 1.5),
    );
    const ociosos = ativos.filter((i) => media > 0 && i.qtd_clientes < media * 0.5);

    const resumo = (arr: ClienteCarteira[]) => arr.slice(0, 25).map((c) => ({
      cli_codigo: c.cli_codigo,
      cli_nome: c.cli_nome,
      rep_codigo: c.rep_codigo,
      rep_nome: c.rep_nome,
      uf: c.uf,
      cidade: c.cidade,
      faturamento_total: c.faturamento_total,
      faturamento_3m: c.faturamento_3m,
      dias_sem_compra: c.dias_sem_compra,
    }));

    return {
      parametros: { janelaDias },
      sem_compra: { total: semCompra.length, clientes: resumo(semCompra) },
      queda: { total: queda.length, clientes: resumo(queda) },
      sem_responsavel: { total: semResponsavel.length, clientes: resumo(semResponsavel) },
      carteira: {
        desbalanceada: sobrecarregados.length > 0 || ociosos.length > 0,
        media_clientes: Math.round(media),
        sobrecarregados,
        ociosos,
      },
    };
  }

  // ----------------------------------------------------------- config vend.
  async getConfigVendedor(rep_codigo: number) {
    const cfg = await this.overlay.getConfig(rep_codigo);
    if (cfg) return { ...cfg, meta_faturamento: cfg.meta_faturamento != null ? Number(cfg.meta_faturamento) : null };
    const rep_nome = await this.resolverNomeRep(rep_codigo);
    return {
      rep_codigo,
      rep_nome,
      capacidade_max: null,
      canal: null,
      ativo: true,
      meta_faturamento: null,
      observacao: null,
    };
  }

  async salvarConfigVendedor(rep_codigo: number, dto: any) {
    const rep_nome = dto.rep_nome ?? (await this.resolverNomeRep(rep_codigo));
    const salvo = await this.overlay.upsertConfig({
      rep_codigo,
      rep_nome,
      capacidade_max: dto.capacidade_max ?? null,
      canal: dto.canal ?? null,
      ativo: dto.ativo ?? true,
      meta_faturamento: dto.meta_faturamento ?? null,
      observacao: dto.observacao ?? null,
    });
    return { ...salvo, meta_faturamento: salvo.meta_faturamento != null ? Number(salvo.meta_faturamento) : null };
  }

  // ------------------------------------------------------- redistribuir/bal.
  async redistribuir(dto: {
    rep_codigos: number[];
    incluirSemCarteira?: boolean;
    criterio?: 'quantidade' | 'faturamento';
    respeitarCapacidade?: boolean;
    dryRun?: boolean;
    motivo?: string;
    usuario_id?: string;
    usuario_nome?: string;
  }) {
    if (!dto.rep_codigos?.length || dto.rep_codigos.length < 2) {
      throw new BadRequestException('Informe ao menos 2 vendedores para balancear.');
    }
    const criterio = dto.criterio ?? 'quantidade';
    const alvosSet = new Set(dto.rep_codigos.map(Number));
    const [clientes, configs, vendedores] = await Promise.all([
      this.montar(DEFAULT_JANELA_DIAS),
      this.overlay.listarConfigs(),
      this.listarVendedores(),
    ]);
    const configMap = new Map(configs.map((c) => [c.rep_codigo, c]));
    const nomeMap = new Map(vendedores.map((v) => [v.rep_codigo, v.rep_nome]));

    // pool a redistribuir
    const pool = clientes.filter(
      (c) =>
        (c.em_carteira && c.rep_codigo != null && alvosSet.has(c.rep_codigo)) ||
        (dto.incluirSemCarteira && !c.em_carteira),
    );
    // ordena por faturamento desc (greedy: aloca os maiores primeiro)
    pool.sort((a, b) => b.faturamento_total - a.faturamento_total);

    // estado dos alvos (somente ativos na config)
    const alvos = [...alvosSet]
      .filter((rep) => (configMap.get(rep)?.ativo ?? true))
      .map((rep) => ({
        rep_codigo: rep,
        rep_nome: nomeMap.get(rep) ?? `Rep ${rep}`,
        capacidade: dto.respeitarCapacidade ? configMap.get(rep)?.capacidade_max ?? null : null,
        carga: 0,
        faturamento: 0,
        clientes: [] as number[],
      }));
    if (!alvos.length) throw new BadRequestException('Nenhum vendedor de destino ativo.');

    const peso = (c: ClienteCarteira) => (criterio === 'faturamento' ? c.faturamento_total : 1);
    const valorAtual = (a: (typeof alvos)[number]) =>
      criterio === 'faturamento' ? a.faturamento : a.carga;

    for (const c of pool) {
      // escolhe o alvo com menor valor atual que ainda tenha capacidade
      const disponiveis = alvos.filter((a) => a.capacidade == null || a.carga < a.capacidade);
      const lista = disponiveis.length ? disponiveis : alvos;
      lista.sort((a, b) => valorAtual(a) - valorAtual(b));
      const alvo = lista[0];
      alvo.carga += 1;
      alvo.faturamento += peso(c) === 1 ? c.faturamento_total : peso(c);
      alvo.clientes.push(c.cli_codigo);
    }

    // calcula movimentações reais (mudança de dono)
    const repAtual = new Map(pool.map((c) => [c.cli_codigo, c.em_carteira ? c.rep_codigo : null]));
    const movimentacoes: Array<{ cli_codigo: number; de: number | null; para: number }> = [];
    for (const a of alvos) {
      for (const cli of a.clientes) {
        if (repAtual.get(cli) !== a.rep_codigo) {
          movimentacoes.push({ cli_codigo: cli, de: repAtual.get(cli) ?? null, para: a.rep_codigo });
        }
      }
    }

    const plano = alvos.map((a) => ({
      rep_codigo: a.rep_codigo,
      rep_nome: a.rep_nome,
      clientes_depois: a.carga,
      faturamento_depois: a.faturamento,
      capacidade_max: a.capacidade,
    }));

    if (dto.dryRun) {
      return { dryRun: true, criterio, pool: pool.length, movimentacoes: movimentacoes.length, plano };
    }

    // aplica
    const lote_id = `redistrib_${Date.now()}`;
    const nomeAlvo = new Map(alvos.map((a) => [a.rep_codigo, a.rep_nome]));
    const cliMap = new Map(clientes.map((c) => [c.cli_codigo, c]));
    for (const mov of movimentacoes) {
      const rep_nome = nomeAlvo.get(mov.para) ?? null;
      const c = cliMap.get(mov.cli_codigo);
      await this.overlay.upsertAtribuicao({
        cli_codigo: mov.cli_codigo,
        rep_codigo: mov.para,
        rep_nome,
        origem: 'AUTOMATICA',
        atribuido_por: dto.usuario_id ?? null,
      });
      await this.overlay.registrarHistorico({
        cli_codigo: mov.cli_codigo,
        rep_codigo_anterior: mov.de,
        rep_nome_anterior: c?.rep_nome ?? null,
        rep_codigo_novo: mov.para,
        rep_nome_novo: rep_nome,
        acao: 'TRANSFERENCIA',
        motivo: dto.motivo ?? `Balanceamento automático (${criterio})`,
        usuario_id: dto.usuario_id ?? null,
        usuario_nome: dto.usuario_nome ?? null,
        lote_id,
      });
    }
    return { dryRun: false, criterio, pool: pool.length, movimentacoes: movimentacoes.length, lote_id, plano };
  }

  // =================================================================
  // FASE 3 — Metas & Performance (todos os vendedores; gerencial)
  // =================================================================
  async metasVendedores(ano?: number, mes?: number, canal?: string) {
    const hoje = new Date();
    const a = ano ?? hoje.getFullYear();
    const m = mes ?? hoje.getMonth() + 1;

    // Período comissional (26 -> 25) é a base de TODOS os números da tela:
    // realizado, dias úteis, meta diária e projeção. Datas vêm de d_calendario.
    const periodo =
      (await this.sql.periodoComissional(a, m)) ?? this.periodoComissionalFallback(a, m);

    const [ativos, metasDw, realizado, overrides] = await Promise.all([
      this.sql.vendedoresAtivosComissao(),
      this.sql.metasDw(a, m),
      this.sql.realizadoVendedores(periodo.data_inicio, periodo.data_fim),
      this.overlay.listarMetasPeriodo(a, m),
    ]);

    const dwMap = new Map(metasDw.map((x) => [x.cod_vendedor, x]));
    const realMap = new Map(realizado.map((x) => [x.vendedor_venda, x]));
    const ovMap = new Map(overrides.map((x) => [x.rep_codigo, x]));
    const nomeMap = new Map<number, string>();
    ativos.forEach((v) => nomeMap.set(v.rep_codigo, v.nome));
    metasDw.forEach((x) => { if (!nomeMap.has(x.cod_vendedor)) nomeMap.set(x.cod_vendedor, x.vendedor); });
    realizado.forEach((x) => { if (x.nome && !nomeMap.has(x.vendedor_venda)) nomeMap.set(x.vendedor_venda, x.nome); });

    // universo: ativos (comissões) + quem tem meta/override/realizado
    const codigos = new Set<number>([
      ...ativos.map((v) => v.rep_codigo),
      ...metasDw.map((x) => x.cod_vendedor),
      ...overrides.map((x) => x.rep_codigo),
      ...realizado.filter((x) => this.num(x.realizado) > 0).map((x) => x.vendedor_venda),
    ]);

    // dias ÚTEIS do período comissional (is_dia_util de d_calendario)
    const diasNoMes = periodo.dias_uteis_total;
    const diasDecorridos = periodo.dias_uteis_decorridos;

    let linhas = [...codigos].map((rep) => {
      const dw = dwMap.get(rep);
      const ov = ovMap.get(rep);
      const r = realMap.get(rep);
      const meta = ov ? Number(ov.valor_meta) : dw ? Number(dw.valor_total) : 0;
      const meta_origem = ov ? 'MANUAL' : dw ? 'DW' : 'SEM_META';
      const realizadoV = this.num(r?.realizado);
      const lucro = this.num(r?.lucro);
      const custo = this.num(r?.custo);
      const ritmoDiario = diasDecorridos > 0 ? realizadoV / diasDecorridos : 0;
      const projecao = ritmoDiario * diasNoMes;
      return {
        rep_codigo: rep,
        rep_nome: nomeMap.get(rep) ?? `Rep ${rep}`,
        ativo: ativos.some((v) => v.rep_codigo === rep),
        meta,
        meta_origem,
        meta_diaria: meta > 0 ? meta / diasNoMes : 0,
        realizado: realizadoV,
        pedidos: this.num(r?.pedidos),
        lucro,
        lucratividade_pct: realizadoV > 0 ? (lucro / realizadoV) * 100 : null,
        markup_pct: custo > 0 ? (lucro / custo) * 100 : null,
        atingimento_pct: meta > 0 ? (realizadoV / meta) * 100 : null,
        gap: meta - realizadoV,
        ritmo_diario: ritmoDiario,
        projecao,
        projecao_pct: meta > 0 ? (projecao / meta) * 100 : null,
      };
    });

    // Filtro por canal (ex.: supervisão do atacado vê só a equipe do atacado,
    // já excluindo quem saiu do atacado antes do período).
    if (canal === 'atacado') {
      const team = new Set((await this.sql.equipeAtacadoNomes(periodo.data_inicio)).map((n) => n.toUpperCase()));
      linhas = linhas.filter((l) => team.has((l.rep_nome || '').toUpperCase()));
    }

    linhas.sort((x, y) => {
      const ax = x.atingimento_pct ?? -1;
      const ay = y.atingimento_pct ?? -1;
      if (ay !== ax) return ay - ax;
      return y.realizado - x.realizado;
    });
    linhas.forEach((l, i) => ((l as any).ranking = i + 1));

    const totalMeta = linhas.reduce((s, l) => s + l.meta, 0);
    const totalRealizado = linhas.reduce((s, l) => s + l.realizado, 0);

    return {
      periodo: {
        ano: a,
        mes: m,
        data_inicio: periodo.data_inicio,
        data_fim: periodo.data_fim,
        dias_no_mes: diasNoMes,
        dias_decorridos: diasDecorridos,
      },
      resumo: {
        vendedores: linhas.length,
        com_meta: linhas.filter((l) => l.meta > 0).length,
        meta_total: totalMeta,
        realizado_total: totalRealizado,
        atingimento_total_pct: totalMeta > 0 ? (totalRealizado / totalMeta) * 100 : null,
      },
      vendedores: linhas,
    };
  }

  /**
   * Fallback do período comissional quando d_calendario não cobre o mês pedido.
   * Reproduz 26 do mês anterior -> 25 do mês de fechamento; dia útil = Seg-Sáb
   * (aproximação simples, sem feriados — só usado fora da cobertura do calendário).
   */
  private periodoComissionalFallback(ano: number, mes: number): PeriodoComissionalRow {
    const ini = new Date(ano, mes - 2, 26); // 26 do mês anterior
    const fim = new Date(ano, mes - 1, 25); // 25 do mês de fechamento
    const hoje = new Date();
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let total = 0;
    let decorridos = 0;
    for (let d = new Date(ini); d <= fim; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0) continue; // domingo não é dia útil
      total++;
      if (d <= hoje) decorridos++;
    }
    return {
      data_inicio: ymd(ini),
      data_fim: ymd(fim),
      dias_uteis_total: total,
      dias_uteis_decorridos: decorridos,
    };
  }

  /**
   * Dados para o painel de vendas (Metabase) de um vendedor: nome para o filtro
   * `vendedor` e o intervalo do período comissional vigente (26 -> 25).
   */
  async painelVendas(repCodigo: number) {
    if (!repCodigo) throw new BadRequestException('rep é obrigatório.');
    const [vendedorNome, periodo] = await Promise.all([
      this.sql.nomeRepresentanteComissao(repCodigo),
      this.sql.periodoComissionalAtual(),
    ]);
    if (!vendedorNome) {
      throw new BadRequestException(`Representante ${repCodigo} não encontrado no cadastro de comissão.`);
    }
    const p = periodo ?? this.periodoComissionalFallback(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
    );
    return {
      rep_codigo: repCodigo,
      vendedor_nome: vendedorNome,
      data_inicio: p.data_inicio,
      data_fim: p.data_fim,
    };
  }

  /** Lookup codigo_ibge -> lat/lng para o mapa de calor (vendas por município). */
  async municipiosGeo() {
    return this.sql.municipiosGeo();
  }

  /**
   * KPIs de carteira do painel: qtde em carteira (overlay Postgres), qtde de
   * clientes com venda no período (BI) e positivação = carteira - com_venda.
   */
  async painelCarteira(repCodigo: number, dataInicio: string, dataFim: string) {
    if (!repCodigo) throw new BadRequestException('rep é obrigatório.');
    const nome = await this.sql.nomeRepresentanteComissao(repCodigo);
    const [clientesCarteira, clientesComVenda] = await Promise.all([
      this.overlay.contarCarteira(repCodigo),
      nome ? this.sql.clientesComVenda(nome, dataInicio, dataFim) : Promise.resolve(0),
    ]);
    return {
      clientes_carteira: clientesCarteira,
      clientes_com_venda: clientesComVenda,
      positivacao: clientesCarteira - clientesComVenda,
    };
  }

  /**
   * Dados para o painel de Supervisão do Atacado: lista de vendedores do canal
   * (a equipe, filtro `vendedor` múltiplo) + período comissional vigente.
   */
  async painelSupervisao() {
    const periodo =
      (await this.sql.periodoComissionalAtual()) ??
      this.periodoComissionalFallback(new Date().getFullYear(), new Date().getMonth() + 1);
    const vendedores = await this.sql.equipeAtacadoNomes(periodo.data_inicio);
    return { vendedores, data_inicio: periodo.data_inicio, data_fim: periodo.data_fim };
  }

  /** Equipe do atacado com venda no período [ini, fim] (filtro de vendedor do supervisor). */
  async equipeAtacadoComVenda(ini: string, fim: string) {
    return this.sql.equipeAtacadoNomesComVenda(ini, fim);
  }

  /**
   * KPIs de carteira para o painel de Supervisão Atacado: equipe inteira (ou um
   * vendedor selecionado). Mesma lógica do painel do vendedor, mas agregando reps.
   */
  async painelCarteiraSupervisao(vendedorNome: string | undefined, dataInicio: string, dataFim: string) {
    let reps: number[];
    if (vendedorNome) {
      const rep = await this.sql.repPorNome(vendedorNome.toUpperCase());
      reps = rep ? [rep] : [];
    } else {
      reps = await this.sql.equipeAtacadoReps(dataInicio);
    }
    const [clientesCarteira, clientesComVenda] = await Promise.all([
      this.overlay.contarCarteiraReps(reps),
      this.sql.clientesComVendaReps(reps, dataInicio, dataFim),
    ]);
    return {
      clientes_carteira: clientesCarteira,
      clientes_com_venda: clientesComVenda,
      positivacao: clientesCarteira - clientesComVenda,
    };
  }

  async setMetaVendedor(
    rep_codigo: number,
    dto: { ano: number; mes: number; valor_meta: number; rep_nome?: string; observacao?: string; usuario_id?: string },
  ) {
    if (dto.ano == null || dto.mes == null) {
      throw new BadRequestException('ano e mes são obrigatórios.');
    }
    const salvo = await this.overlay.upsertMeta({
      rep_codigo,
      rep_nome: dto.rep_nome ?? null,
      ano: dto.ano,
      mes: dto.mes,
      valor_meta: dto.valor_meta ?? 0,
      observacao: dto.observacao ?? null,
      atualizado_por: dto.usuario_id ?? null,
    });
    return { ...salvo, valor_meta: Number(salvo.valor_meta) };
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
      'score',
      'score_faixa',
      'curva_abc',
      'margem_custo_pct',
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
