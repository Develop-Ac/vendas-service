import { gerarPdfOrcamento, PdfOrcamento } from './orcamento.pdf';
import { mensagemWhatsapp } from './orcamento.mensagem';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrcamentoErpRepository, ProdutoErp, ClienteErp, PromocaoItem, hojeYmd, OpcoesBusca, OrcamentoCelta } from './orcamento.erp.repository';
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
  ref_fabricante: string | null;
  ref_fornecedor: string | null;
  unidade: string | null;
  aplicacoes: string | null;
  ncm: string | null;
  localizacao: string | null;
  marca: string | null;
  grupo: string | null;
  subgrupo: string | null;
  subgrp_codigo: number | null;
  inativo: boolean;
  comercializavel: boolean;
  estoque_disponivel: number;
  estoque_reservado: number;
  estoque_fora: number;
  estoque_terceiros: number;
  custo: number | null;
  preco_tabela: number;
  /** Preço da tabela do cliente ANTES da promoção (o "de:" da EST012). */
  preco_original: number;
  tabela_coluna: string;
  preco_fallback: boolean;
  preco_venda: number;
  preco_tabela_5: number;
  preco_tabela_2: number;
  /** Grupo de similares (pesquisa): mesma chave = mesma cadeia; `principal` = o cabeça. */
  grupo_chave: string | null;
  principal: boolean;
  avaliacao: Avaliacao;
  excecao_motivo: string | null;
  giro: Omit<GiroItem, 'pro_codigo'> | null;
  ultimo_preco_cliente: { dt_emissao: string; unitario: number; quantidade: number } | null;
  tem_equivalente: boolean;
  /** Promoção vigente na tabela do cliente: o preço é o promocional e não há desconto por cima. */
  promocao: { codigo: number; descricao: string; data_final: string; somente_avista: boolean } | null;
  /** Promoção do balcão (tabela 1) vigente, SEM preço na tabela do cliente — só informação. */
  promocao_balcao: { codigo: number; descricao: string; data_final: string; de: number; por: number } | null;
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
    const aplica = promo != null && promo.valor != null;
    const preco = aplica ? { coluna: 'PROMOCAO', preco: promo!.valor as number, fallback: false } : tabela;
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
    if (aplica && promo) {
      const fim = promo.data_final.split('-').reverse().join('/');
      avaliacao = {
        ...avaliacao,
        desc_max_pct: 0,
        desc_max_efetivo_pct: 0,
        preco_minimo: promo.valor as number,
        fracao_volume: 0,
        escala_volume: avaliacao.escala_volume.map((d) => ({ ...d, desc_max_pct: 0, desc_max_efetivo_pct: 0, preco_minimo: promo.valor as number })),
        motivo: `Promoção "${promo.descricao}" até ${fim}: preço fechado, sem desconto.`,
      };
    }
    return {
      pro_codigo: p.PRO_CODIGO,
      descricao: p.PRO_DESCRICAO,
      referencia: p.REFERENCIA,
      ref_fabricante: p.REF_FABRICANTE,
      ref_fornecedor: p.REF_FORNECEDOR,
      unidade: p.UNIDADE,
      aplicacoes: p.APLICACOES,
      ncm: p.NCM,
      localizacao: p.LOCALIZACAO,
      marca: p.MARCA,
      grupo: p.GRUPO,
      subgrupo: p.SUBGRUPO,
      subgrp_codigo: p.SUBGRP_CODIGO,
      inativo: p.INATIVO === 'S',
      comercializavel: p.COMERCIALIZAVEL !== 'N',
      estoque_disponivel: p.ESTOQUE_DISPONIVEL,
      estoque_reservado: p.ESTOQUE_RESERVADO,
      estoque_fora: p.ESTOQUE_FORA_ESTABELECIMENTO,
      estoque_terceiros: p.ESTOQUE_EM_TERCEIROS,
      custo,
      preco_tabela: preco.preco,
      preco_original: tabela.preco,
      tabela_coluna: preco.coluna,
      preco_fallback: preco.fallback,
      preco_venda: p.PRECO_VENDA,
      preco_tabela_2: p.PRECO2,
      preco_tabela_5: p.PRECO5,
      grupo_chave: null,
      principal: false,
      avaliacao,
      excecao_motivo: excecao?.motivo ?? null,
      giro: giro ? { curva_abc: giro.curva_abc, categoria_saldo_atual: giro.categoria_saldo_atual, tempo_medio_saldo_atual: giro.tempo_medio_saldo_atual, tendencia_label: giro.tendencia_label, group_id: giro.group_id } : null,
      ultimo_preco_cliente: ultimo ? { dt_emissao: ultimo.dt_emissao, unitario: ultimo.unitario, quantidade: ultimo.quantidade } : null,
      tem_equivalente: temEquivalente,
      promocao: aplica && promo ? { codigo: promo.prom_codigo, descricao: promo.descricao, data_final: promo.data_final, somente_avista: promo.somente_avista } : null,
      promocao_balcao:
        !aplica && promo && promo.valor_balcao != null
          ? { codigo: promo.prom_codigo, descricao: promo.descricao, data_final: promo.data_final, de: p.PRECO_VENDA, por: promo.valor_balcao }
          : null,
    };
  }

  async buscarProdutos(q: string, tabelaPreco: string | null, cli?: number, limite = 30) {
    const { produtos } = await this.erp.buscarProdutos(q, { modo: q.includes('%') ? 'comeca' : 'contem', limite });
    return this.enriquecer(produtos, tabelaPreco, cli);
  }

  /**
   * Pesquisa no padrão da EST012: filtros da tela + os SIMILARES encadeados.
   * Cada resultado é agrupado com os membros do seu grupo de similares (mesma
   * descrição e linha de marca); o `principal` é o de maior saldo do grupo, e
   * os demais vêm logo abaixo dele, em ordem de saldo. Itens sem grupo são
   * grupos de um só.
   */
  async pesquisar(q: string, tabelaPreco: string | null, cli: number | undefined, o: OpcoesBusca & { equivalentes?: boolean }) {
    const { produtos: achados, truncado } = await this.erp.buscarProdutos(q, o);
    const limite = o.limite ?? 60;
    if (!achados.length) return { itens: [] as ProdutoOrcamento[], truncado: false, limite };
    const codigos = achados.map((p) => p.PRO_CODIGO);
    const grupos = o.equivalentes === false ? [] : await this.db.gruposDe(codigos).catch((e) => {
      this.logger.warn(`Grupos de similares indisponíveis: ${(e as Error).message}`);
      return [] as Array<{ pro_codigo: number; chave: string }>;
    });
    const chavePor = new Map(grupos.map((g) => [g.pro_codigo, g.chave]));
    const extras = grupos.map((g) => g.pro_codigo).filter((c) => !codigos.includes(c));
    const extrasErp = extras.length ? await this.erp.produtosPorCodigo(extras) : [];
    // Similar que não passou nos filtros da tela (inativo / sem saldo) não entra.
    const extrasOk = extrasErp.filter((p) => (o.inativos || p.INATIVO !== 'S') && (!o.comEstoque || p.ESTOQUE_DISPONIVEL > 0) && (!o.comercializavel || p.COMERCIALIZAVEL !== 'N'));
    const todos = await this.enriquecer([...achados, ...extrasOk], tabelaPreco, cli);
    for (const p of todos) p.grupo_chave = chavePor.get(p.pro_codigo) ?? `solo:${p.pro_codigo}`;

    // Ordem: grupos na ordem em que apareceram na busca; dentro do grupo, o
    // principal (maior saldo; empate = menor código) e depois os similares por saldo.
    const ordemGrupo = new Map<string, number>();
    for (const p of todos) if (!ordemGrupo.has(p.grupo_chave!)) ordemGrupo.set(p.grupo_chave!, ordemGrupo.size);
    const porGrupo = new Map<string, ProdutoOrcamento[]>();
    for (const p of todos) porGrupo.set(p.grupo_chave!, [...(porGrupo.get(p.grupo_chave!) ?? []), p]);
    const saida: ProdutoOrcamento[] = [];
    for (const [chave] of [...ordemGrupo.entries()].sort((a, b) => a[1] - b[1])) {
      const membros = (porGrupo.get(chave) ?? []).sort((a, b) => b.estoque_disponivel - a.estoque_disponivel || a.pro_codigo - b.pro_codigo);
      membros.forEach((m, i) => { m.principal = i === 0; });
      saida.push(...membros);
    }
    return { itens: saida, truncado, limite };
  }

  /**
   * Orçamentos do Celta dos últimos `dias` ainda pendentes (sem venda do
   * cliente e sem motivo de perda registrado) — a lista de trabalho do dia,
   * na tela inicial. O vendedor vê os seus; gestão vê todos.
   */
  async celtaPendentes(rep: number | undefined, dias = 7) {
    const d = Math.max(1, Math.min(60, dias));
    const itens = await this.erp.orcamentosCeltaPendentes(d, rep);
    const comDesfecho = await this.db.celtaComDesfecho(itens.map((o) => o.orcamento)).catch(() => new Set<number>());
    const abertos = itens.filter((o) => !comDesfecho.has(o.orcamento));
    return {
      dias: d,
      total: abertos.length,
      valor_total: round2(abertos.reduce((s, o) => s + o.total, 0)),
      itens: abertos,
    };
  }

  /**
   * Orçamentos ATIVOS do cliente — o que o vendedor vê ao apertar Orçar na
   * Estação: os da intranet em aberto (rascunho/enviado/aprovação, dentro da
   * validade) e os do Celta ainda vigentes (sem venda e sem motivo de perda).
   * Orçamento do Celta já importado para a intranet não aparece duas vezes
   * (o import grava "Celta <nº>" na observação).
   */
  async ativos(cli: number): Promise<{ intranet: any[]; celta: OrcamentoCelta[] }> {
    const hoje = hojeYmd();
    const ymd = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);
    const [lista, celta] = await Promise.all([
      this.db.listar({ cli_codigo: cli, pageSize: 50 }),
      this.erp.orcamentosCeltaAtivos(cli).catch(() => [] as OrcamentoCelta[]),
    ]);
    const intranet = (lista.itens as any[]).filter((o) => {
      if (!['RASCUNHO', 'ENVIADO', 'APROVACAO'].includes(o.status)) return false;
      const v = ymd(o.validade);
      return !v || v >= hoje;
    });
    const comDesfecho = await this.db.celtaComDesfecho(celta.map((o) => o.orcamento)).catch(() => new Set<number>());
    const importados = new Set<number>();
    for (const o of intranet) for (const m of String(o.observacao ?? '').matchAll(/Celta (\d+)/g)) importados.add(Number(m[1]));
    return { intranet, celta: celta.filter((o) => !comDesfecho.has(o.orcamento) && !importados.has(o.orcamento)) };
  }

  /**
   * Itens de um orçamento do Celta prontos para entrar no orçamento da
   * intranet: cada produto avaliado na régua para a TABELA DO CLIENTE de hoje,
   * com a quantidade do Celta e o desconto que o unitário praticado lá
   * representa sobre a tabela de hoje (nunca negativo — se o Celta cobrou
   * acima da tabela, entra sem desconto). Item que não existe mais ou está
   * inativo vem em `ignorados`, com o motivo.
   */
  async celtaItens(orcamento: number, tabelaPreco: string | null, cli?: number) {
    const cab = await this.erp.orcamentoCelta(orcamento);
    if (!cab) throw new NotFoundException(`Orçamento ${orcamento} não encontrado no Celta.`);
    const itens = await this.erp.itensOrcamentoCelta(orcamento);
    const cliente = cli ?? cab.cli_codigo;
    const tabela = tabelaPreco ?? (await this.erp.clientePorCodigo(cliente))?.TABELA_PRECO ?? null;
    const produtos = itens.length ? await this.produtosPorCodigo(itens.map((i) => i.pro_codigo), tabela, cliente) : [];
    const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
    const prontos: Array<{ produto: ProdutoOrcamento; quantidade: number; desc_pct: number; unitario_celta: number }> = [];
    const ignorados: Array<{ pro_codigo: number; descricao: string; motivo: string }> = [];
    for (const i of itens) {
      const p = porCodigo.get(i.pro_codigo);
      if (!p) { ignorados.push({ pro_codigo: i.pro_codigo, descricao: i.descricao, motivo: 'produto não encontrado' }); continue; }
      if (p.inativo) { ignorados.push({ pro_codigo: i.pro_codigo, descricao: i.descricao, motivo: 'produto inativo' }); continue; }
      const desc = p.preco_tabela > 0 && i.unitario > 0 && i.unitario < p.preco_tabela ? Math.round((1 - i.unitario / p.preco_tabela) * 10000) / 10000 : 0;
      prontos.push({ produto: p, quantidade: Math.max(1, i.quantidade), desc_pct: p.promocao ? 0 : desc, unitario_celta: i.unitario });
    }
    return { orcamento: cab, cli_codigo: cliente, tabela_preco: tabela, itens: prontos, ignorados };
  }

  imagensDoProduto(codigo: number) {
    return this.erp.imagensDoProduto(codigo);
  }

  imagem(id: number) {
    return this.erp.imagem(id);
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

  /**
   * Vendem juntos — só o que tem saldo hoje (sugestão que não pode ser atendida
   * atrapalha). Dois níveis, do mais específico ao mais amplo:
   *   1. pares do PRÓPRIO produto (>= 3 notas juntos em 12 meses);
   *   2. pares do SUBGRUPO do produto — o que sai junto com qualquer item dele
   *      (cola e arame de remoção com para-brisa). No atacado a maioria dos
   *      produtos sai em poucas notas e não forma par próprio; sem este nível a
   *      seção ficava vazia para quase todo item.
   */
  async relacionados(codigo: number, tabelaPreco: string | null, cli?: number) {
    const [base] = await this.produtosPorCodigo([codigo], tabelaPreco, cli);
    const [paresProduto, paresSubgrupo] = await Promise.all([
      this.db.relacionados(codigo, 12),
      base?.subgrp_codigo != null ? this.db.relacionadosSubgrupo(base.subgrp_codigo, 15) : Promise.resolve([]),
    ]);
    const jaTem = new Set(paresProduto.map((p) => p.pro_codigo));
    const candidatos = [
      ...paresProduto.map((p) => ({ ...p, origem: 'produto' as const })),
      ...paresSubgrupo.filter((p) => p.pro_codigo !== codigo && !jaTem.has(p.pro_codigo)).map((p) => ({ ...p, origem: 'subgrupo' as const })),
    ];
    if (!candidatos.length) return [];
    const lista = await this.produtosPorCodigo(candidatos.map((p) => p.pro_codigo), tabelaPreco, cli);
    const porCodigo = new Map(lista.map((p) => [p.pro_codigo, p]));
    return candidatos
      .map((par) => {
        const p = porCodigo.get(par.pro_codigo);
        return p
          ? { ...p, juntos: par.juntos, base: par.base, suporte_pct: par.suporte_pct, origem: par.origem, subgrupo_base: base?.subgrupo ?? null }
          : null;
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
    const [pares, paresSub] = await Promise.all([this.bi.paresVendemJuntos(meses, 3), this.bi.paresSubgrupoVendemJuntos(meses, 5)]);
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

    // Subgrupo: os 15 mais fortes de cada um (a tela completa até 8 com eles).
    const porSubgrupo = new Map<number, typeof paresSub>();
    for (const p of paresSub) {
      const l = porSubgrupo.get(p.subgrp_codigo) ?? [];
      l.push(p);
      porSubgrupo.set(p.subgrp_codigo, l);
    }
    const linhasSub: Array<{ subgrp_codigo: number; pro_relacionado: number; juntos: number; base: number; suporte_pct: number }> = [];
    for (const [, l] of porSubgrupo) {
      l.sort((a, b) => b.juntos - a.juntos);
      for (const p of l.slice(0, 15)) {
        linhasSub.push({ ...p, suporte_pct: p.base > 0 ? Math.round((p.juntos / p.base) * 10000) / 10000 : 0 });
      }
    }
    const gravados_subgrupo = await this.db.gravarRelacionadosSubgrupo(linhasSub);
    return { meses, pares_apurados: pares.length, produtos: porProduto.size, gravados, subgrupos: porSubgrupo.size, gravados_subgrupo, ms: Date.now() - inicio };
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

  /** O cliente RECEBEU a proposta (mensagem + PDF pelo WhatsApp da Estação). */
  async entregue(id: string, canal: string) {
    const o = await this.obter(id);
    if (!['ENVIADO', 'FECHADO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento ${o.status}: só proposta ENVIADA pode ser entregue ao cliente.`);
    }
    return this.db.atualizar(id, { entregue_canal: canal, entregue_em: new Date() });
  }

  /** Texto da mensagem + PDF em base64 — o que a Estação manda no chat ativo. */
  async mensagem(id: string) {
    const dados = await this.dadosImpressao(id);
    const pdf = await gerarPdfOrcamento(dados);
    return {
      texto: mensagemWhatsapp(dados),
      arquivo: { nome: `orcamento-${dados.numero}.pdf`, mime: 'application/pdf', base64: pdf.toString('base64') },
    };
  }

  async pdf(id: string): Promise<{ nome: string; dados: Buffer }> {
    const dados = await this.dadosImpressao(id);
    return { nome: `orcamento-${dados.numero}.pdf`, dados: await gerarPdfOrcamento(dados) };
  }

  /**
   * Orçamento salvo + cadastro do cliente + marca dos itens (a marca não é
   * gravada no item; vem do ERP na hora — se o ERP falhar, sai em branco).
   */
  private async dadosImpressao(id: string): Promise<PdfOrcamento> {
    const o = await this.obter(id);
    const itens = o.itens ?? [];
    const [cli, produtos] = await Promise.all([
      this.erp.clienteParaPdf(o.cli_codigo).catch(() => null),
      itens.length
        ? this.produtosPorCodigo(itens.map((i: any) => Number(i.pro_codigo)), o.tabela_preco, o.cli_codigo).catch(() => [] as ProdutoOrcamento[])
        : Promise.resolve([] as ProdutoOrcamento[]),
    ]);
    const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
    const dmy = (v: Date | string | null | undefined) => {
      if (!v) return null;
      const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
      const [a, m, d] = s.split('-');
      return a && m && d ? `${d}/${m}/${a}` : null;
    };
    const n = (v: unknown) => Number(v ?? 0);
    const linhas = itens.map((i: any) => {
      const p = porCodigo.get(Number(i.pro_codigo));
      const promoFim = dmy(i.promocao_fim);
      return {
        pro_codigo: Number(i.pro_codigo),
        descricao: String(i.descricao ?? p?.descricao ?? ''),
        marca: p?.marca ?? null,
        unidade: i.unidade ?? p?.unidade ?? 'UN',
        quantidade: n(i.quantidade),
        preco_tabela: n(i.preco_tabela),
        desc_pct: n(i.desc_pct),
        preco_unit: n(i.preco_unit),
        total: n(i.total),
        promocao_fim: promoFim,
        preco_original: promoFim && p && p.preco_original > n(i.preco_tabela) ? p.preco_original : null,
      };
    });
    const numero = String(o.numero).padStart(6, '0');
    const endereco = cli ? [cli.ENDERECO, cli.NUMERO].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(', ') : null;
    return {
      numero,
      emissao: dmy(o.created_at) ?? '',
      validade: dmy(o.validade),
      vendedor: o.rep_nome ? `${o.rep_nome}${o.rep_codigo != null ? ` (${o.rep_codigo})` : ''}` : o.rep_codigo != null ? String(o.rep_codigo) : '—',
      cliente: {
        codigo: o.cli_codigo,
        nome: String(o.cli_nome ?? cli?.CLI_NOME ?? ''),
        cpf_cnpj: cli?.CPF_CNPJ ?? null,
        rg_ie: cli?.RG_IE ? String(cli.RG_IE).trim() || null : null,
        fone: [cli?.FONE, cli?.CELULAR].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(' ') || null,
        endereco: endereco || null,
        bairro: cli?.BAIRRO ? String(cli.BAIRRO).trim() : null,
        cep: cli?.CEP ? String(cli.CEP).trim() : null,
        cidade: cli?.CIDADE ?? null,
        uf: cli?.UF ?? null,
        tabela_nome: nomeTabelaCliente(o.tabela_preco),
      },
      itens: linhas,
      subtotal: n(o.subtotal),
      desconto: n(o.desconto_total),
      desc_pct: n(o.desc_pct),
      total: n(o.total),
      observacao: o.observacao ?? null,
    };
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

/** Mesmo vocabulário da tela: nada de "tabela 2" para o cliente. */
function nomeTabelaCliente(t: string | null | undefined): string | null {
  const v = (t ?? '').trim();
  if (v === '2') return 'Cliente atacado';
  if (v === '5') return 'Cliente atacado especial';
  if (v === '1' || v === '') return v ? 'Cliente varejo' : null;
  return `Tabela ${v}`;
}
