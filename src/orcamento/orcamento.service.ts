import { gerarPdfOrcamento, ModoDesconto, PdfItem, PdfOrcamento } from './orcamento.pdf';
import { mensagemWhatsapp } from './orcamento.mensagem';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OrcamentoErpRepository, ProdutoErp, ClienteErp, PromocaoItem, hojeYmd, OpcoesBusca, OrcamentoCelta, ordenarBuscaClientes } from './orcamento.erp.repository';
import { OrcamentoBiRepository, mesComissional, mesesAnteriores } from './orcamento.bi.repository';
import { celulasDoOrcamento, comissaoComOrcamento } from './comissao';
import { OrcamentoPrismaRepository, GiroItem } from './orcamento.prisma.repository';
import {
  Avaliacao,
  alcadaDoItem,
  avaliarItem,
  calcularBolsa,
  BOLSA_PISO_PADRAO,
  LINHA_4PCT_PADRAO,
  PISO_ITEM_PADRAO,
  PREMIO_PADRAO,
  parseDegrausBolsa,
  pisoPorDre,
  pisoPorVolume,
  degrauMix1,
  FAIXAS,
  FaixaVolume,
  absorcaoPromocao, colunaTabela, ehTabelaAtacado, precoDaTabela,
  RegraFaixa,
  round2,
} from './regua';
import { DecisaoSaldoDto, DesfechoOrcamentoDto, ExcecaoReguaDto, ItemOrcamentoDto, SalvarOrcamentoDto, TributacaoDto } from './dto/orcamento.dto';
import { calcularDifal, calcularSt, descricaoIndicadorIe, regimeInterestadual, seloTributacao, type ParametrosSt, type RegimeInterestadual } from './tributacao';
import { aplicarDecisoes, pendenciasSaldo } from './saldo';
import { OrcamentoCeltaRepository, type ComparativoCelta } from './orcamento.celta.repository';
import { chaveIdempotencia, corpoParaCelta, diferencasComparativo, type LinhaComparativo } from './celta';
import { AvisosVendasService } from '../common/avisos/avisos-vendas.service';
import { analyticsAtacadoGet } from '../common/analytics/analytics-atacado';

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
     bolsa de desconto do vendedor       -> BI, mês comissional (26 a 25): receita, custo e desconto
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
  /** subtipo 09 (serviço): não tem preço de tabela nem saldo — entra com quantidade 1 e o preço informado no orçamento */
  servico: boolean;
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
  /**
   * Como o item fica se o vendedor escolher vender FORA da promoção/liquidação:
   * tabela normal do cliente e avaliação da régua sobre ela (desconto e alçada
   * padrão, bolsa padrão). Nulo quando não há promoção vigente na tabela.
   */
  sem_promocao: { preco_tabela: number; tabela_coluna: string; preco_fallback: boolean; avaliacao: Avaliacao } | null;
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
  /** Defaults de pagamento do cadastro do cliente — o orçamento parte deles. */
  cp_codigo: number | null;
  fp_entrada: string | null;
  /** Venda líquida dos últimos 12 meses (BI) — só na busca; ausente se o BI não respondeu. */
  compras_12m?: number;
  /** Indicador da IE na NF-e (1 contribuinte, 2 isento, 9 não contribuinte) — decide ST × DIFAL fora do estado. */
  indicador_ie: number | null;
}

/** Como o imposto interestadual se aplica a este cliente/orçamento. */
export interface ResumoTributacao {
  regime: RegimeInterestadual;
  uf: string | null;
  indicador_ie: number | null;
  indicador_ie_descricao: string | null;
  presencial: boolean;
  /** Texto curto para o selo do cliente; nulo quando nada muda (mesmo estado). */
  selo: string | null;
}

/** Quantos candidatos a busca de cliente pede ao ERP antes de ordenar por canal/compras e cortar. */
const BUSCA_CLIENTES_CANDIDATOS = 60;
const BUSCA_CLIENTES_LIMITE = 20;

const CONCEITO: Record<number, string> = { 1: 'BOM', 2: 'REGULAR', 3: 'RUIM' };
const STATUS_EDITAVEL = new Set(['RASCUNHO', 'ENVIADO', 'APROVACAO']);

@Injectable()
export class OrcamentoService {
  private readonly logger = new Logger(OrcamentoService.name);

  constructor(
    private readonly erp: OrcamentoErpRepository,
    private readonly bi: OrcamentoBiRepository,
    private readonly db: OrcamentoPrismaRepository,
    private readonly celta: OrcamentoCeltaRepository,
    private readonly avisos: AvisosVendasService,
  ) {}

  /* ---------------------------------------------------------- parâmetros */

  parametros() {
    const num = (k: string, d: number) => {
      const v = Number(process.env[k]);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    return {
      // Bolsa. Modo 'dre' (padrão): o piso sai da DRE do canal (janela de meses fechados) — custo,
      // despesas fixas e variáveis REAIS, meta de 4% — e a linha dos 4% é o próprio piso. Modo
      // 'degrau': tabela volume→piso pela média dos 3 últimos meses. Modo 'fixo': piso e linha por
      // env (bolsa "adiantada"). Prêmio = fração do lucro acima da linha; piso absoluto do item.
      bolsa_modo: (['fixo', 'degrau', 'dre'].find((m) => m === (process.env.ORCAMENTO_BOLSA_MODO ?? 'dre').toLowerCase()) ?? 'dre') as 'fixo' | 'degrau' | 'dre',
      bolsa_dre_meses: Math.max(1, Math.round(num('ORCAMENTO_BOLSA_DRE_MESES', 12))),
      meta_resultado: num('ORCAMENTO_META_RESULTADO', 0.04),
      bolsa_degraus: parseDegrausBolsa(process.env.ORCAMENTO_BOLSA_DEGRAUS),
      bolsa_piso: num('ORCAMENTO_BOLSA_PISO', BOLSA_PISO_PADRAO),
      // 0 (padrão) = a linha do prêmio é o próprio piso: prêmio sobre TODO o saldo retido.
      linha_4pct: num('ORCAMENTO_LINHA_4PCT', 0),
      premio_pct: num('ORCAMENTO_PREMIO_PCT', PREMIO_PADRAO),
      piso_item: num('ORCAMENTO_ITEM_PISO', PISO_ITEM_PADRAO),
      validade_dias: num('ORCAMENTO_VALIDADE_DIAS', 7),
      // ICMS fora do estado: UFs liberadas (a situação 010 é do Pará; outro estado entra quando o
      // fiscal cadastrar a situação dele) e a situação tributária do ST no Celta.
      tributacao_ufs: (process.env.ORCAMENTO_TRIBUTACAO_UFS ?? 'PA').split(',').map((u) => u.trim().toUpperCase()).filter(Boolean),
      st_situacao: (process.env.ORCAMENTO_ST_SITUACAO ?? '010').trim(),
      // Mandar regime e DIFAL/ST por item na importação ao Celta: só quando a api-vendas-service
      // que os aceita (plano v3, seção 11) estiver no ar — a atual recusa campo desconhecido.
      celta_tributacao: ['1', 'true', 'sim'].includes((process.env.ORCAMENTO_CELTA_TRIBUTACAO ?? '').trim().toLowerCase()),
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
      atacado: ehTabelaAtacado(tabela),
      inativo: c.INATIVO === 'S',
      con_codigo: c.CON_CODIGO,
      limite_credito: Number(c.LIMITE_CREDITO ?? 0),
      crediario_bloqueado: c.BLOQUEAR_VENDA_CREDIARIO === 'S',
      data_ult_compra: c.DATA_ULT_COMPRA,
      cp_codigo: c.CP_CODIGO == null ? null : Number(c.CP_CODIGO),
      fp_entrada: c.FP_ENTRADA ? String(c.FP_ENTRADA).trim() || null : null,
      indicador_ie: c.INDICADOR_IE_DESTINATARIO,
    };
  }

  /** Regime do imposto interestadual do cliente para a presença informada (padrão: não presencial). */
  resumoTributacao(c: { UF: string | null; INDICADOR_IE_DESTINATARIO: number | null }, presencial = false): ResumoTributacao {
    const regime = regimeInterestadual({ uf: c.UF, indicador_ie: c.INDICADOR_IE_DESTINATARIO }, presencial, this.parametros().tributacao_ufs);
    return {
      regime,
      uf: c.UF ? String(c.UF).trim().toUpperCase() : null,
      indicador_ie: c.INDICADOR_IE_DESTINATARIO,
      indicador_ie_descricao: descricaoIndicadorIe(c.INDICADOR_IE_DESTINATARIO),
      presencial,
      selo: seloTributacao(regime, c.UF),
    };
  }

  /**
   * Busca de cliente ordenada: canal (2/5) → compras 12 m → nome. O ERP devolve
   * até 60 candidatos; só esses vão ao BI (uma consulta), e a lista é cortada em
   * 20. BI fora do ar não derruba a busca — fica sem o critério de compras.
   */
  async buscarClientes(q: string, todos = false) {
    const r = await this.erp.buscarClientes(q, todos, BUSCA_CLIENTES_CANDIDATOS);
    let compras = new Map<number, number>();
    try {
      compras = await this.bi.comprasClientes12m(r.clientes.map((c) => c.CLI_CODIGO));
    } catch (e) {
      this.logger.warn(`BI indisponível para as compras 12m da busca de cliente: ${(e as Error).message}`);
    }
    const o = ordenarBuscaClientes(r.clientes, compras, BUSCA_CLIENTES_LIMITE, r.truncado);
    return {
      clientes: o.clientes.map((c) => ({ ...this.mapCliente(c), compras_12m: compras.get(c.CLI_CODIGO) ?? 0 })),
      truncado: o.truncado,
      limite: BUSCA_CLIENTES_LIMITE,
    };
  }

  /** Cabeçalho do cliente: cadastro ao vivo + crédito em aberto e histórico do BI. */
  /* ----------------------------------------------------------- pagamento */

  /** Vendedores do filtro da lista e do seletor do editor: ativos do atacado na comissão. */
  vendedores() {
    return this.bi.vendedoresAtacado();
  }

  /** Listas do Celta para os seletores do orçamento (condições de venda e formas ativas). */
  async pagamento() {
    const [condicoes, formas] = await Promise.all([this.erp.condicoesPagto(), this.erp.formasPagto()]);
    return { condicoes, formas };
  }

  /** Condição e forma do DTO conferidas no Celta, com a descrição copiada para o PDF e a mensagem. */
  private async pagamentoDe(dto: SalvarOrcamentoDto) {
    const cp = dto.cp_codigo ?? null;
    const fp = dto.fp_codigo?.trim() || null;
    let cp_descricao: string | null = null;
    let fp_descricao: string | null = null;
    if (cp != null) {
      const c = (await this.erp.condicoesPagto()).find((x) => x.cp_codigo === cp);
      if (!c) throw new BadRequestException(`Condição de pagamento ${cp} não existe, está inativa ou não é de venda.`);
      cp_descricao = c.descricao;
    }
    if (fp) {
      const f = (await this.erp.formasPagto()).find((x) => x.fp_codigo === fp);
      if (!f) throw new BadRequestException(`Forma de pagamento ${fp} não existe ou está inativa.`);
      fp_descricao = f.descricao;
    }
    return { cp_codigo: cp, cp_descricao, fp_codigo: fp, fp_descricao };
  }

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
      // vendedor da carteira: a tela avisa quando o orçamento é de outro vendedor
      rep_nome: await this.erp.nomeRepresentante(base.rep_codigo),
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
      // imposto fora do estado, na presença padrão (não presencial); a tela reavalia ao marcar presencial
      tributacao: this.resumoTributacao(c),
    };
  }

  /**
   * Chegadas previstas (pedido de compra / carga em trânsito) dos códigos pedidos — até 200 por
   * chamada. Olha o próprio produto E o grupo de similares dele (a mesma regra dos equivalentes):
   * a chegada de um similar vem marcada `similar: true`, com o código e a descrição de quem chega,
   * porque o vendedor precisa dizer ao cliente que é outro item. `pro_codigo` é sempre o código
   * PEDIDO (o que está sem saldo); quem chega está em `chegada_codigo`.
   * Junto vêm os SIMILARES COM SALDO agora (`com_saldo`, saldo lido do ERP sem cache, ativos e
   * comercializáveis, maior saldo primeiro): é a resposta mais útil para um item sem saldo.
   * E o que está AGUARDANDO LIBERAÇÃO (`aguardando`): a nota de compra já foi lançada na empresa
   * fiscal (o pedido vira "Entregue" e some das chegadas), mas ainda não entrou na empresa 3 —
   * a peça está na loja, na conferência do recebimento, e ainda não tem saldo para vender.
   */
  /**
   * AGUARDANDO LIBERAÇÃO por código: itens de nota de compra lançada na empresa fiscal cuja
   * NF ainda não entrou na gerencial (peça na loja, em conferência, sem saldo para vender).
   */
  private async aguardandoLiberacao(codigos: number[]) {
    const lancadas = await this.db.itensDeNfLancada(codigos);
    const naGerencial = lancadas.length ? await this.erp.nfsLancadasNaGerencial(lancadas.map((l) => l.chave_nfe)) : new Set<string>();
    const m = new Map<number, typeof lancadas>();
    for (const l of lancadas.filter((x) => !naGerencial.has(x.chave_nfe))) m.set(l.pro_codigo, [...(m.get(l.pro_codigo) ?? []), l]);
    return m;
  }

  /**
   * Saldo que vale para decidir o orçamento: disponível no ERP + aguardando liberação. Peça em
   * conferência não é pendência de saldo (o vendedor segue, e o papel avisa "aguardando liberação").
   */
  private async saldoComLiberacao(codigos: number[], produtos: ProdutoOrcamento[]) {
    const aguardando = await this.aguardandoLiberacao(codigos).catch(() => new Map<number, Array<{ quantidade: number }>>());
    const soma = (cod: number) => (aguardando.get(cod) ?? []).reduce((s, a) => s + Number(a.quantidade), 0);
    return {
      aguardando: soma,
      // serviço não controla estoque: saldo infinito, nunca é pendência
      saldoPor: new Map<number, number | undefined>(produtos.map((p) => [p.pro_codigo, p.servico ? Number.POSITIVE_INFINITY : Math.max(0, p.estoque_disponivel) + soma(p.pro_codigo)])),
    };
  }

  async chegadas(codigos: number[]) {
    const limpos = [...new Set(codigos.filter((c) => Number.isInteger(c) && c > 0))].slice(0, 200);
    if (!limpos.length) return { aguardando: [], chegadas: [], com_saldo: [] };
    const membros = await this.db.gruposDe(limpos); // todos os membros dos grupos dos códigos pedidos
    const chaveDe = new Map(membros.map((m) => [m.pro_codigo, m.chave]));
    const doGrupo = new Map<string, number[]>();
    for (const m of membros) doGrupo.set(m.chave, [...(doGrupo.get(m.chave) ?? []), m.pro_codigo]);
    const previstas = await this.db.chegadasPrevistas([...new Set([...limpos, ...membros.map((m) => m.pro_codigo)])]);
    const porCodigo = new Map<number, typeof previstas>();
    for (const p of previstas) porCodigo.set(p.pro_codigo, [...(porCodigo.get(p.pro_codigo) ?? []), p]);
    const similaresDe = (cod: number) => {
      const chave = chaveDe.get(cod);
      return (chave ? doGrupo.get(chave) ?? [] : []).filter((c) => c !== cod);
    };
    const aguardandoPorCodigo = await this.aguardandoLiberacao([...new Set([...limpos, ...membros.map((m) => m.pro_codigo)])]);
    const erpSimilares = await this.erp.produtosPorCodigo([...new Set(limpos.flatMap(similaresDe))]);
    const comSaldo = new Map(
      erpSimilares.filter((p) => p.ESTOQUE_DISPONIVEL > 0 && p.INATIVO !== 'S' && p.COMERCIALIZAVEL !== 'N').map((p) => [p.PRO_CODIGO, p]),
    );
    return {
      aguardando: limpos.flatMap((cod) =>
        [cod, ...similaresDe(cod)].flatMap((c) =>
          (aguardandoPorCodigo.get(c) ?? []).map((l) => ({ pro_codigo: cod, item_codigo: c, similar: c !== cod, pedido: l.pedido, quantidade: l.quantidade, dt_entrada: l.dt_entrada })),
        ),
      ),
      chegadas: limpos.flatMap((cod) => {
        const linhas = [cod, ...similaresDe(cod)].flatMap((c) =>
          (porCodigo.get(c) ?? []).map(({ pro_codigo, ...resto }) => ({ pro_codigo: cod, chegada_codigo: pro_codigo, similar: pro_codigo !== cod, ...resto })),
        );
        // o próprio item antes dos similares; dentro de cada bloco, a data mais próxima primeiro
        return linhas.sort((a, b) => Number(a.similar) - Number(b.similar) || a.data.localeCompare(b.data));
      }),
      com_saldo: limpos.flatMap((cod) =>
        similaresDe(cod)
          .flatMap((c) => (comSaldo.has(c) ? [comSaldo.get(c)!] : []))
          .sort((a, b) => b.ESTOQUE_DISPONIVEL - a.ESTOQUE_DISPONIVEL)
          .map((p) => ({ pro_codigo: cod, similar_codigo: p.PRO_CODIGO, descricao: p.PRO_DESCRICAO, estoque_disponivel: p.ESTOQUE_DISPONIVEL })),
      ),
    };
  }

  /* --------------------------------------------------------------- bolsa */

  /**
   * A bolsa de desconto do vendedor no mês comissional: o que a venda gerou
   * acima do piso (receita − custo × piso), o que já foi gasto em desconto, o
   * que ainda cabe — e, com o orçamento em edição, como fica depois. Também o
   * lucro acima da linha dos 4% (base do prêmio) e o rateio por cliente.
   */
  async bolsa(
    rep: number,
    orc?: {
      receita: number; desconto: number; custo: number; sem_custo: number; m1a?: number; m1b?: number; m1c?: number; m1d?: number; m23?: number;
      /** promoção: o que a empresa absorve neste orçamento — já somado pela tela, ou as linhas para somar aqui com o piso */
      absorvido?: number; promos?: Array<{ preco: number; custo: number | null; qtd: number }>;
    },
  ) {
    const p = this.parametros();
    const periodo = mesComissional();
    // o piso entra na leitura do mês (metade da promoção) — por isso vem antes; serviços ficam fora da bolsa
    const [{ piso, linha, pisoDre, degrau, vol }, servicos] = await Promise.all([
      this.pisoVigente(periodo),
      this.erp.codigosDeServico().catch((e) => {
        this.logger.warn(`Serviços do ERP indisponíveis (ficam na bolsa): ${(e as Error).message}`);
        return [] as number[];
      }),
    ]);
    const [v, clientes, celulas, cfgComissao] = await Promise.all([
      this.bi.bolsaVendedor(rep, periodo.ano, periodo.mes, piso, servicos),
      this.bi.bolsaPorCliente(rep, periodo.ano, periodo.mes).catch((e) => {
        this.logger.warn(`Bolsa por cliente indisponível (rep ${rep}): ${(e as Error).message}`);
        return [];
      }),
      this.bi.celulasComissao(rep, periodo.ano, periodo.mes).catch((e) => {
        this.logger.warn(`Células da comissão indisponíveis (rep ${rep}): ${(e as Error).message}`);
        return null;
      }),
      this.bi.parametrosComissao().catch((e) => {
        this.logger.warn(`Parâmetros da comissão indisponíveis: ${(e as Error).message}`);
        return null;
      }),
    ]);
    // promoção: metade do que o item tira da bolsa é da empresa — no mês vem do BI (flag PROMOCAO da venda); aqui, o orçamento em edição
    const absorvidoOrc = orc?.absorvido ?? (orc?.promos ? orc.promos.reduce((s, x) => s + absorcaoPromocao(x.preco, x.custo, piso, x.qtd), 0) : 0);
    // Comissão do mês como está e como fica com o orçamento (mesma regra do fechamento;
    // sem abatimentos manuais e média de férias — é estimativa para decidir na hora).
    const comissao = celulas && cfgComissao ? comissaoComOrcamento(celulas, celulasDoOrcamento(orc ?? {}), cfgComissao) : null;
    const bolsa = calcularBolsa({
      receita_mtd: v.venda_liquida,
      custo_mtd: v.custo,
      desconto_mtd: v.desconto,
      receita_orc: orc?.receita ?? 0,
      desconto_orc: orc?.desconto ?? 0,
      custo_orc: orc?.custo ?? 0,
      sem_custo_orc: orc?.sem_custo ?? 0,
      absorvido_mtd: v.absorvido,
      absorvido_orc: absorvidoOrc,
      piso,
      linha,
      premio_pct: p.premio_pct,
    });
    const part = v.venda_liquida > 0 ? v.mix1_liquido / v.venda_liquida : 0;
    const abertos = await this.db.abertosDoVendedor(rep);
    // Se todos os enviados fecharem, é isto que entra na bolsa (item sem custo é neutro).
    let saldoAbertos = 0;
    for (const o of abertos) {
      for (const i of o.itens ?? []) {
        const total = Number(i.total), custo = i.custo_ref != null ? Number(i.custo_ref) : null;
        saldoAbertos += custo != null && custo > 0 ? total - custo * Number(i.quantidade) * piso : 0;
      }
    }
    const porCliente = clientes
      .map((c) => ({
        cli_codigo: c.cli_codigo,
        cli_nome: c.cli_nome,
        venda_liquida: round2(c.venda_liquida),
        desconto: round2(c.desconto),
        saldo: round2(c.venda_liquida - c.custo * piso),
      }))
      .sort((a, b) => b.saldo - a.saldo);
    return {
      periodo,
      notas: v.notas,
      venda_liquida: round2(v.venda_liquida),
      bolsa,
      mix1: { ...degrauMix1(part), venda_mix1: round2(v.mix1_liquido) },
      em_aberto: {
        quantidade: abertos.length,
        total: round2(abertos.reduce((s, o) => s + Number(o.total), 0)),
        desconto: round2(abertos.reduce((s, o) => s + Number(o.desconto_total), 0)),
        saldo_se_fechar_tudo: round2(bolsa.saldo + saldoAbertos),
      },
      por_cliente: porCliente,
      comissao,
      // De onde veio o piso: o degrau do canal (e quanto falta para o próximo) ou o valor fixo.
      volume: pisoDre
        ? { modo: 'dre' as const, ...pisoDre }
        : degrau && vol
        ? {
            modo: 'degrau' as const,
            media_3m: round2(vol.media_mes),
            meses: vol.meses.map((m) => ({ ...m, receita: round2(m.receita) })),
            piso: degrau.piso,
            degrau_min: degrau.degrau_min,
            proximo_min: degrau.proximo_min,
            proximo_piso: degrau.proximo_piso,
            falta: degrau.falta,
          }
        : { modo: 'fixo' as const, piso, linha },
    };
  }

  /**
   * Piso da bolsa em vigor: pela DRE (custo + fixas + variáveis reais → 4%), pelo
   * degrau de volume do canal, ou fixo. Nos modos dre/degrau a linha dos 4% é o
   * próprio piso: saldo retido = lucro a mais.
   */
  private async pisoVigente(periodo: { ano: number; mes: number }) {
    const p = this.parametros();
    const [vol, dre] = await Promise.all([
      p.bolsa_modo === 'degrau' ? this.bi.volumeCanal3m(periodo.ano, periodo.mes) : Promise.resolve(null),
      p.bolsa_modo === 'dre'
        ? this.bi.dreCanalMensal(p.bolsa_dre_meses).catch((e) => {
            this.logger.warn(`DRE do canal indisponível — piso cai para o fixo: ${(e as Error).message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    const pisoDre = dre ? pisoPorDre(dre, p.bolsa_dre_meses, p.meta_resultado) : null;
    const degrau = vol ? pisoPorVolume(p.bolsa_degraus, vol.media_mes) : null;
    const piso = pisoDre ? pisoDre.piso : degrau ? degrau.piso : p.bolsa_piso;
    const linha = pisoDre || degrau || !(p.linha_4pct > 0) ? piso : p.linha_4pct;
    return { piso, linha, pisoDre, degrau, vol };
  }

  /**
   * Bolsa que UM cliente gerou para o vendedor nos `n` meses comissionais fechados
   * antes do atual (mais recente primeiro), com o total. Mês sem venda sai zerado,
   * para a relação ter sempre `n` linhas.
   *
   * ponytail: todos os meses usam o piso de HOJE — o piso de cada mês passado
   * dependeria da DRE/volume daquela data, que a leitura atual não reconstrói.
   * Serve para comparar o cliente mês a mês; não é o valor apurado no fechamento.
   * Se precisar do apurado, calcular o piso por mês a partir de dreCanalMensal.
   */
  async bolsaCliente(rep: number, cli: number, n = 6) {
    const meses = Math.min(12, Math.max(1, Math.trunc(n) || 6));
    const periodo = mesComissional();
    const chaves = mesesAnteriores(periodo.ano, periodo.mes, meses);
    const [rows, { piso }] = await Promise.all([
      this.bi.bolsaClienteMensal(rep, cli, chaves[chaves.length - 1], chaves[0]),
      this.pisoVigente(periodo),
    ]);
    const linhas = chaves.map(({ ano, mes }) => {
      const r = rows.find((x) => x.ano === ano && x.mes === mes);
      const venda = r?.venda_liquida ?? 0, custo = r?.custo ?? 0;
      return {
        ano,
        mes,
        venda_liquida: round2(venda),
        desconto: round2(r?.desconto ?? 0),
        saldo: round2(venda - custo * piso),
      };
    });
    return {
      piso,
      meses: linhas,
      total: round2(linhas.reduce((s, l) => s + l.saldo, 0)),
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
    // Serviço (subtipo 09) não traz preço de tabela: o vendedor informa o valor no orçamento.
    const tabela = ehServico(p.SUBTIPO) ? { coluna: colunaTabela(tabelaPreco), preco: 0, fallback: false } : precoDaTabela(p as unknown as Record<string, unknown>, tabelaPreco);
    // Item em promoção vigente na tabela do cliente: o preço É o promocional e
    // não há desconto por cima dele — o mínimo é o próprio preço. Cliente fora do
    // atacado é varejo: sem preço na tabela dele, a promoção do balcão VALE.
    const precoPromo = promo == null ? null : promo.valor ?? (!ehTabelaAtacado(tabelaPreco) ? promo.valor_balcao : null);
    const aplica = precoPromo != null;
    const preco = aplica ? { coluna: 'PROMOCAO', preco: precoPromo as number, fallback: false } : tabela;
    const custo = p.PRECO_CUSTO > 0 ? p.PRECO_CUSTO : null;
    // Avaliação da régua sobre a tabela NORMAL do cliente: é a que vale sem
    // promoção e a que volta quando o vendedor escolhe vender fora dela.
    const avaliacaoNormal = avaliarItem({
      custo,
      preco_tabela: tabela.preco,
      subgrp_codigo: p.SUBGRP_CODIGO,
      descricao: p.PRO_DESCRICAO,
      excecao,
      regua,
      volume,
      piso_item: this.parametros().piso_item,
    });
    let avaliacao = avaliacaoNormal;
    if (aplica && promo) {
      const fim = promo.data_final.split('-').reverse().join('/');
      avaliacao = {
        ...avaliacaoNormal,
        desc_max_pct: 0,
        desc_max_efetivo_pct: 0,
        preco_minimo: precoPromo as number,
        fracao_volume: 0,
        escala_volume: avaliacao.escala_volume.map((d) => ({ ...d, desc_max_pct: 0, desc_max_efetivo_pct: 0, preco_minimo: precoPromo as number })),
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
      servico: ehServico(p.SUBTIPO),
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
      sem_promocao: aplica ? { preco_tabela: tabela.preco, tabela_coluna: tabela.coluna, preco_fallback: tabela.fallback, avaliacao: avaliacaoNormal } : null,
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

  /**
   * Sugestões PARA ESTE CLIENTE (analytics-atacado-service): reposição vencendo, item
   * que ele parou de comprar, item orçado e não comprado, o que clientes de mix parecido
   * compram. O analytics diz O QUE e POR QUÊ; preço, promoção e saldo são daqui. Item
   * sem saldo é trocado pelo equivalente com saldo (o cliente troca de marca, não de
   * peça); sem equivalente, sai — sugestão que não pode ser atendida atrapalha.
   * Analytics fora = lista vazia, e a tela fica só com o "vendem juntos".
   */
  async sugestoesCliente(cli: number, tabelaPreco: string | null, naGrade: number[]) {
    const excluir = naGrade.filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
    const sugestoes = await analyticsAtacadoGet<
      { pro_codigo: number; chave_item: string; tipo: string; motivo: string; score: number }[]
    >(`/clientes/${cli}/sugestoes?limite=15&excluir=${excluir.join(',')}`);
    if (!sugestoes?.length) return [];

    const lista = await this.produtosPorCodigo(sugestoes.map((s) => s.pro_codigo), tabelaPreco, cli);
    const porCodigo = new Map(lista.map((p) => [p.pro_codigo, p]));
    const naTela = new Set(excluir);
    const out: Array<(typeof lista)[number] & { tipo: string; motivo: string; score: number; pro_codigo_sugerido: number }> = [];
    for (const s of sugestoes) {
      let p = porCodigo.get(s.pro_codigo);
      if (!p || p.inativo || p.estoque_disponivel <= 0) {
        const eq = await this.equivalentes(s.pro_codigo, tabelaPreco, cli).catch(() => []);
        p = eq.find((e) => e.estoque_disponivel > 0 && !naTela.has(e.pro_codigo));
      }
      if (!p || naTela.has(p.pro_codigo)) continue;
      naTela.add(p.pro_codigo);
      out.push({ ...p, tipo: s.tipo, motivo: s.motivo, score: s.score, pro_codigo_sugerido: s.pro_codigo });
      if (out.length >= 8) break;
    }
    return out;
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

  async listar(f: { rep_codigo?: number; cli_codigo?: number; status?: string; page?: number; pageSize?: number }) {
    const r = await this.db.listar(f);
    return { ...r, itens: await this.comRepNome(r.itens) };
  }

  async obter(id: string) {
    const o = await this.db.obter(id);
    if (!o) throw new NotFoundException('Orçamento não encontrado.');
    return (await this.comRepNome([o]))[0];
  }

  /**
   * Orçamento gravado sem o nome do vendedor (a tela só manda o código) sai com
   * o nome resolvido no ERP na leitura; o registro não é alterado.
   */
  private async comRepNome<T extends { rep_codigo: number | null; rep_nome: string | null }>(rows: T[]): Promise<T[]> {
    if (!rows.some((o) => !o.rep_nome && o.rep_codigo != null)) return rows;
    let reps = new Map<number, string>();
    try {
      reps = await this.erp.representantes();
    } catch (e) {
      this.logger.warn(`nome dos representantes indisponível: ${(e as Error).message}`);
    }
    return rows.map((o) => (!o.rep_nome && o.rep_codigo != null ? { ...o, rep_nome: reps.get(o.rep_codigo) ?? null } : o));
  }

  /**
   * Monta os itens com dados AO VIVO: preço de tabela, custo e saldo vêm do ERP
   * na hora de salvar — o que a tela mostrou pode ter mudado. O preço negociado
   * é do vendedor; o resto é fotografia.
   */
  private async montarItens(itens: ItemOrcamentoDto[], cliente: ClienteErp, presencial = false) {
    if (!itens.length) throw new BadRequestException('Orçamento sem itens.');
    const tabelaPreco = cliente.TABELA_PRECO, cli = cliente.CLI_CODIGO;
    const produtos = await this.produtosPorCodigo(itens.map((i) => i.pro_codigo), tabelaPreco, cli);
    const porCodigo = new Map(produtos.map((p) => [p.pro_codigo, p]));
    const erros: string[] = [];
    const linhas: Prisma.ven_orcamento_itemUncheckedCreateInput[] = [];
    // Insumos da alçada de cada linha; a decisão fica para depois de conhecer a bolsa (aplicarAlcada).
    const alcadas: Array<{ preco: number; minimo_qtd: number; minimo_cheio: number; piso_bolsa: number; desc_max_qtd: number; desc_max_cheio: number }> = [];
    let subtotal = 0, total = 0, custoOrc = 0, semCusto = 0, servicos = 0;
    // linhas em promoção (preço fechado da campanha): a bolsa absorve só metade da falta contra o piso
    const promos: Array<{ preco: number; custo: number | null; qtd: number }> = [];

    itens.forEach((i, idx) => {
      const p = porCodigo.get(i.pro_codigo);
      if (!p) { erros.push(`Item ${idx + 1}: produto ${i.pro_codigo} não existe na empresa 3.`); return; }
      const qtd = Number(i.quantidade);
      // Vender FORA da promoção/liquidação: tabela normal do cliente e régua
      // padrão na linha (desconto, alçada e bolsa como em qualquer item).
      const fora = !!i.fora_promocao && !!p.promocao && !!p.sem_promocao;
      const tabela = fora ? p.sem_promocao!.preco_tabela : p.preco_tabela;
      const av = fora ? p.sem_promocao!.avaliacao : p.avaliacao;
      // O preço nasce da tabela do cliente menos o desconto. `preco_unit` vale por
      // cima quando o vendedor fechou o unitário ou o TOTAL da linha: um unitário exato
      // em centavos. Abaixo da tabela é desconto (a régua e a bolsa avaliam esse preço);
      // acima é acréscimo — desconto zero e a diferença gravada em `acrescimo`.
      const descPedido = Math.min(1, Math.max(0, Number(i.desc_pct ?? 0)));
      const unitFechado = Number(i.preco_unit ?? 0);
      let preco =
        tabela > 0
          ? unitFechado > 0
            ? round2(unitFechado)
            : round2(tabela * (1 - descPedido))
          : round2(unitFechado);
      if (!(preco > 0)) {
        erros.push(`Item ${idx + 1} (${p.descricao}): sem preço de tabela — informe o preço.`);
        return;
      }
      if (p.custo != null && preco < p.custo) {
        erros.push(`Item ${idx + 1} (${p.descricao}): preço ${preco.toFixed(2)} abaixo do custo — não permitido.`);
        return;
      }
      const descPct = tabela > 0 ? Math.max(0, Math.round((1 - preco / tabela) * 10000) / 10000) : 0;
      // Dois limites por linha: o desta quantidade (escala por volume) e o máximo
      // inteiro da faixa. Qual vale depende da bolsa — decidido em aplicarAlcada().
      const escala = av.escala_volume;
      const degrau = [...escala].reverse().find((d) => qtd >= d.qtd_min) ?? escala[0];
      const cheio = escala[escala.length - 1];
      const minimo = degrau?.preco_minimo ?? av.preco_minimo;
      const descMaxQtd = degrau?.desc_max_efetivo_pct ?? av.desc_max_efetivo_pct;
      alcadas.push({
        preco,
        minimo_qtd: minimo,
        minimo_cheio: cheio?.preco_minimo ?? av.preco_minimo,
        piso_bolsa: av.preco_piso_bolsa ?? 0,
        desc_max_qtd: descMaxQtd,
        desc_max_cheio: cheio?.desc_max_efetivo_pct ?? av.desc_max_efetivo_pct,
      });
      const linhaTotal = round2(preco * qtd);
      // serviço não conta para a bolsa (nem como neutro): a bolsa é de mercadoria
      if (p.servico) servicos += linhaTotal; // fora da bolsa (nem como neutro): a bolsa é de mercadoria
      else if (p.custo != null && p.custo > 0) custoOrc += p.custo * qtd;
      else semCusto += linhaTotal;
      if (!fora && p.promocao) promos.push({ preco, custo: p.custo, qtd });
      // linha com acréscimo entra no subtotal pelo próprio preço: o acréscimo não abate o desconto das outras
      subtotal += round2(Math.max(tabela, preco) * qtd);
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
        tabela_coluna: fora ? p.sem_promocao!.tabela_coluna : p.tabela_coluna,
        preco_unit: preco,
        desc_pct: descPct,
        total: linhaTotal,
        // R$ cobrados acima da tabela na linha inteira; só no banco (relatório), nenhuma tela mostra
        acrescimo: tabela > 0 && preco > tabela ? round2((preco - tabela) * qtd) : 0,
        custo_ref: p.custo,
        classe: av.classe,
        mix: av.mix,
        faixa: av.faixa,
        markup_regua: av.markup_regua,
        desc_max_pct: descMaxQtd,
        preco_minimo: minimo,
        acima_alcada: false, // fechado em aplicarAlcada()
        estoque_disponivel: p.estoque_disponivel,
        substituto_de: i.substituto_de ?? null,
        observacao: i.observacao ?? null,
        promocao_codigo: fora ? null : (p.promocao?.codigo ?? null),
        promocao_fim: !fora && p.promocao ? new Date(`${p.promocao.data_final}T00:00:00`) : null,
        // parte sem saldo que o cliente aceitou receber depois (decidida ao concluir)
        qtd_encomenda: Math.min(qtd, Math.max(0, Number(i.qtd_encomenda ?? 0))),
        fora_promocao: fora,
        icms_st: 0,
        difal: 0,
        difal_pct: null,
      });
    });
    if (erros.length) throw new BadRequestException(erros);
    subtotal = round2(subtotal); total = round2(total);
    const desconto = round2(subtotal - total);
    // imposto da venda para fora do estado, por linha (serviço fica fora do ICMS)
    const trib = await this.tributar(
      linhas.map((l) => ({ pro_codigo: Number(l.pro_codigo), total: Number(l.total), servico: !!porCodigo.get(Number(l.pro_codigo))?.servico })),
      cliente,
      presencial,
    );
    linhas.forEach((l, i) => { l.icms_st = trib.itens[i].icms_st; l.difal = trib.itens[i].difal; l.difal_pct = trib.itens[i].difal_pct; });
    return {
      linhas,
      subtotal,
      total,
      desconto_total: desconto,
      desc_pct: subtotal > 0 ? Math.round((desconto / subtotal) * 10000) / 10000 : 0,
      alcadas,
      custo: round2(custoOrc),
      sem_custo: round2(semCusto),
      servicos: round2(servicos),
      promos,
      produtos,
      tributacao: trib.resumo,
      icms_st: trib.icms_st,
      difal: trib.difal,
      sem_aliquota: trib.sem_aliquota,
    };
  }

  /**
   * ICMS da venda para fora do estado, linha a linha, como a nota vai sair:
   * ST (contribuinte) ou DIFAL (não contribuinte/isento, venda não presencial), os
   * dois somados ao total ao cliente — o DIFAL vai como despesa acessória, por acordo
   * com os clientes do atacado. MVA, alíquotas e percentual do DIFAL por produto
   * vêm do Celta na hora; produto sem alíquota de DIFAL cadastrada fica com zero e
   * `difal_pct` nulo — a lista `sem_aliquota` é o aviso para o fiscal cadastrar.
   */
  private async tributar(itens: Array<{ pro_codigo: number; total: number; servico: boolean }>, cliente: { UF: string | null; INDICADOR_IE_DESTINATARIO: number | null }, presencial: boolean) {
    const resumo = this.resumoTributacao(cliente, presencial);
    const zero = itens.map(() => ({ icms_st: 0, difal: 0, difal_pct: null as number | null }));
    const base = { resumo, itens: zero, icms_st: 0, difal: 0, sem_aliquota: [] as number[] };
    if (resumo.regime === 'ST') {
      const st: ParametrosSt | null = await this.erp.situacaoTributariaSt(this.parametros().st_situacao);
      if (!st) throw new BadRequestException(`Situação tributária ${this.parametros().st_situacao} do ICMS-ST não encontrada (ou inativa) no Celta.`);
      const linhas = itens.map((i) => ({ icms_st: i.servico ? 0 : calcularSt(i.total, st), difal: 0, difal_pct: null }));
      return { ...base, itens: linhas, icms_st: round2(linhas.reduce((s, l) => s + l.icms_st, 0)) };
    }
    if (resumo.regime === 'DIFAL') {
      const aliq = await this.erp.aliquotasDifal(itens.filter((i) => !i.servico).map((i) => i.pro_codigo), resumo.uf as string);
      const semAliquota: number[] = [];
      const linhas = itens.map((i) => {
        if (i.servico) return { icms_st: 0, difal: 0, difal_pct: null };
        const a = aliq.get(i.pro_codigo);
        if (a == null) { semAliquota.push(i.pro_codigo); return { icms_st: 0, difal: 0, difal_pct: null }; }
        return { icms_st: 0, difal: calcularDifal(i.total, a), difal_pct: a };
      });
      return { ...base, itens: linhas, difal: round2(linhas.reduce((s, l) => s + l.difal, 0)), sem_aliquota: [...new Set(semAliquota)] };
    }
    return base;
  }

  /** Prévia para a tela: o mesmo cálculo de `montarItens`, sem régua, sem bolsa e sem gravar. */
  async tributacaoPrevia(dto: TributacaoDto) {
    const cliente = await this.erp.clientePorCodigo(dto.cli_codigo);
    if (!cliente) throw new NotFoundException(`Cliente ${dto.cli_codigo} não encontrado no ERP.`);
    const t = await this.tributar(dto.itens.map((i) => ({ pro_codigo: i.pro_codigo, total: Number(i.total), servico: !!i.servico })), cliente, !!dto.presencial);
    return {
      ...t.resumo,
      icms_st: t.icms_st,
      difal: t.difal,
      sem_aliquota: t.sem_aliquota,
      itens: dto.itens.map((i, k) => ({ pro_codigo: i.pro_codigo, ...t.itens[k] })),
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

  /**
   * Fotografia da bolsa ao salvar: % de desconto do mês antes/depois (colunas
   * bolsa_pct_*) e o saldo depois deste orçamento — quem decide a alçada.
   */
  private async bolsaSnapshot(rep: number, m: { subtotal: number; total: number; desconto_total: number; custo: number; sem_custo: number; servicos?: number; promos?: Array<{ preco: number; custo: number | null; qtd: number }> }) {
    try {
      const b = await this.bolsa(rep, { receita: m.total - (m.servicos ?? 0), desconto: m.desconto_total, custo: m.custo, sem_custo: m.sem_custo, promos: m.promos });
      const brutoDepois = b.bolsa.bruto_mtd + m.subtotal;
      return {
        antes: b.bolsa.pct_desconto,
        depois: brutoDepois > 0 ? Math.round(((b.bolsa.desconto_mtd + m.desconto_total) / brutoDepois) * 10000) / 10000 : 0,
        saldo_apos: b.bolsa.saldo_apos as number | null,
        // o orçamento sozinho fecha ≥ 0 contra custo × piso: se compensa, ninguém vai ao gestor
        compensa: b.bolsa.orcamento >= -0.005,
      };
    } catch (e) {
      this.logger.warn(`Bolsa indisponível ao salvar (rep ${rep}): ${(e as Error).message}`);
      return { antes: null, depois: null, saldo_apos: null, compensa: false };
    }
  }

  /**
   * Fecha a alçada de cada linha depois de conhecer a bolsa: com saldo (já com
   * este orçamento) ≥ 0 vale o máximo inteiro da faixa; sem saldo vale a escala
   * por quantidade. Grava na linha o limite que valeu (desc_max_pct / preco_minimo)
   * e devolve se o orçamento precisa do gestor (alguma linha abaixo do limite em
   * vigor ou do piso absoluto). Orçamento que se compensa sozinho (`compensa`) não
   * precisa: o que um item perde outro paga, e o resultado contra o piso é ≥ 0.
   */
  private aplicarAlcada(
    m: { linhas: Prisma.ven_orcamento_itemUncheckedCreateInput[]; alcadas: Array<{ preco: number; minimo_qtd: number; minimo_cheio: number; piso_bolsa: number; desc_max_qtd: number; desc_max_cheio: number }> },
    saldoApos: number | null,
    compensa = false,
  ) {
    let precisa = false;
    m.linhas.forEach((l, i) => {
      const e = m.alcadas[i];
      if (!e) return;
      const a = alcadaDoItem({ preco: e.preco, minimo_qtd: e.minimo_qtd, minimo_cheio: e.minimo_cheio, piso_bolsa: e.piso_bolsa, saldo_apos: saldoApos, compensa });
      l.acima_alcada = a.precisa_aprovacao;
      l.preco_minimo = a.minimo_vigente;
      l.desc_max_pct = a.bolsa_cobre ? e.desc_max_cheio : e.desc_max_qtd;
      precisa = precisa || a.precisa_aprovacao;
    });
    return precisa;
  }

  async criar(dto: SalvarOrcamentoDto) {
    // Mesma trava da tela, garantida aqui: bloqueado no cadastro E com divergência
    // que a gerência não liberou. Os orçamentos existentes seguem editáveis.
    const trava = await this.db.travaDoRep(dto.rep_codigo);
    if (trava.travado) {
      throw new BadRequestException('Criação de orçamento bloqueada para este vendedor: há comparativo divergente com o Celta ainda não liberado pela gerência.');
    }
    const cliente = await this.erp.clientePorCodigo(dto.cli_codigo);
    if (!cliente) throw new BadRequestException(`Cliente ${dto.cli_codigo} não encontrado no ERP.`);
    const m = await this.montarItens(dto.itens, cliente, !!dto.presencial);
    const bolsa = await this.bolsaSnapshot(dto.rep_codigo, m);
    const pag = await this.pagamentoDe(dto);
    return this.db.criar(
      {
        cli_codigo: dto.cli_codigo,
        cli_nome: cliente.CLI_NOME,
        tabela_preco: cliente.TABELA_PRECO,
        rep_codigo: dto.rep_codigo,
        rep_nome: dto.rep_nome || (await this.erp.nomeRepresentante(dto.rep_codigo)),
        status: 'RASCUNHO',
        validade: this.validade(m.linhas),
        observacao: dto.observacao ?? null,
        ...pag,
        subtotal: m.subtotal,
        desconto_total: m.desconto_total,
        total: m.total,
        desc_pct: m.desc_pct,
        acima_alcada: this.aplicarAlcada(m, bolsa.saldo_apos, bolsa.compensa),
        bolsa_pct_antes: bolsa.antes,
        bolsa_pct_depois: bolsa.depois,
        presencial: !!dto.presencial,
        tributacao: m.tributacao.regime,
        icms_st: m.icms_st,
        difal: m.difal,
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
    const m = await this.montarItens(dto.itens, cliente, !!dto.presencial);
    const bolsa = await this.bolsaSnapshot(dto.rep_codigo, m);
    const pag = await this.pagamentoDe(dto);
    // Editar os ITENS de um orçamento já enviado o devolve ao rascunho e derruba a aprovação:
    // o que o cliente recebeu (e o que o gerente liberou) mudou. Salvar sem mexer em produto,
    // quantidade e preço — só pagamento ou observação, como no "Fechou" — mantém os dois.
    const chave = (l: { pro_codigo?: unknown; quantidade?: unknown; preco_unit?: unknown }) =>
      `${Number(l.pro_codigo)}|${Number(l.quantidade)}|${Number(l.preco_unit).toFixed(2)}`;
    const antes = (atual.itens ?? []).map(chave).sort().join(';');
    const depois = m.linhas.map(chave).sort().join(';');
    const mesmosItens = atual.cli_codigo === dto.cli_codigo && antes === depois;
    if (atual.status === 'APROVACAO' && !mesmosItens) this.avisos.aprovacaoEncerrada(id);
    return this.db.atualizar(
      id,
      {
        cli_codigo: dto.cli_codigo,
        cli_nome: cliente.CLI_NOME,
        tabela_preco: cliente.TABELA_PRECO,
        rep_codigo: dto.rep_codigo,
        // Vendedor trocado na edição: o nome gravado antes não serve mais.
        rep_nome: dto.rep_nome || (atual.rep_codigo === dto.rep_codigo && atual.rep_nome) || (await this.erp.nomeRepresentante(dto.rep_codigo)),
        status: mesmosItens ? atual.status : 'RASCUNHO',
        validade: this.validade(m.linhas),
        observacao: dto.observacao ?? null,
        ...pag,
        subtotal: m.subtotal,
        desconto_total: m.desconto_total,
        total: m.total,
        desc_pct: m.desc_pct,
        acima_alcada: this.aplicarAlcada(m, bolsa.saldo_apos, bolsa.compensa),
        bolsa_pct_antes: bolsa.antes,
        bolsa_pct_depois: bolsa.depois,
        presencial: !!dto.presencial,
        tributacao: m.tributacao.regime,
        icms_st: m.icms_st,
        difal: m.difal,
        aprovado_por: mesmosItens ? atual.aprovado_por : null,
        aprovado_em: mesmosItens ? atual.aprovado_em : null,
        enviado_em: mesmosItens ? atual.enviado_em : null,
      },
      m.linhas.map((l) => ({ ...l, orcamento_id: id })),
    );
  }

  /** Enviar = fechar a proposta. Item abaixo do piso, ou bolsa estourada, manda para APROVAÇÃO. */
  async enviar(id: string, usuario?: { usuario_id?: string; usuario_nome?: string }) {
    const o = await this.obter(id);
    if (!['RASCUNHO', 'APROVACAO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento ${o.status} não pode ser enviado.`);
    }
    if (!o.itens?.length) throw new BadRequestException('Orçamento sem itens.');
    // O Celta pede a condição; a forma é opcional (vai a sugerida pela condição ou o padrão do cliente).
    if (o.cp_codigo == null) throw new BadRequestException('Informe a condição de pagamento antes de enviar.');
    // Item sem saldo NÃO trava o envio: a proposta vai ao cliente com o aviso na linha
    // ("sem estoque" / "aguardando liberação"); a decisão de saldo é só no FECHOU (tela).
    const precisaAprovar = o.acima_alcada && !o.aprovado_em;
    const r = await this.db.atualizar(id, {
      status: precisaAprovar ? 'APROVACAO' : 'ENVIADO',
      enviado_em: precisaAprovar ? null : new Date(),
      usuario_id: usuario?.usuario_id ?? o.usuario_id,
      usuario_nome: usuario?.usuario_nome ?? o.usuario_nome,
    });
    // Aviso à gerência só na entrada em APROVAÇÃO (reenviar o que já está lá não repete).
    if (precisaAprovar && o.status !== 'APROVACAO') void this.avisos.orcamentoAprovacao(o);
    return r;
  }

  /** O cliente RECEBEU a proposta (mensagem + PDF pelo WhatsApp da Estação). */
  async entregue(id: string, canal: string) {
    const o = await this.obter(id);
    if (!['ENVIADO', 'FECHADO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento ${o.status}: só proposta ENVIADA pode ser entregue ao cliente.`);
    }
    return this.db.atualizar(id, { entregue_canal: canal, entregue_em: new Date() });
  }

  /**
   * PROPOSTA SEM SALVAR — mesma precificação, alçada e papel do orçamento, mas
   * nada vai ao banco. Serve a quem monta a proposta fora da tela (assistente do
   * WhatsApp) e a encaminha a um vendedor, que a registra e segue com a venda.
   * Devolve o texto do WhatsApp, o PDF em base64 e o que exigiria aprovação.
   */
  async proposta(dto: SalvarOrcamentoDto) {
    const cliente = await this.erp.clientePorCodigo(dto.cli_codigo);
    if (!cliente) throw new BadRequestException(`Cliente ${dto.cli_codigo} não encontrado no ERP.`);
    const m = await this.montarItens(dto.itens, cliente, !!dto.presencial);
    const bolsa = await this.bolsaSnapshot(dto.rep_codigo, m);
    const acimaAlcada = this.aplicarAlcada(m, bolsa.saldo_apos, bolsa.compensa);
    const [pag, cli, repNome] = await Promise.all([
      this.pagamentoDe(dto),
      this.erp.clienteParaPdf(dto.cli_codigo).catch(() => null),
      dto.rep_nome ? Promise.resolve(dto.rep_nome) : this.erp.nomeRepresentante(dto.rep_codigo),
    ]);
    const porCodigo = new Map(m.produtos.map((p) => [p.pro_codigo, p]));
    const n = (v: unknown) => Number(v ?? 0);
    const itens: PdfItem[] = m.linhas.map((l) => {
      const p = porCodigo.get(Number(l.pro_codigo));
      const promoFim = dmy(l.promocao_fim as Date | null);
      const qtd = n(l.quantidade);
      const enc = n(l.qtd_encomenda);
      return {
        pro_codigo: Number(l.pro_codigo),
        descricao: String(l.descricao ?? ''),
        marca: p?.marca ?? null,
        unidade: String(l.unidade ?? 'UN'),
        quantidade: qtd,
        preco_tabela: n(l.preco_tabela),
        desc_pct: n(l.desc_pct),
        preco_unit: n(l.preco_unit),
        total: n(l.total),
        promocao_fim: promoFim,
        preco_original: promoFim && p && p.preco_original > n(l.preco_tabela) ? p.preco_original : null,
        qtd_encomenda: enc,
        ...faltaSaldo(qtd - enc, p?.servico ? Number.POSITIVE_INFINITY : p?.estoque_disponivel, 0),
      };
    });
    const dados: PdfOrcamento = {
      numero: 'PRÉVIA',
      emissao: dmy(hojeYmd()) ?? '',
      validade: dmy(this.validade(m.linhas)),
      vendedor: `${repNome} (${dto.rep_codigo})`,
      cliente: this.clientePdf(cli, dto.cli_codigo, cliente.CLI_NOME, cliente.TABELA_PRECO),
      itens,
      subtotal: m.subtotal,
      desconto: m.desconto_total,
      desc_pct: m.desc_pct,
      total: m.total,
      icms_st: m.icms_st,
      difal: m.difal,
      uf_trib: m.icms_st > 0 || m.difal > 0 ? m.tributacao.uf : null,
      observacao: dto.observacao ?? null,
      pagamento: [pag.cp_descricao, pag.fp_descricao].filter(Boolean).join(' · ') || null,
    };
    const pdf = await gerarPdfOrcamento(dados);
    return {
      texto: mensagemWhatsapp(dados),
      tributacao: { ...m.tributacao, icms_st: m.icms_st, difal: m.difal, sem_aliquota: m.sem_aliquota },
      acima_alcada: acimaAlcada,
      itens_acima_alcada: m.linhas.filter((l) => l.acima_alcada).map((l) => ({ pro_codigo: l.pro_codigo, descricao: l.descricao, preco_unit: l.preco_unit, preco_minimo: l.preco_minimo })),
      bolsa: { pct_antes: bolsa.antes, pct_depois: bolsa.depois, saldo_apos: bolsa.saldo_apos },
      subtotal: m.subtotal,
      desconto: m.desconto_total,
      total: m.total,
      validade: dados.validade,
      arquivo: { nome: `proposta-${dto.cli_codigo}-${hojeYmd()}.pdf`, mime: 'application/pdf', base64: pdf.toString('base64') },
    };
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

  /** `modo` = como o desconto aparece no papel: por item (padrão) ou uma vez, no total. */
  async pdf(id: string, modo?: string): Promise<{ nome: string; dados: Buffer }> {
    const dados = await this.dadosImpressao(id);
    const m: ModoDesconto = modo === 'geral' ? 'geral' : 'item';
    return { nome: `orcamento-${dados.numero}.pdf`, dados: await gerarPdfOrcamento({ ...dados, modo: m }) };
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
    const { aguardando } = produtos.length ? await this.saldoComLiberacao(produtos.map((p) => p.pro_codigo), produtos) : { aguardando: () => 0 };
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
        qtd_encomenda: n(i.qtd_encomenda),
        ...faltaSaldo(n(i.quantidade) - n(i.qtd_encomenda), p?.servico ? Number.POSITIVE_INFINITY : p?.estoque_disponivel, aguardando(Number(i.pro_codigo))),
      };
    });
    const numero = String(o.numero).padStart(6, '0');
    return {
      numero,
      emissao: dmy(o.created_at) ?? '',
      validade: dmy(o.validade),
      vendedor: o.rep_nome ? `${o.rep_nome}${o.rep_codigo != null ? ` (${o.rep_codigo})` : ''}` : o.rep_codigo != null ? String(o.rep_codigo) : '—',
      cliente: this.clientePdf(cli, o.cli_codigo, o.cli_nome, o.tabela_preco),
      itens: linhas,
      subtotal: n(o.subtotal),
      desconto: n(o.desconto_total),
      desc_pct: n(o.desc_pct),
      total: n(o.total),
      icms_st: n(o.icms_st),
      difal: n(o.difal),
      uf_trib: n(o.icms_st) > 0 || n(o.difal) > 0 ? cli?.UF ?? null : null,
      observacao: o.observacao ?? null,
      pagamento: [o.cp_descricao, o.fp_descricao].filter(Boolean).join(' · ') || null,
    };
  }

  /** Bloco do cliente no papel: cadastro do ERP (pode faltar) + nome/tabela do orçamento. */
  private clientePdf(cli: Awaited<ReturnType<OrcamentoErpRepository['clienteParaPdf']>> | null, codigo: number, nome: unknown, tabela: string | null | undefined): PdfOrcamento['cliente'] {
    const endereco = cli ? [cli.ENDERECO, cli.NUMERO].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(', ') : null;
    return {
      codigo,
      nome: String(nome ?? cli?.CLI_NOME ?? ''),
      cpf_cnpj: cli?.CPF_CNPJ ?? null,
      rg_ie: cli?.RG_IE ? String(cli.RG_IE).trim() || null : null,
      fone: [cli?.FONE, cli?.CELULAR].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join(' ') || null,
      endereco: endereco || null,
      bairro: cli?.BAIRRO ? String(cli.BAIRRO).trim() : null,
      cep: cli?.CEP ? String(cli.CEP).trim() : null,
      cidade: cli?.CIDADE ?? null,
      uf: cli?.UF ?? null,
      tabela_nome: nomeTabelaCliente(tabela),
    };
  }

  /** Supervisor libera o que está abaixo do mínimo; o orçamento segue como ENVIADO. */
  async aprovar(id: string, usuario?: { usuario_id?: string; usuario_nome?: string }) {
    const o = await this.obter(id);
    if (o.status !== 'APROVACAO') throw new BadRequestException('Só orçamento em APROVAÇÃO pode ser aprovado.');
    const r = await this.db.atualizar(id, {
      status: 'ENVIADO',
      aprovado_por: usuario?.usuario_nome ?? usuario?.usuario_id ?? 'supervisor',
      aprovado_em: new Date(),
      enviado_em: new Date(),
    });
    this.avisos.aprovacaoEncerrada(id);
    return r;
  }

  async desfecho(id: string, dto: DesfechoOrcamentoDto) {
    const o = await this.obter(id);
    if (['FECHADO', 'PERDIDO', 'CANCELADO'].includes(o.status)) {
      throw new BadRequestException(`Orçamento já está ${o.status}.`);
    }
    if (dto.resultado === 'PERDIDO' && !dto.motivo) throw new BadRequestException('Informe o motivo da perda.');
    if (o.status === 'APROVACAO') this.avisos.aprovacaoEncerrada(id);
    return this.db.atualizar(id, {
      status: dto.resultado,
      desfecho_em: new Date(),
      desfecho_motivo: dto.resultado === 'PERDIDO' ? dto.motivo : null,
      desfecho_ref: dto.referencia ?? null,
      observacao: dto.observacao ? `${o.observacao ? o.observacao + '\n' : ''}${dto.observacao}` : o.observacao,
    });
  }

  /**
   * Manda o orçamento FECHADO ao Celta pela api-vendas-service e guarda o nº gerado.
   * Já importado → devolve o nº guardado sem chamar a API. A chave de idempotência
   * é por orçamento: uma falha de rede depois da gravação não duplica no ERP.
   */
  async importarCelta(id: string) {
    const o = await this.obter(id);
    if (o.celta_orcamento) return { orcamento: o, celta_orcamento: o.celta_orcamento, repetido: true };
    if (o.status !== 'FECHADO') throw new BadRequestException('Só orçamento fechado vai ao Celta.');
    if (!o.rep_codigo) throw new BadRequestException('Orçamento sem vendedor não pode ir ao Celta.');
    // piso da bolsa de hoje: a observação diz quanto o orçamento se compensou contra ele
    const piso = await this.pisoVigente(mesComissional()).then((x) => x.piso).catch(() => this.parametros().bolsa_piso);
    let corpo;
    try {
      corpo = corpoParaCelta({ ...o, piso_bolsa: piso }, this.parametros().celta_tributacao);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const r = await this.celta.criar(o.empresa, corpo, chaveIdempotencia(o));
    const salvo = await this.db.atualizar(id, {
      celta_orcamento: r.orcamento,
      celta_importado_em: new Date(),
      desfecho_ref: o.desfecho_ref || String(r.orcamento),
    });
    this.logger.log(`Orçamento ${o.numero} importado no Celta como ${r.orcamento}${r.repetido ? ' (repetido)' : ''}.`);
    return { orcamento: salvo, celta_orcamento: r.orcamento, repetido: r.repetido };
  }

  /**
   * Compara o orçamento importado (nº do Celta) com o condicional e a intranet.
   * Tudo batendo (quantidade_sku, quantidade_unitaria, valor e ok) → comparado = true;
   * senão comparado = false e o vendedor fica com orcamentoBloqueado = true.
   * Devolve o comparativo como veio da api-vendas-service.
   */
  async comparar(id: string) {
    const o = await this.obter(id);
    if (!o.celta_orcamento) throw new BadRequestException('Orçamento ainda não foi importado no Celta.');
    const lista = await this.celta.comparativo(o.celta_orcamento);
    const veredito = this.vereditoComparativo(lista, o.empresa);
    // Sem condicional vinculado não há o que comparar: não marca nem bloqueia ninguém.
    if (veredito === 'SEM_CONDICIONAL') return lista;
    const bateu = veredito === 'OK';
    const liberado = o.liberadogerencia === true;
    await this.db.gravarComparacao(id, bateu, o.rep_codigo, liberado);
    if (!bateu && !liberado) {
      this.logger.warn(`Orçamento ${o.numero} (Celta ${o.celta_orcamento}) divergiu no comparativo; vendedor ${o.rep_codigo ?? '-'} bloqueado.`);
      this.avisos.orcamentoBloqueado(o, this.diferencas(lista, o.empresa));
    }
    return lista;
  }

  /**
   * Trava de orçamento NOVO para a tela: `orcamentoBloqueado` do cadastro é só o
   * gatilho; quem decide é `liberadogerencia` dos orçamentos divergentes do rep.
   */
  trava(rep_codigo: number) {
    return this.db.travaDoRep(rep_codigo);
  }
 
  /**
   * Lê o comparativo do Celta (uma linha por empresa; vale a da empresa do orçamento).
   *  - nenhuma linha com `condicional` → SEM_CONDICIONAL (não fazer NADA);
   *  - quantidade_sku, quantidade_unitaria, valor e ok todos true → OK;
   *  - qualquer um false → DIVERGENTE.
   */
  private vereditoComparativo(lista: ComparativoCelta[], empresa: number): 'SEM_CONDICIONAL' | 'OK' | 'DIVERGENTE' {
    const alvo = this.comparadas(lista, empresa);
    if (!alvo.length) return 'SEM_CONDICIONAL';
    const bateu = alvo.every((c) => c.quantidade_sku === true && c.quantidade_unitaria === true && c.valor === true && c.ok === true);
    return bateu ? 'OK' : 'DIVERGENTE';
  }

  /** Linhas do comparativo que valem para o orçamento: a da empresa dele, com condicional. */
  private comparadas(lista: ComparativoCelta[], empresa: number) {
    const daEmpresa = lista.filter((c) => c.empresa === empresa);
    return (daEmpresa.length ? daEmpresa : lista).filter((c) => c.condicional != null);
  }

  /** O que não bateu, em texto, para o aviso da gerência não ter de abrir o comparativo. */
  private diferencas(lista: ComparativoCelta[], empresa: number): string {
    return this.comparadas(lista, empresa).map((c) => diferencasComparativo(c as LinhaComparativo)).join('\n');
  }

  /**
   * Cron do comparativo (30 em 30 s): para cada orçamento com nº do Celta e
   * comparado = false, consulta API_VENDAS_URL/comparativo/:orcamentoCelta.
   *  - condicional null → nada (tenta de novo no próximo ciclo);
   *  - tudo true → comparado = true (sai da fila);
   *  - algum false → orcamentoBloqueado = true no usuário do vendas_rep_codigo.
   * O aviso modal para a gestão só sai quando o bloqueio MUDA de estado: divergência
   * que continua não gera aviso a cada ciclo; se a gestão liberar sem corrigir no
   * Celta, o próximo ciclo bloqueia de novo e avisa uma vez.
   * Falha num orçamento (Celta fora, 404) não derruba os demais.
   */
  async compararPendentes() {
    const r = { avaliados: 0, sem_condicional: 0, comparados: 0, divergentes: 0, bloqueios: 0, falhas: 0 };
    if (!this.celta.configurado()) return r;
    const pendentes = await this.db.pendentesComparacao();
    for (const o of pendentes) {
      if (o.celta_orcamento == null) continue;
      r.avaliados++;
      try {
        const lista = await this.celta.comparativo(o.celta_orcamento);
        const veredito = this.vereditoComparativo(lista, o.empresa);
        if (veredito === 'SEM_CONDICIONAL') {
          r.sem_condicional++;
        } else if (veredito === 'OK') {
          await this.db.marcarComparado(o.id);
          r.comparados++;
          this.logger.log(`Comparativo: orçamento ${o.numero} (Celta ${o.celta_orcamento}) bateu — comparado = true.`);
        } else {
          r.divergentes++;
          // Liberado pela gerência: segue na fila (vira comparado quando o Celta for
          // corrigido), mas não bloqueia o vendedor de novo.
          if (o.liberadogerencia === true) continue;
          // A marca no orçamento é o que trava a criação até a gerência liberar.
          await this.db.marcarDivergente(o.id);
          if (o.rep_codigo == null) continue;
          const mudou = await this.db.bloquearRep(o.rep_codigo);
          if (mudou > 0) {
            r.bloqueios++;
            this.logger.warn(`Comparativo: orçamento ${o.numero} (Celta ${o.celta_orcamento}) divergiu; vendedor ${o.rep_codigo} bloqueado.`);
            this.avisos.orcamentoBloqueado(o, this.diferencas(lista, o.empresa));
          }
        }
      } catch (e) {
        r.falhas++;
        this.logger.warn(`Comparativo do orçamento ${o.numero} (Celta ${o.celta_orcamento}) não pôde ser avaliado: ${(e as Error).message}`);
      }
    }
    return r;
  }

  /** Reabre um FECHADO que ainda não foi ao Celta: volta a ENVIADO (ou RASCUNHO se nunca foi enviado) e limpa o desfecho. */
  async reabrir(id: string) {
    const o = await this.obter(id);
    if (o.status !== 'FECHADO') throw new BadRequestException(`Orçamento ${o.status} não pode ser reaberto.`);
    if (o.celta_orcamento) throw new BadRequestException(`Orçamento já importado no Celta (nº ${o.celta_orcamento}) não pode ser reaberto.`);
    return this.db.atualizar(id, {
      status: o.enviado_em ? 'ENVIADO' : 'RASCUNHO',
      desfecho_em: null,
      desfecho_motivo: null,
      desfecho_ref: null,
    });
  }

  async cancelar(id: string) {
    const o = await this.obter(id);
    if (['FECHADO', 'PERDIDO'].includes(o.status)) throw new BadRequestException(`Orçamento ${o.status} não pode ser cancelado.`);
    if (o.status === 'APROVACAO') this.avisos.aprovacaoEncerrada(id);
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
      if (!p.servico && p.estoque_disponivel < i.quantidade) a.push(`${i.pro_codigo} ${i.descricao}: saldo ${p.estoque_disponivel} < ${i.quantidade} orçados.`);
      if (Math.abs(p.preco_tabela - i.preco_tabela) > 0.005) a.push(`${i.pro_codigo} ${i.descricao}: tabela mudou de ${i.preco_tabela.toFixed(2)} para ${p.preco_tabela.toFixed(2)}.`);
      return a;
    });
    return { orcamento: o, produtos, avisos };
  }

  private async pendenciasDe(o: { itens?: any[]; tabela_preco: string | null; cli_codigo: number }) {
    const itens = (o.itens ?? []) as Array<{ pro_codigo: number; descricao: string | null; quantidade: number; qtd_encomenda?: number | null }>;
    if (!itens.length) return [];
    const produtos = await this.produtosPorCodigo(itens.map((i) => i.pro_codigo), o.tabela_preco, o.cli_codigo);
    const { saldoPor } = await this.saldoComLiberacao(itens.map((i) => i.pro_codigo), produtos);
    return pendenciasSaldo(itens, saldoPor);
  }

  /** Itens sem saldo para a parte a entregar agora (saldo relido do ERP). O que trava o concluir. */
  async saldo(id: string) {
    const o = await this.obter(id);
    return { orcamento_id: id, pendencias: await this.pendenciasDe(o) };
  }

  /**
   * Decisão do vendedor sobre cada item sem saldo: venda perdida (registra e
   * tira a diferença), encomenda (fica no orçamento marcada) ou retirar. Depois
   * regrava o orçamento pelo caminho normal (preços, alçada e bolsa recalculados).
   * Se não sobrar item, não regrava: a tela registra o orçamento como perdido.
   */
  async decidirSaldo(id: string, dto: DecisaoSaldoDto) {
    const o = await this.obter(id);
    if (!STATUS_EDITAVEL.has(o.status)) throw new BadRequestException(`Orçamento ${o.status} não pode ser alterado.`);
    if (o.rep_codigo == null) throw new BadRequestException('Orçamento sem vendedor.');
    const itens = (o.itens ?? []) as Array<{
      pro_codigo: number; descricao: string | null; quantidade: number; qtd_encomenda?: number | null;
      desc_pct: number; preco_tabela: number; preco_unit: number; substituto_de: number | null; observacao: string | null; fora_promocao?: boolean;
    }>;
    const produtos = await this.produtosPorCodigo(itens.map((i) => i.pro_codigo), o.tabela_preco, o.cli_codigo);
    const { saldoPor } = await this.saldoComLiberacao(itens.map((i) => i.pro_codigo), produtos);
    const r = aplicarDecisoes(itens, saldoPor, dto.decisoes);
    if (r.sem_decisao.length) throw new BadRequestException(`Falta decidir o que fazer com: ${r.sem_decisao.join(', ')}.`);
    // Similar com saldo: a tela informa qual era; venda perdida só com justificativa escrita.
    const porCodigo = new Map(dto.decisoes.map((d) => [d.pro_codigo, d]));
    const semJustificativa = r.venda_perdida.filter((v) => porCodigo.get(v.pro_codigo)?.similar_disponivel && !porCodigo.get(v.pro_codigo)?.justificativa?.trim());
    if (semJustificativa.length) {
      throw new BadRequestException(`Há similar com saldo para ${semJustificativa.map((v) => v.pro_codigo).join(', ')}: justifique a venda perdida.`);
    }
    if (r.venda_perdida.length) {
      await this.db.registrarVendaPerdida(
        o,
        r.venda_perdida.map((v) => ({ ...v, similar_disponivel: porCodigo.get(v.pro_codigo)?.similar_disponivel ?? null, justificativa: porCodigo.get(v.pro_codigo)?.justificativa?.trim() || null })),
        dto,
      );
    }
    if (!r.itens.length) return { orcamento: o, sem_itens: true, venda_perdida: r.venda_perdida.length };
    const salvo = await this.atualizar(id, {
      cli_codigo: o.cli_codigo,
      rep_codigo: o.rep_codigo,
      rep_nome: o.rep_nome ?? undefined,
      observacao: o.observacao ?? undefined,
      usuario_id: dto.usuario_id ?? o.usuario_id ?? undefined,
      usuario_nome: dto.usuario_nome ?? o.usuario_nome ?? undefined,
      itens: r.itens.map((i) => ({
        pro_codigo: i.pro_codigo,
        quantidade: i.quantidade,
        desc_pct: i.desc_pct,
        // com tabela o preço renasce do desconto; o acréscimo (unitário acima da tabela) é mantido
        preco_unit: i.preco_tabela > 0 && i.preco_unit <= i.preco_tabela ? undefined : i.preco_unit,
        substituto_de: i.substituto_de ?? undefined,
        observacao: i.observacao ?? undefined,
        qtd_encomenda: i.qtd_encomenda ?? 0,
        fora_promocao: !!i.fora_promocao,
      })),
    });
    return { orcamento: salvo, sem_itens: false, venda_perdida: r.venda_perdida.length };
  }
}

/**
 * Linha de aviso do papel para a parte sem saldo: coberta pelo que aguarda liberação
 * (nota lançada, peça em conferência) ou simplesmente sem estoque. Produto que sumiu do ERP conta como zero.
 */
function faltaSaldo(aEntregar: number, disponivel: number | undefined, aguardando: number): Pick<PdfItem, 'falta_saldo' | 'saldo_situacao'> {
  const falta = Math.max(0, aEntregar - Math.max(0, disponivel ?? 0));
  if (falta <= 0) return { falta_saldo: 0, saldo_situacao: null };
  return { falta_saldo: falta, saldo_situacao: aguardando >= falta ? 'AGUARDANDO' : 'INDISPONIVEL' };
}

/** Data em dd/mm/aaaa a partir de Date ou 'aaaa-mm-dd…'; null quando vazia. */
function dmy(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  const [a, m, d] = s.split('-');
  return a && m && d ? `${d}/${m}/${a}` : null;
}

/** Subtipo fiscal '09' = serviço (o ERP grava com zero à esquerda; '9' também vale). */
const ehServico = (subtipo: string | null | undefined) => String(subtipo ?? '').trim().replace(/^0+/, '') === '9';

/** Mesmo vocabulário da tela: nada de "tabela 2" para o cliente. */
function nomeTabelaCliente(t: string | null | undefined): string | null {
  const v = (t ?? '').trim();
  if (v === '2') return 'Cliente atacado especial';
  if (v === '5') return 'Cliente atacado';
  if (v === '1' || v === '') return v ? 'Cliente varejo' : null;
  return `Tabela ${v}`;
}
