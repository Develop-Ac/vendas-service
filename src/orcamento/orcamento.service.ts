import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrcamentoErpRepository, ProdutoErp, ClienteErp, PromocaoItem, hojeYmd } from './orcamento.erp.repository';
import { OrcamentoBiRepository, mesComissional } from './orcamento.bi.repository';
import { OrcamentoPrismaRepository, GiroItem } from './orcamento.prisma.repository';
import {
  Avaliacao,
  avaliarItem,
  calcularBolsa,
  degrauMix1,
  FAIXAS,
  FaixaVolume,
  precoDaTabela,
  RegraFaixa,
  round2,
} from './regua';
import { DesfechoOrcamentoDto, ExcecaoReguaDto, ItemOrcamentoDto, SalvarOrcamentoDto } from './dto/orcamento.dto';

/* =============================================================================
   ORÇAMENTO DO ATACADO — regras.
   -----------------------------------------------------------------------------
   A tela existe para dar AUTONOMIA com trilho: o vendedor vê, por item, até
   onde pode ir sozinho (preço mínimo da régua) e, no mês, quanto de desconto
   ainda cabe sem perder o bônus da comissão. Abaixo do mínimo o orçamento não
   é proibido — vai para APROVAÇÃO do supervisor. Abaixo do custo é recusado.

   Fontes, por pergunta:
     saldo e preço de tabela do cliente  -> ERP ao vivo (erp-firebird-api)
     classe/faixa/desc. máx/preço mínimo -> régua v3 (Postgres) sobre o custo do ERP
     equivalentes                        -> grupos de similares da análise de estoque
     vendem juntos                       -> pares apurados no BI (cron semanal)
     bolsa de desconto do vendedor       -> BI, mês comissional (26 a 25)
   ============================================================================= */

export interface ProdutoOrcamento {
  pro_codigo: number;
  descricao: string;
  referencia: string | null;
  unidade: string | null;
  aplicacoes: string | null;
  subgrp_codigo: number | null;
  inativo: boolean;
  estoque_disponivel: number;
  estoque_reservado: number;
  custo: number | null;
  preco_tabela: number;
  tabela_coluna: string;
  preco_fallback: boolean;
  preco_tabela_5: number;
  preco_tabela_2: number;
  avaliacao: Avaliacao;
  excecao_motivo: string | null;
  giro: Omit<GiroItem, 'pro_codigo'> | null;
  ultimo_preco_cliente: { dt_emissao: string; unitario: number; quantidade: number } | null;
  tem_equivalente: boolean;
  /** Promoção vigente na tabela do cliente: o preço é o promocional e não há desconto por cima. */
  promocao: { codigo: number; descricao: string; data_final: string; somente_avista: boolean } | null;
}

export interface ClienteOrcamento {
  cli_codigo: number;
  cli_nome: string;
  cpf_cnpj: string | null;
  uf: string | null;
  cidade: string | null;
  fone: string | null;
  celular: string | null;
  contato: string | null;
  email: string | null;
  rep_codigo: number | null;
  tabela_preco: string | null;
  tabela_coluna: string;
  atacado: boolean;
  inativo: boolean;
  con_codigo: number | null;
  limite_credito: number;
  crediario_bloqueado: boolean;
  data_ult_compra: string | null;
}

const CONCEITO: Record<number, string> = { 1: 'BOM', 2: 'REGULAR', 3: 'RUIM' };
const STATUS_EDITAVEL = new Set(['RASCUNHO', 'ENVIADO', 'APROVACAO']);

@Injectable()
export class OrcamentoService {
  private readonly logger = new Logger(OrcamentoService.name);

  constructor(
    private readonly erp: OrcamentoErpRepository,
    private readonly bi: OrcamentoBiRepository,
    private readonly db: OrcamentoPrismaRepository,
  ) {}

  /* ---------------------------------------------------------- parâmetros */

  parametros() {
    const num = (k: string, d: number) => {
      const v = Number(process.env[k]);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    return {
      bonus_pct: num('ORCAMENTO_DESC_BONUS_PCT', 0.03),
      pena_pct: num('ORCAMENTO_DESC_PENA_PCT', 0.06),
      validade_dias: num('ORCAMENTO_VALIDADE_DIAS', 7),
    };
  }

  async regua() {
    return { regua: await this.db.regua(), volume: await this.db.volume(), faixas: FAIXAS, parametros: this.parametros() };
  }

  async salvarExcecao(proCodigo: number, dto: ExcecaoReguaDto) {
    return this.db.salvarExcecao(proCodigo, dto);
  }

  listarExcecoes() {
    return this.db.listarExcecoes();
  }

  /* ------------------------------------------------------------- cliente */

  private mapCliente(c: ClienteErp): ClienteOrcamento {
    const tabela = c.TABELA_PRECO;
    return {
      cli_codigo: c.CLI_CODIGO,
      cli_nome: c.CLI_NOME,
      cpf_cnpj: c.CPF_CNPJ,
      uf: c.UF,
      cidade: c.CIDADE,
      fone: c.FONE,
      celular: c.CELULAR,
      contato: c.CONTATO,
      // CLIENTES não tem coluna de e-mail no Celta (só FONE/CELULAR/CONTATO).
      email: null,
      rep_codigo: c.REP_CODIGO,
      tabela_preco: tabela,
      tabela_coluna: precoDaTabela({}, tabela).coluna,
      atacado: ['2', '5'].includes(tabela ?? ''),
      inativo: c.INATIVO === 'S',
      con_codigo: c.CON_CODIGO,
      limite_credito: Number(c.LIMITE_CREDITO ?? 0),
      crediario_bloqueado: c.BLOQUEAR_VENDA_CREDIARIO === 'S',
      data_ult_compra: c.DATA_ULT_COMPRA,
    };
  }

  async buscarClientes(q: string, todos = false) {
    const r = await this.erp.buscarClientes(q, todos);
    return r.map((c) => this.mapCliente(c));
  }

  /** Cabeçalho do cliente: cadastro ao vivo + crédito em aberto e histórico do BI. */
  async cliente(cli: number) {
    const c = await this.erp.clientePorCodigo(cli);
    if (!c) throw new NotFoundException(`Cliente ${cli} não encontrado no ERP.`);
    const base = this.mapCliente(c);
    let resumo: Awaited<ReturnType<OrcamentoBiRepository['resumoCliente']>> | null = null;
    try {
      resumo = await this.bi.resumoCliente(cli);
    } catch (e) {
      this.logger.warn(`BI indisponível para o resumo do cliente ${cli}: ${(e as Error).message}`);
    }
    const liberado = !base.crediario_bloqueado && (resumo?.crediario ?? 'LIBERADO').toUpperCase() !== 'BLOQUEADO';
    const emAberto = resumo?.valor_em_aberto ?? 0;
    const dataUlt = [base.data_ult_compra, resumo?.ult_compra].filter(Boolean).sort().pop() ?? null;
    const dias = dataUlt ? Math.floor((Date.now() - new Date(dataUlt).getTime()) / 86_400_000) : null;
    return {
      ...base,
      conceito: base.con_codigo != null ? CONCEITO[base.con_codigo] ?? `Conceito ${base.con_codigo}` : null,
      crediario_liberado: liberado,
      valor_em_aberto: emAberto,
      titulos_vencidos: resumo?.titulos_vencidos ?? 0,
      limite_disponivel: liberado ? round2(base.limite_credito - emAberto) : 0,
      faturamento_12m: resumo?.faturamento_12m ?? 0,
      pedidos_12m: resumo?.pedidos_12m ?? 0,
      data_ult_compra: dataUlt,
      dias_sem_compra: dias,
      desconto_padrao_erp: resumo?.desconto_padrao ?? null,
      bi_disponivel: resumo != null,
    };
  }

  /* --------------------------------------------------------------- bolsa */

  /**
   * A bolsa de desconto do vendedor: quanto já deu no mês comissional e quanto
   * ainda cabe para ficar no bônus (≤3%) ou não cair na pena (>6%). Com o
   * orçamento em edição, projeta o depois.
   */
  async bolsa(rep: number, orc?: { bruto: number; desconto: number }) {
    const p = this.parametros();
    const periodo = mesComissional();
    const v = await this.bi.bolsaVendedor(rep, periodo.ano, periodo.mes);
    const bruto = v.venda_liquida + v.desconto;
    const bolsa = calcularBolsa({
      bruto_mtd: bruto,
      desconto_mtd: v.desconto,
      bruto_orc: orc?.bruto ?? 0,
      desconto_orc: orc?.desconto ?? 0,
      bonus_pct: p.bonus_pct,
      pena_pct: p.pena_pct,
    });
    const part = v.venda_liquida > 0 ? v.mix1_liquido / v.venda_liquida : 0;
    const abertos = await this.db.abertosDoVendedor(rep);
    const descAbertos = abertos.reduce((s, o) => s + Number(o.desconto_total), 0);
    const brutoAbertos = abertos.reduce((s, o) => s + Number(o.subtotal), 0);
    return {
      periodo,
      notas: v.notas,
      venda_liquida: round2(v.venda_liquida),
      bolsa,
      mix1: { ...degrauMix1(part), venda_mix1: round2(v.mix1_liquido) },
      // Orçamentos enviados e ainda sem desfecho: se todos fecharem, é isto que entra.
      em_aberto: {
        quantidade: abertos.length,
        total: round2(abertos.reduce((s, o) => s + Number(o.total), 0)),
        desconto: round2(descAbertos),
        pct_se_fechar_tudo:
          bruto + brutoAbertos > 0 ? Math.round(((v.desconto + descAbertos) / (bruto + brutoAbertos)) * 10000) / 10000 : 0,
      },
    };
  }

  /* ------------------------------------------------------------ produtos */

  /** Enriquecimento comum: régua, exceção, giro, último preço do cliente, equivalente. */
  private async enriquecer(produtos: ProdutoErp[], tabelaPreco: string | null, cli?: number): Promise<ProdutoOrcamento[]> {
    if (!produtos.length) return [];
    const codigos = produtos.map((p) => p.PRO_CODIGO);
    const [regua, volume, excecoes, giro, ultimos, comGrupo, promos] = await Promise.all([
      this.db.regua(),
      this.db.volume(),
      this.db.excecoes(codigos),
      this.db.giro(codigos).catch((e) => {
        this.logger.warn(`Giro indisponível: ${(e as Error).message}`);
        return new Map<number, GiroItem>();
      }),
      cli
        ? this.bi.ultimosPrecosCliente(cli, codigos).catch(() => [])
        : Promise.resolve([] as Awaited<ReturnType<OrcamentoBiRepository['ultimosPrecosCliente']>>),
      this.db.temGrupo(codigos),
      this.erp.promocoesVigentes(codigos, tabelaPreco).catch((e) => {
        this.logger.warn(`Promoções indisponíveis: ${(e as Error).message}`);
        return new Map<number, PromocaoItem>();
      }),
    ]);
    const ultimoPor = new Map(ultimos.map((u) => [u.pro_codigo, u]));
    return produtos.map((p) =>
      this.montarProduto(p, tabelaPreco, regua, volume, excecoes.get(p.PRO_CODIGO) ?? null, giro.get(p.PRO_CODIGO) ?? null, ultimoPor.get(p.PRO_CODIGO) ?? null, comGrupo.has(p.PRO_CODIGO), promos.get(p.PRO_CODIGO) ?? null),
    );
  }

  private montarProduto(
    p: ProdutoErp,
    tabelaPreco: string | null,
    regua: RegraFaixa[],
    volume: FaixaVolume[],
    excecao: Parameters<typeof avaliarItem>[0]['excecao'],
    giro: GiroItem | null,
    ultimo: { dt_emissao: string; unitario: number; quantidade: number } | null,
    temEquivalente: boolean,
    promo: PromocaoItem | null,
  ): ProdutoOrcamento {
    const tabela = precoDaTabela(p as unknown as Record<string, unknown>, tabelaPreco);
    // Item em promoção vigente na tabela do cliente: o preço É o promocional e
    // não há desconto por cima dele — o mínimo é o próprio preço.
    const preco = promo ? { coluna: 'PROMOCAO', preco: promo.valor, fallback: false } : tabela;
    const custo = p.PRECO_CUSTO > 0 ? p.PRECO_CUSTO : null;
    let avaliacao = avaliarItem({
      custo,
      preco_tabela: preco.preco,
      subgrp_codigo: p.SUBGRP_CODIGO,
      descricao: p.PRO_DESCRICAO,
      excecao,
      regua,
      volume,
    });
    if (promo) {
      const fim = promo.data_final.split('-').reverse().join('/');
      avaliacao = {
        ...avaliacao,
        desc_max_pct: 0,
        desc_max_efetivo_pct: 0,
        preco_minimo: promo.valor,
        fracao_volume: 0,
        escala_volume: avaliacao.escala_volume.map((d) => ({ ...d, desc_max_pct: 0, desc_max_efetivo_pct: 0, preco_minimo: promo.valor })),
        motivo: `Promoção "${promo.descricao}" até ${fim}: preço fechado, sem desconto.`,
      };
    }
    return {
      pro_codigo: p.PRO_CODIGO,
      descricao: p.PRO_DESCRICAO,
      referencia: p.REFERENCIA,
      unidade: p.UNIDADE,
      aplicacoes: p.APLICACOES,
      subgrp_codigo: p.SUBGRP_CODIGO,
      inativo: p.INATIVO === 'S',
      estoque_disponivel: p.ESTOQUE_DISPONIVEL,
      estoque_reservado: p.ESTOQUE_RESERVADO,
      custo,
      preco_tabela: preco.preco,
      tabela_coluna: preco.coluna,
      preco_fallback: preco.fallback,
      preco_tabela_2: p.PRECO2,
      preco_tabela_5: p.PRECO5,
      avaliacao,
      excecao_motivo: excecao?.motivo ?? null,
      giro: giro ? { curva_abc: giro.curva_abc, categoria_saldo_atual: giro.categoria_saldo_atual, tempo_medio_saldo_atual: giro.tempo_medio_saldo_atual, tendencia_label: giro.tendencia_label, group_id: giro.group_id } : null,
      ultimo_preco_cliente: ultimo ? { dt_emissao: ultimo.dt_emissao, unitario: ultimo.unitario, quantidade: ultimo.quantidade } : null,
      tem_equivalente: temEquivalente,
      promocao: promo ? { codigo: promo.prom_codigo, descricao: promo.descricao, data_final: promo.data_final, somente_avista: promo.somente_avista } : null,
    };
  }

  async buscarProdutos(q: string, tabelaPreco: string | null, cli?: number, limite = 30) {
    const r = await this.erp.buscarProdutos(q, limite);
    return this.enriquecer(r, tabelaPreco, cli);
  }

  async produtosPorCodigo(codigos: number[], tabelaPreco: string | null, cli?: number) {
    const r = await this.erp.produtosPorCodigo(codigos);
    return this.enriquecer(r, tabelaPreco, cli);
  }

  /** Equivalentes (mesmo grupo de similares) — com saldo primeiro. */
  async equivalentes(codigo: number, tabelaPreco: string | null, cli?: number) {
    const codigos = await this.db.equivalentes(codigo);
    if (!codigos.length) return [];
    const lista = await this.produtosPorCodigo(codigos, tabelaPreco, cli);
    return lista
      .filter((p) => !p.inativo)
      .sort((a, b) => b.estoque_disponivel - a.estoque_disponivel || a.preco_tabela - b.preco_tabela);
  }

  /** Vendem juntos — só o que tem saldo hoje (sugestão que não pode ser atendida atrapalha). */
  async relacionados(codigo: number, tabelaPreco: string | null, cli?: number) {
    const pares = await this.db.relacionados(codigo, 12);
    if (!pares.length) return [];
    const lista = await this.produtosPorCodigo(pares.map((p) => p.pro_codigo), tabelaPreco, cli);
    const porCodigo = new Map(lista.map((p) => [p.pro_codigo, p]));
    return pares
      .map((par) => {
        const p = porCodigo.get(par.pro_codigo);
        return p ? { ...p, juntos: par.juntos, base: par.base, suporte_pct: par.suporte_pct } : null;
      })
      .filter((p): p is NonNullable<typeof p> => !!p && !p.inativo && p.estoque_disponivel > 0)
      .slice(0, 8);
  }

  async produto(codigo: number, tabelaPreco: string | null, cli?: number) {
    const [lista, equivalentes, relacionados] = await Promise.all([
      this.produtosPorCodigo([codigo], tabelaPreco, cli),
      this.equivalentes(codigo, tabelaPreco, cli),
      this.relacionados(codigo, tabelaPreco, cli).catch(() => []),
    ]);
    if (!lista.length) throw new NotFoundException(`Produto ${codigo} não encontrado na empresa 3.`);
    return { produto: lista[0], equivalentes, relacionados };
  }

  /** Apuração dos pares "vendem juntos" (cron semanal ou botão). */
  async recalcularRelacionados(meses = 12) {
    const inicio = Date.now();
    const pares = await this.bi.paresVendemJuntos(meses, 3);
    // Guarda só os 12 mais fortes de cada produto: a tela mostra 8 e o resto é ruído.
    const porProduto = new Map<number, typeof pares>();
    for (const p of pares) {
      const l = porProduto.get(p.pro_codigo) ?? [];
      l.push(p);
      porProduto.set(p.pro_codigo, l);
    }
    const linhas: Array<{ pro_codigo: number; pro_relacionado: number; juntos: number; base: number; suporte_pct: number }> = [];
    for (const [, l] of porProduto) {
      l.sort((a, b) => b.juntos - a.juntos);
      for (const p of l.slice(0, 12)) {
        linhas.push({ ...p, suporte_pct: p.base > 0 ? Math.round((p.juntos / p.base) * 10000) / 10000 : 0 });
      }
    }
    const gravados = await this.db.gravarRelacionados(linhas);
    return { meses, pares_apurados: pares.length, produtos: porProduto.size, gravados, ms: Date.now() - inicio };
  }

  /* ----------------------------------------------------------- orçamento */

  listar(f: { rep_codigo?: number; cli_codigo?: number; status?: string; page?: number; pageSize?: number }) {
    return this.db.listar(f);
  }

  async obter(id: string) {
    const o = await this.db.obter(id);
    if (!o) throw new NotFoundException('Orçamento não encontrado.');
    return o;
  }

  /**
   * Monta os itens com dados AO VIVO: preço de tabela, custo e saldo vêm do ERP
   * na hora de salvar — o que a tela mostrou pode ter mudado. O preço negociado
   * é do vendedor; o resto é fotografia.
   */
  private async montarItens(itens: ItemOrcamentoDto[], tabelaPreco: string | null, cli: number) {
    if (!itens.length) throw new BadRequestException('Orçamento sem itens.');
    const produtos = await this.produtosPorCodigo(itens.map((i) => i.pro_codigo), tabelaPreco, cli);
    const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
    const erros: string[] = [];
    const linhas: Prisma.ven_orcamento_itemUncheckedCreateInput[] = [];
    let subtotal = 0, total = 0, acima = false;

    itens.forEach((i, idx) => {
      const p = porCodigo.get(i.pro_codigo);
      if (!p) { erros.push(`Item ${idx + 1}: produto ${i.pro_codigo} não existe na empresa 3.`); return; }
      const qtd = Number(i.quantidade);
      const tabela = p.preco_tabela;
      // O vendedor NUNCA digita preço: só desconto. O preço nasce da tabela do
      // cliente menos o desconto; `preco_unit` só vale para item SEM tabela.
      const descPedido = Math.min(1, Math.max(0, Number(i.desc_pct ?? 0)));
      let preco = tabela > 0 ? round2(tabela * (1 - descPedido)) : round2(Number(i.preco_unit ?? 0));
      if (!(preco > 0)) {
        erros.push(`Item ${idx + 1} (${p.descricao}): sem preço de tabela — informe o preço.`);
        return;
      }
      if (p.custo != null && preco < p.custo) {
        erros.push(`Item ${idx + 1} (${p.descricao}): preço ${preco.toFixed(2)} abaixo do custo — não permitido.`);
        return;
      }
      const descPct = tabela > 0 ? Math.max(0, Math.round((1 - preco / tabela) * 10000) / 10000) : 0;
      // Desconto máximo e mínimo valem para ESTA quantidade (escala por volume).
      const degrau = [...p.avaliacao.escala_volume].reverse().find((d) => qtd >= d.qtd_min) ?? p.avaliacao.escala_volume[0];
      const minimo = degrau?.preco_minimo ?? p.avaliacao.preco_minimo;
      const descMaxQtd = degrau?.desc_max_efetivo_pct ?? p.avaliacao.desc_max_efetivo_pct;
      const itemAcima = minimo > 0 && preco < minimo - 0.005;
      acima = acima || itemAcima;
      const linhaTotal = round2(preco * qtd);
      subtotal += round2((tabela > 0 ? tabela : preco) * qtd);
      total += linhaTotal;
      linhas.push({
        orcamento_id: '',
        item: idx + 1,
        pro_codigo: p.pro_codigo,
        descricao: p.descricao,
        referencia: p.referencia,
        unidade: p.unidade,
        quantidade: qtd,
        preco_tabela: tabela > 0 ? tabela : preco,
        tabela_coluna: p.tabela_coluna,
        preco_unit: preco,
        desc_pct: descPct,
        total: linhaTotal,
        custo_ref: p.custo,
        classe: p.avaliacao.classe,
        mix: p.avaliacao.mix,
        faixa: p.avaliacao.faixa,
        markup_regua: p.avaliacao.markup_regua,
        desc_max_pct: descMaxQtd,
        preco_minimo: minimo,
        acima_alcada: itemAcima,
        estoque_disponivel: p.estoque_disponivel,
        substituto_de: i.substituto_de ?? null,
        observacao: i.observacao ?? null,
        promocao_codigo: p.promocao?.codigo ?? null,
        promocao_fim: p.promocao ? new Date(`${p.promocao.data_final}T00:00:00`) : null,
      });
    });
    if (erros.length) throw new BadRequestException(erros);
    subtotal = round2(subtotal); total = round2(total);
    const desconto = round2(subtotal - total);
    return {
      linhas,
      subtotal,
      total,
      desconto_total: desconto,
      desc_pct: subtotal > 0 ? Math.round((desconto / subtotal) * 10000) / 10000 : 0,
      acima_alcada: acima,
      produtos,
    };
  }

  /**
   * Validade da proposta: SEMPRE hoje + ORCAMENTO_VALIDADE_DIAS (7). Com item em
   * promoção, encolhe para a DATA_FINAL da promoção mais próxima de vencer
   * entre os itens do orçamento — o preço prometido não existe depois dela.
   * Nada vem da tela.
   */
  private validade(linhas: Prisma.ven_orcamento_itemUncheckedCreateInput[]) {
    const d = new Date(`${hojeYmd()}T00:00:00`);
    d.setDate(d.getDate() + this.parametros().validade_dias);
    let v = d;
    for (const l of linhas) {
      const fim = l.promocao_fim instanceof Date ? l.promocao_fim : l.promocao_fim ? new Date(l.promocao_fim as string) : null;
      if (fim && fim.getTime() >= new Date(`${hojeYmd()}T00:00:00`).getTime() && fim.getTime() < v.getTime()) v = fim;
    }
    return v;
  }

  private async bolsaSnapshot(rep: number, subtotal: number, desconto: number) {
    try {
      const b = await this.bolsa(rep, { bruto: subtotal, desconto });
      return { antes: b.bolsa.pct_atual, depois: b.bolsa.pct_apos };
    } catch (e) {
      this.logger.warn(`Bolsa indisponível ao salvar (rep ${rep}): ${(e as Error).message}`);
      return { antes: null, depois: null };
    }
  }

  async criar(dto: SalvarOrcamentoDto) {
    const cliente = await this.erp.clientePorCodigo(dto.cli_codigo);
    if (!cliente) throw new BadRequestException(`Cliente ${dto.cli_codigo} não encontrado no ERP.`);
    const m = await this.montarItens(dto.itens, cliente.TABELA_PRECO, dto.cli_codigo);
    const bolsa = await this.bolsaSnapshot(dto.rep_codigo, m.subtotal, m.desconto_total);
    return this.db.criar(
      {
        cli_codigo: dto.cli_codigo,
        cli_nome: cliente.CLI_NOME,
        tabela_preco: cliente.TABELA_PRECO,
        rep_codigo: dto.rep_codigo,
        rep_nome: dto.rep_nome ?? null,
        status: 'RASCUNHO',
        validade: this.validade(m.linhas),
        observacao: dto.observacao ?? null,
        subtotal: m.subtotal,
        desconto_total: m.desconto_total,
        total: m.total,
        desc_pct: m.desc_pct,
        acima_alcada: m.acima_alcada,
        bolsa_pct_antes: bolsa.antes,
        bolsa_pct_depois: bolsa.depois,
        usuario_id: dto.usuario_id ?? null,
        usuario_nome: dto.usuario_nome ?? null,
      },
      m.linhas,
    );
  }

  async atualizar(id: string, dto: SalvarOrcamentoDto) {
    const atual = await this.obter(id);
    if (!STATUS_EDITAVEL.has(atual.status)) {
      throw new BadRequestException(`Orçamento ${atual.status} não pode ser alterado.`);
    }
    const cliente = await this.erp.clientePorCodigo(dto.cli_codigo);
    if (!cliente) throw new BadRequestException(`Cliente ${dto.cli_codigo} não encontrado no ERP.`);
    const m = await this.montarItens(dto.itens, cliente.TABELA_PRECO, dto.cli_codigo);
    const bolsa = await this.bolsaSnapshot(dto.rep_codigo, m.subtotal, m.desconto_total);
    // Editar um orçamento já enviado o devolve ao rascunho: o que o cliente recebeu mudou.
    return this.db.atualizar(
      id,
      {
        cli_codigo: dto.cli_codigo,
        cli_nome: cliente.CLI_NOME,
        tabela_preco: cliente.TABELA_PRECO,
        rep_codigo: dto.rep_codigo,
        rep_nome: dto.rep_nome ?? atual.rep_nome,
        status: 'RASCUNHO',
        validade: this.validade(m.linhas),
        observacao: dto.observacao ?? null,
        subtotal: m.subtotal,
        desconto_total: m.desconto_total,
        total: m.total,
        desc_pct: m.desc_pct,
        acima_alcada: m.acima_alcada,
        bolsa_pct_antes: bolsa.antes,
        bolsa_pct_depois: bolsa.depois,
        aprovado_por: null,
        aprovado_em: null,
        enviado_em: null,
      },
      m.linhas.map((l) => ({ ...l, orcamento_id: id })),
    );
  }

  /** Enviar = fechar a proposta. Item abaixo do mínimo manda para APROVAÇÃO. */
  async enviar(id: string, usuario?: { usuario_id?: string; usuario_nome?: string }) {
    const o = await this.obter(id);
    if (!['RASCUNHO', 'APROVACAO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento ${o.status} não pode ser enviado.`);
    }
    if (!o.itens?.length) throw new BadRequestException('Orçamento sem itens.');
    const precisaAprovar = o.acima_alcada && !o.aprovado_em;
    return this.db.atualizar(id, {
      status: precisaAprovar ? 'APROVACAO' : 'ENVIADO',
      enviado_em: precisaAprovar ? null : new Date(),
      usuario_id: usuario?.usuario_id ?? o.usuario_id,
      usuario_nome: usuario?.usuario_nome ?? o.usuario_nome,
    });
  }

  /** Supervisor libera o que está abaixo do mínimo; o orçamento segue como ENVIADO. */
  async aprovar(id: string, usuario?: { usuario_id?: string; usuario_nome?: string }) {
    const o = await this.obter(id);
    if (o.status !== 'APROVACAO') throw new BadRequestException('Só orçamento em APROVAÇÃO pode ser aprovado.');
    return this.db.atualizar(id, {
      status: 'ENVIADO',
      aprovado_por: usuario?.usuario_nome ?? usuario?.usuario_id ?? 'supervisor',
      aprovado_em: new Date(),
      enviado_em: new Date(),
    });
  }

  async desfecho(id: string, dto: DesfechoOrcamentoDto) {
    const o = await this.obter(id);
    if (['FECHADO', 'PERDIDO', 'CANCELADO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento já está ${o.status}.`);
    }
    if (dto.resultado === 'PERDIDO' && !dto.motivo) throw new BadRequestException('Informe o motivo da perda.');
    return this.db.atualizar(id, {
      status: dto.resultado,
      desfecho_em: new Date(),
      desfecho_motivo: dto.resultado === 'PERDIDO' ? dto.motivo : null,
      desfecho_ref: dto.referencia ?? null,
      observacao: dto.observacao ? `${o.observacao ? o.observacao + '\n' : ''}${dto.observacao}` : o.observacao,
    });
  }

  async cancelar(id: string) {
    const o = await this.obter(id);
    if (['FECHADO', 'PERDIDO'].includes(o.status)) throw new BadRequestException(`Orçamento ${o.status} não pode ser cancelado.`);
    return this.db.atualizar(id, { status: 'CANCELADO' });
  }

  /**
   * Re-avalia um orçamento salvo contra o ERP de agora: saldo que sumiu, tabela
   * que mudou. Não grava — é o aviso da tela ao reabrir.
   */
  async conferir(id: string) {
    const o = await this.obter(id);
    const produtos = await this.produtosPorCodigo((o.itens ?? []).map((i) => i.pro_codigo), o.tabela_preco, o.cli_codigo);
    const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
    const avisos = (o.itens ?? []).flatMap((i) => {
      const p = porCodigo.get(i.pro_codigo);
      if (!p) return [`${i.pro_codigo}: produto não encontrado no ERP.`];
      const a: string[] = [];
      if (p.estoque_disponivel < i.quantidade) a.push(`${i.pro_codigo} ${i.descricao}: saldo ${p.estoque_disponivel} < ${i.quantidade} orçados.`);
      if (Math.abs(p.preco_tabela - i.preco_tabela) > 0.005) a.push(`${i.pro_codigo} ${i.descricao}: tabela mudou de ${i.preco_tabela.toFixed(2)} para ${p.preco_tabela.toFixed(2)}.`);
      return a;
    });
    return { orcamento: o, produtos, avisos };
  }
}
