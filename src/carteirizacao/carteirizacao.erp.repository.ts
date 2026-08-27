import { Injectable, Logger } from '@nestjs/common';
import { ErpApiService } from '../common/erp-api/erp-api.service';
import {
  ClienteBaseRow,
  VendaAposCarteiraRow,
  VendedorRow,
} from './carteirizacao.sqlserver.repository';

/* =============================================================================
   CARTEIRIZAÇÃO — a MESMA base de clientes, lida do ERP em vez do BI.

   Implementa o contrato de CarteirizacaoSqlServerRepository para a parte da
   tela que o ERP consegue responder: cadastro, faturamento, margem, crediário
   e títulos em aberto. Metas, período comissional, equipe e mapa continuam no
   BI — não existem no ERP.

   POR QUE trocar a fonte: no caminho antigo a tela lê o SQL Server, que é
   alimentado por ETLs via OPENQUERY. Quando o Firebird engasga nesse caminho,
   o provider OLE DB não retorna, o KILL não solta a sessão e o SQL Server
   inteiro para. A tela não é a causa e mesmo assim é a vítima.

   O QUE MUDA nos números, medido contra o BI nos 1178 clientes do atacado:

     1. Devolução (operação fiscal 2) agora ABATE o faturamento. O BI somava a
        devolução como receita positiva — inconsistente com a própria margem
        dele, que já tratava o sinal. Em um cliente medido isso inflava a
        receita de 12 meses em 12,5%.

     2. Os números incluem as notas de HOJE. O BI depende do ETL Stage_Vendas,
        que fica em SKIP enquanto outra execução segura o applock.

     3. Cadastro e crédito vêm preenchidos. Stage_Clientes está com esses campos
        nulos para boa parte da base atacado — 814 clientes sem telefone, 1107
        sem contato, 746 sem situação, conceito e limite de crédito. O ERP tem
        todos, e mais atualizados (celular com o 9º dígito, por exemplo).

     4. O histórico é completo. Stage_Vendas não tem as notas mais antigas: em
        um cliente medido, 1197 notas no ERP contra 952 no BI, a mais antiga do
        BI em 2013 e a do ERP em 2005.

   Nota a nota, todo o resto conferiu: nenhuma nota do BI está ausente no ERP e
   nenhuma tem valor diferente.

   `vendasAposCarteira` soma TOTAL_NOTA, e não o líquido item a item que a
   versão do BI usava. É de propósito: passa a ser a mesma medida das colunas de
   faturamento da mesma tela, em vez de duas definições de "quanto vendeu"
   convivendo lado a lado.
   ============================================================================= */

/** Empresa do ERP onde vivem cadastro e faturamento do atacado. */
const EMPRESA = 3;

/** Universo da carteirização: tabela de preço 2 (atacado esp.) e 5 (atacado). */
const TABELAS_ATACADO = ['2', '5'];

/**
 * Operações fiscais que são venda a cliente. NF_SAIDA guarda toda saída de
 * mercadoria: devolução ao fornecedor (501), uso/consumo, avaria, remessa de
 * garantia e transferência também estão lá, e em várias delas CLI_CODIGO é o
 * FORNECEDOR. Sem este recorte, 164 dos 600 clientes com margem vinham com
 * receita a mais — um deles 23× maior.
 *
 * É a mesma lista do ETL do BI (sp_Load_Stage_Vendas_Incremental), para que as
 * duas fontes respondam o mesmo número.
 */
const OPERACOES_VENDA = ['1', '4', '5', '6', '7', '101', '104', '105', '106', '124', '200'];
/** Devolução de cliente: entra na contagem de notas, mas ABATE o valor. */
const OPERACOES_DEVOLUCAO = ['2'];
const TODAS_OPERACOES = [...OPERACOES_VENDA, ...OPERACOES_DEVOLUCAO];

/** Pseudo-produto excluído da análise de vendas, como no BI. */
const PRODUTO_FORA_DA_ANALISE = 47777;

/** Teto de itens num filtro `em` da API. */
const LOTE_EM = 500;

/** Vendedor "pool" (Lucas Barrada): fora das sugestões de recarterização. */
const REP_DISPONIVEL = 316;

interface LinhaAgregada {
  CLI_CODIGO: number;
  FAT?: number;
  PEDIDOS?: number;
  DIAS?: number;
  ULT?: string | null;
  DESCONTO_NOTA?: number;
}

/** Agregado de orçamentos de um cliente do atacado (janela de 90 dias). */
export interface OrcamentoResumoCliente {
  cli_codigo: number;
  orcamentos_90d: number;
  valor_orcado_90d: number;
  /** Último orçamento em até 24 meses — de qualquer janela, não só 90d. */
  ult_orcamento: Date | null;
}

/** Orçamento emitido que NÃO virou venda do cliente dentro da carência. */
export interface OrcamentoSemDesfecho {
  orcamento: number;
  emissao: Date;
  cli_codigo: number;
  /** Nome gravado NO orçamento (cópia da época). */
  cli_nome: string | null;
  rep_codigo: number | null;
  total: number;
  dias_desde_emissao: number;
}

interface LinhaItens {
  CLI_CODIGO: number;
  BRUTO: number;
  DESCONTO_ITEM: number;
  CUSTO: number;
}

@Injectable()
export class CarteirizacaoErpRepository {
  private readonly logger = new Logger(CarteirizacaoErpRepository.name);

  constructor(private readonly erp: ErpApiService) {}

  /* ------------------------------------------------------------------ datas */

  /** `YYYY-MM-DD` de hoje menos N meses — o recorte que o BI faz com DATEADD. */
  private mesesAtras(n: number): string {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 10);
  }

  /* ------------------------------------------------------------- consultas */

  /**
   * Agregado de notas por cliente, para um recorte de operação e período.
   *
   * Parte de CLIENTES e alcança NF_SAIDA pela relação `notas`, que é LEFT — mas
   * o filtro de data/operação vai para o WHERE, então esta consulta devolve
   * SÓ quem tem nota no recorte. É de propósito: a lista completa de clientes
   * vem de `cadastro()`, e estes agregados são costurados por cima. Quem não
   * aparece aqui fica com zero, não some da tela.
   */
  private async agregadoDeNotas(
    operacoes: string[],
    periodo: { desde?: string; ate?: string },
    extras: { contagem?: boolean; descontoNota?: boolean } = {},
  ): Promise<LinhaAgregada[]> {
    const filtros: any[] = [
      { campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO },
      { campo: 'notas.OPF_CODIGO', op: 'em', valor: operacoes },
    ];
    if (periodo.desde && periodo.ate) {
      filtros.push({ campo: 'notas.DT_EMISSAO', op: 'entre', valor: [periodo.desde, periodo.ate] });
    } else if (periodo.desde) {
      filtros.push({ campo: 'notas.DT_EMISSAO', op: 'maior_igual', valor: periodo.desde });
    }

    const agregar: any[] = [{ fn: 'somar', campo: 'notas.TOTAL_NOTA', como: 'FAT' }];
    if (extras.contagem) {
      agregar.push(
        { fn: 'contar', campo: 'notas.NFS', como: 'PEDIDOS' },
        // Dias DISTINTOS com compra. COUNT simples aqui devolveria o número de
        // notas — outra pergunta, com resposta parecida o bastante para passar.
        { fn: 'contar_distinto', campo: 'notas.DT_EMISSAO', como: 'DIAS' },
        { fn: 'maximo', campo: 'notas.DT_EMISSAO', como: 'ULT' },
      );
    }
    if (extras.descontoNota) {
      agregar.push({ fn: 'somar', campo: 'notas.VALOR_DESCTO', como: 'DESCONTO_NOTA' });
    }

    return this.erp.consultar<LinhaAgregada>('clientes', {
      empresa: EMPRESA,
      filtros,
      agrupar: ['CLI_CODIGO'],
      agregar,
      limite: 20_000,
    });
  }

  /**
   * Agregado de ITENS por cliente — a base da margem.
   *
   * O item não guarda cliente: chega-se a ele por `nota` e, daí, a `cliente`
   * (relação encadeada), que é também como o recorte do atacado é aplicado.
   */
  private async agregadoDeItens(operacoes: string[], desde: string): Promise<LinhaItens[]> {
    return this.erp.consultar<LinhaItens>('nfs-itens', {
      empresa: EMPRESA,
      filtros: [
        { campo: 'nota.DT_EMISSAO', op: 'maior_igual', valor: desde },
        { campo: 'nota.DT_CANCELAMENTO', op: 'nulo' },
        { campo: 'nota.OPF_CODIGO', op: 'em', valor: operacoes },
        { campo: 'PRO_CODIGO', op: 'diferente', valor: PRODUTO_FORA_DA_ANALISE },
        { campo: 'cliente.TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO },
      ],
      agrupar: ['nota.CLI_CODIGO'],
      agregar: [
        // VALOR_BRUTO e CUSTO_TOTAL são derivadas do catálogo. Somar
        // PRECO_CUSTO cru devolveria a soma dos preços UNITÁRIOS — plausível e
        // errado.
        { fn: 'somar', campo: 'VALOR_BRUTO', como: 'BRUTO' },
        { fn: 'somar', campo: 'VALOR_DESCTO', como: 'DESCONTO_ITEM' },
        { fn: 'somar', campo: 'CUSTO_TOTAL', como: 'CUSTO' },
      ],
      limite: 20_000,
    });
  }

  /**
   * Cadastro do universo atacado.
   *
   * O nome do representante NÃO vem por JOIN aqui. REPRESENTANTES repete
   * REP_CODIGO e não tem EMPRESA para desempatar, então a relação multiplica as
   * linhas do cliente: medido, 1178 clientes viraram 2148 com 485 duplicados —
   * e uma lista duplicada continua parecendo uma lista. O nome é resolvido em
   * consulta separada e casado em memória.
   */
  private async cadastro() {
    return this.erp.consultar<Record<string, any>>('clientes', {
      empresa: EMPRESA,
      campos: [
        'CLI_CODIGO',
        'CLI_NOME',
        'UF',
        'CIDADE',
        'FONE',
        'CONTATO',
        'DATA_ULT_COMPRA',
        'REP_CODIGO',
        'TABELA_PRECO',
        'INATIVO',
        'BLOQUEAR_VENDA_CREDIARIO',
        'LIMITE_CREDITO',
        'CON_CODIGO',
      ],
      filtros: [{ campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO }],
      limite: 20_000,
    });
  }

  /** Cadastro + nome do representante já casado, sem multiplicar linhas. */
  private async cadastroComRepresentante(): Promise<Array<Record<string, any>>> {
    const cad = await this.cadastro();
    const reps = await this.nomesRepresentantes(
      cad.map((c) => Number(c.REP_CODIGO)).filter((r) => Number.isInteger(r)),
    );
    const nomes = new Map(reps.map((r) => [r.rep_codigo, r.rep_nome]));
    return cad.map((c) => ({
      ...c,
      REP_NOME: c.REP_CODIGO != null ? (nomes.get(Number(c.REP_CODIGO)) ?? null) : null,
    }));
  }

  /** Saldo em aberto por cliente. "Em aberto" exige as DUAS condições. */
  private async saldoEmAberto(): Promise<Array<{ CLI_CODIGO: number; ABERTO: number }>> {
    return this.erp.consultar<{ CLI_CODIGO: number; ABERTO: number }>('contas-receber', {
      empresa: EMPRESA,
      filtros: [
        { campo: 'STATUS', op: 'igual', valor: 0 },
        { campo: 'DATA_PAGTO', op: 'nulo' },
      ],
      agrupar: ['CLI_CODIGO'],
      // Título em aberto não tem pagamento parcial nesta base (conferido:
      // 2087 títulos, nenhum com valor pago), então VALOR é o saldo.
      agregar: [{ fn: 'somar', campo: 'VALOR', como: 'ABERTO' }],
      limite: 50_000,
    });
  }

  /* ------------------------------------------------------------------ base */

  /**
   * Base completa de clientes atacado + métricas, no mesmo formato que a versão
   * do BI devolve. Doze consultas em paralelo; o universo é pequeno (~1,2 mil
   * clientes) e a filtragem/paginação continua em memória no service.
   */
  async listarBaseAtacado(): Promise<ClienteBaseRow[]> {
    const d12 = this.mesesAtras(12);
    const d3 = this.mesesAtras(3);
    const d6 = this.mesesAtras(6);
    const inicio = Date.now();

    const [
      cad,
      totGeral,
      totVenda,
      totDev,
      v12,
      d12v,
      v3,
      d3v,
      vAnt,
      dAnt,
      itVenda,
      itDev,
      aberto,
    ] = await Promise.all([
      this.cadastroComRepresentante(),
      // Contagem de notas, dias com compra e última compra: sobre TODAS as
      // operações e sem recorte de período, como no BI.
      this.agregadoDeNotas(TODAS_OPERACOES, {}, { contagem: true }),
      this.agregadoDeNotas(OPERACOES_VENDA, {}),
      this.agregadoDeNotas(OPERACOES_DEVOLUCAO, {}),
      this.agregadoDeNotas(OPERACOES_VENDA, { desde: d12 }, { descontoNota: true }),
      this.agregadoDeNotas(OPERACOES_DEVOLUCAO, { desde: d12 }, { descontoNota: true }),
      this.agregadoDeNotas(OPERACOES_VENDA, { desde: d3 }),
      this.agregadoDeNotas(OPERACOES_DEVOLUCAO, { desde: d3 }),
      this.agregadoDeNotas(OPERACOES_VENDA, { desde: d6, ate: d3 }),
      this.agregadoDeNotas(OPERACOES_DEVOLUCAO, { desde: d6, ate: d3 }),
      this.agregadoDeItens(OPERACOES_VENDA, d12),
      this.agregadoDeItens(OPERACOES_DEVOLUCAO, d12),
      this.saldoEmAberto(),
    ]);

    const ix = <T extends { CLI_CODIGO: number }>(linhas: T[]) =>
      new Map(linhas.map((l) => [Number(l.CLI_CODIGO), l]));

    const G = ix(totGeral),
      TV = ix(totVenda),
      TD = ix(totDev),
      V12 = ix(v12),
      D12 = ix(d12v),
      V3 = ix(v3),
      D3 = ix(d3v),
      VA = ix(vAnt),
      DA = ix(dAnt),
      IV = ix(itVenda),
      ID = ix(itDev),
      AB = ix(aberto);

    const n = (v: unknown) => {
      const x = Number(v ?? 0);
      return Number.isFinite(x) ? x : 0;
    };
    /** Faturamento líquido de devolução no recorte. */
    const liquido = (
      venda: Map<number, LinhaAgregada>,
      dev: Map<number, LinhaAgregada>,
      cli: number,
    ) => n(venda.get(cli)?.FAT) - n(dev.get(cli)?.FAT);

    const linhas = cad.map((c): ClienteBaseRow => {
      const cli = Number(c.CLI_CODIGO);
      const bloqueado = String(c.BLOQUEAR_VENDA_CREDIARIO ?? '').trim().toUpperCase() === 'S';
      const crediario = bloqueado ? 'BLOQUEADO' : 'LIBERADO';
      const limite = n(c.LIMITE_CREDITO);

      const iv = IV.get(cli),
        id = ID.get(cli);
      // Líquido do item = bruto − desconto do item − desconto da nota, e a
      // devolução entra com sinal invertido nos três. É a mesma conta que o BI
      // faz item a item ao ratear o desconto da nota; no agregado por cliente o
      // rateio se cancela e sobra o desconto da nota inteiro.
      const base12 =
        n(iv?.BRUTO) -
        n(id?.BRUTO) -
        (n(iv?.DESCONTO_ITEM) + n(V12.get(cli)?.DESCONTO_NOTA)) +
        (n(id?.DESCONTO_ITEM) + n(D12.get(cli)?.DESCONTO_NOTA));
      const custo12 = n(iv?.CUSTO) - n(id?.CUSTO);

      const ultVenda = G.get(cli)?.ULT ?? null;

      return {
        cli_codigo: cli,
        cli_nome: c.CLI_NOME ?? null,
        uf: c.UF ?? null,
        cidade: c.CIDADE ?? null,
        fone: c.FONE ?? null,
        contato: c.CONTATO ?? null,
        data_ult_compra: c.DATA_ULT_COMPRA ? new Date(c.DATA_ULT_COMPRA) : null,
        rep_codigo: c.REP_CODIGO != null ? Number(c.REP_CODIGO) : null,
        rep_cadastro_nome: c.REP_NOME ?? null,
        tabela_preco: c.TABELA_PRECO != null ? String(c.TABELA_PRECO).trim() : null,
        inativo: c.INATIVO != null ? String(c.INATIVO).trim() : null,
        // Mesma composição da vw_clientes do BI: "CIDADE, UF, BRASIL", e nula
        // quando falta um dos dois — é o que alimenta a geocodificação.
        localizacao_completa: c.CIDADE && c.UF ? `${c.CIDADE}, ${c.UF}, BRASIL` : null,

        faturamento_total: liquido(TV, TD, cli),
        faturamento_3m: liquido(V3, D3, cli),
        faturamento_3m_ant: liquido(VA, DA, cli),
        faturamento_12m: liquido(V12, D12, cli),
        qtd_pedidos: n(G.get(cli)?.PEDIDOS),
        dias_com_venda: n(G.get(cli)?.DIAS),
        ult_compra_venda: ultVenda ? new Date(ultVenda) : null,

        lucro_12m: base12 - custo12,
        base_12m: base12,
        custo_12m: custo12,

        crediario,
        con_codigo: c.CON_CODIGO != null ? Number(c.CON_CODIGO) : null,
        limite_credito: limite,
        limite_disponivel: bloqueado ? 0 : limite - n(AB.get(cli)?.ABERTO),
      };
    });

    this.logger.log(
      `Base atacado do ERP: ${linhas.length} clientes em ${Date.now() - inicio}ms (13 consultas).`,
    );
    return linhas;
  }

  /* ------------------------------------------------------------ orçamentos */

  /**
   * Agregado de orçamentos por cliente do atacado — o sinal de ESFORÇO.
   *
   * Duas consultas: a janela de 90 dias (contagem, valor, último) e uma janela
   * longa de 24 meses só para a data do último orçamento de quem não orçou no
   * trimestre — a tabela exige filtro de EMISSAO (guarda o histórico inteiro),
   * então "último de todos os tempos" é deliberadamente aproximado para 24m.
   *
   * A conversão NÃO sai daqui: o vínculo NFS do ERP fica vazio em ~99% dos
   * orçamentos. Fechamento se infere em `orcamentosSemDesfecho`.
   */
  async resumoOrcamentosAtacado(): Promise<OrcamentoResumoCliente[]> {
    const ATAC = { campo: 'cliente.TABELA_PRECO', op: 'em' as const, valor: TABELAS_ATACADO };
    const [curto, longo] = await Promise.all([
      this.erp.consultar<{ CLI_CODIGO: number; ORCS: number; VALOR: number; ULT: string }>(
        'orcamentos',
        {
          empresa: EMPRESA,
          filtros: [{ campo: 'EMISSAO', op: 'maior_igual', valor: this.mesesAtras(3) }, ATAC],
          agrupar: ['CLI_CODIGO'],
          agregar: [
            { fn: 'contar', campo: 'ORCAMENTO', como: 'ORCS' },
            { fn: 'somar', campo: 'TOTAL', como: 'VALOR' },
            { fn: 'maximo', campo: 'EMISSAO', como: 'ULT' },
          ],
          limite: 20_000,
        },
      ),
      this.erp.consultar<{ CLI_CODIGO: number; ULT: string }>('orcamentos', {
        empresa: EMPRESA,
        filtros: [{ campo: 'EMISSAO', op: 'maior_igual', valor: this.mesesAtras(24) }, ATAC],
        agrupar: ['CLI_CODIGO'],
        agregar: [{ fn: 'maximo', campo: 'EMISSAO', como: 'ULT' }],
        limite: 20_000,
      }),
    ]);

    const porCliente = new Map<number, OrcamentoResumoCliente>();
    for (const l of longo) {
      porCliente.set(Number(l.CLI_CODIGO), {
        cli_codigo: Number(l.CLI_CODIGO),
        orcamentos_90d: 0,
        valor_orcado_90d: 0,
        ult_orcamento: l.ULT ? new Date(l.ULT) : null,
      });
    }
    for (const c of curto) {
      const cli = Number(c.CLI_CODIGO);
      const linha = porCliente.get(cli) ?? {
        cli_codigo: cli,
        orcamentos_90d: 0,
        valor_orcado_90d: 0,
        ult_orcamento: null,
      };
      linha.orcamentos_90d = Number(c.ORCS ?? 0);
      linha.valor_orcado_90d = Number(c.VALOR ?? 0);
      if (c.ULT) {
        const d = new Date(c.ULT);
        if (!linha.ult_orcamento || d > linha.ult_orcamento) linha.ult_orcamento = d;
      }
      porCliente.set(cli, linha);
    }
    return [...porCliente.values()];
  }

  /**
   * Orçamentos do atacado SEM desfecho: emitidos há mais de `carenciaDias` e
   * sem NENHUMA venda do mesmo cliente dentro da carência.
   *
   * O desfecho é inferido, não lido: o vínculo NFS fica vazio em ~99% dos
   * orçamentos, e a inferência por venda em até 7 dias bateu 65% de conversão
   * na medição. O corte por CLIENTE (qualquer venda no prazo) e não por item é
   * deliberado: superestima levemente o fechamento, o que deixa a fila de
   * motivo MENOR — melhor perder um caso ambíguo que cobrar motivo de venda
   * fechada.
   */
  async orcamentosSemDesfecho(
    carenciaDias = 7,
    janelaDias = 60,
  ): Promise<OrcamentoSemDesfecho[]> {
    const hoje = new Date();
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const desde = new Date(hoje);
    desde.setDate(desde.getDate() - janelaDias);
    const ateEmissao = new Date(hoje);
    ateEmissao.setDate(ateEmissao.getDate() - carenciaDias);
    if (ateEmissao < desde) return [];

    const [orcs, vendas] = await Promise.all([
      this.erp.consultar<Record<string, any>>('orcamentos', {
        empresa: EMPRESA,
        campos: ['ORCAMENTO', 'EMISSAO', 'CLI_CODIGO', 'CLI_NOME', 'REP_CODIGO', 'TOTAL'],
        filtros: [
          { campo: 'EMISSAO', op: 'entre', valor: [ymd(desde), ymd(ateEmissao)] },
          { campo: 'cliente.TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO },
        ],
        limite: 20_000,
      }),
      // Pares (cliente, dia) com venda no período — o suficiente para casar a
      // carência de cada orçamento sem trazer nota a nota.
      this.erp.consultar<{ CLI_CODIGO: number; DT_EMISSAO: string }>('nf-saida', {
        empresa: EMPRESA,
        filtros: [
          { campo: 'DT_EMISSAO', op: 'maior_igual', valor: ymd(desde) },
          { campo: 'DT_CANCELAMENTO', op: 'nulo' },
          { campo: 'OPF_CODIGO', op: 'em', valor: OPERACOES_VENDA },
          { campo: 'cliente.TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO },
        ],
        agrupar: ['CLI_CODIGO', 'DT_EMISSAO'],
        agregar: [{ fn: 'contar', campo: 'NFS', como: 'N' }],
        // Teto de NF_SAIDA na API é 20k — sobra: são pares DISTINTOS cliente×dia
        // do atacado (~369 compradores × poucos dias cada na janela).
        limite: 20_000,
      }),
    ]);

    const diasComVenda = new Map<number, string[]>();
    for (const v of vendas) {
      const cli = Number(v.CLI_CODIGO);
      const dia = String(v.DT_EMISSAO).slice(0, 10);
      (diasComVenda.get(cli) ?? diasComVenda.set(cli, []).get(cli)!).push(dia);
    }

    const semDesfecho: OrcamentoSemDesfecho[] = [];
    for (const o of orcs) {
      const emissao = String(o.EMISSAO).slice(0, 10);
      const limite = new Date(emissao);
      limite.setDate(limite.getDate() + carenciaDias);
      const limiteYmd = ymd(limite);
      const fechou = (diasComVenda.get(Number(o.CLI_CODIGO)) ?? []).some(
        (dia) => dia >= emissao && dia <= limiteYmd,
      );
      if (fechou) continue;
      semDesfecho.push({
        orcamento: Number(o.ORCAMENTO),
        emissao: new Date(o.EMISSAO),
        cli_codigo: Number(o.CLI_CODIGO),
        cli_nome: o.CLI_NOME ?? null,
        rep_codigo: o.REP_CODIGO != null ? Number(o.REP_CODIGO) : null,
        total: Number(o.TOTAL ?? 0),
        dias_desde_emissao: Math.floor((hoje.getTime() - new Date(emissao).getTime()) / 86_400_000),
      });
    }
    // Mais novo primeiro: o vendedor ainda lembra do orçamento recente — é onde
    // o motivo marcado tem qualidade; o rabo antigo fica para o fim da lista.
    return semDesfecho.sort(
      (a, b) => b.emissao.getTime() - a.emissao.getTime() || b.total - a.total,
    );
  }

  /**
   * Representantes que têm cliente no atacado. Sai do próprio cadastro já
   * carregado no ERP — inclusive quem saiu do canal, que precisa continuar
   * aparecendo para a carteira dele poder ser redistribuída.
   */
  async listarVendedoresAtacado(): Promise<VendedorRow[]> {
    const cad = await this.cadastroComRepresentante();
    const porRep = new Map<number, string>();
    for (const c of cad) {
      if (c.REP_CODIGO == null) continue;
      const rep = Number(c.REP_CODIGO);
      const nome = String(c.REP_NOME ?? '').trim();
      if (nome || !porRep.has(rep)) porRep.set(rep, nome || `Rep ${rep}`);
    }
    return [...porRep.entries()]
      .map(([rep_codigo, rep_nome]) => ({ rep_codigo, rep_nome }))
      .sort((a, b) => a.rep_nome.localeCompare(b.rep_nome, 'pt-BR'));
  }

  /** Nomes de representantes por código. */
  async nomesRepresentantes(codigos: number[]): Promise<VendedorRow[]> {
    const limpos = [...new Set(codigos.map(Number).filter((x) => Number.isInteger(x)))];
    if (!limpos.length) return [];
    const saida: VendedorRow[] = [];
    for (let i = 0; i < limpos.length; i += LOTE_EM) {
      const linhas = await this.erp.consultar<{ REP_CODIGO: number; REP_NOME: string }>(
        'representantes',
        {
          campos: ['REP_CODIGO', 'REP_NOME'],
          filtros: [{ campo: 'REP_CODIGO', op: 'em', valor: limpos.slice(i, i + LOTE_EM) }],
          limite: 5000,
        },
      );
      saida.push(
        ...linhas.map((l) => ({ rep_codigo: Number(l.REP_CODIGO), rep_nome: l.REP_NOME })),
      );
    }
    // REPRESENTANTES repete REP_CODIGO: fica um nome por código, o primeiro
    // não-vazio. Devolver a lista crua faria o chamador montar um Map e ficar
    // com o último — que pode ser a linha em branco.
    const porCodigo = new Map<number, string>();
    for (const r of saida) {
      const nome = String(r.rep_nome ?? '').trim();
      if (!nome) continue;
      if (!porCodigo.has(r.rep_codigo)) porCodigo.set(r.rep_codigo, nome);
    }
    return [...porCodigo.entries()].map(([rep_codigo, rep_nome]) => ({ rep_codigo, rep_nome }));
  }

  /**
   * Vendas feitas a um conjunto de clientes APÓS a data em que cada um entrou
   * no pool, agregadas por vendedor — a sugestão de para quem recarterizar.
   *
   * A data de corte é de CADA cliente, e o filtro da API é único para a
   * consulta inteira. Por isso a consulta traz as notas a partir do corte MAIS
   * ANTIGO e o corte individual é aplicado aqui: recortar só pelo mais antigo
   * contaria venda anterior à saída da carteira e sugeriria o vendedor errado.
   */
  async vendasAposCarteira(
    itens: Array<{ cli_codigo: number; cutoff: string }>,
  ): Promise<VendaAposCarteiraRow[]> {
    const validos = itens.filter(
      (i) => Number.isInteger(i.cli_codigo) && /^\d{4}-\d{2}-\d{2}$/.test(i.cutoff),
    );
    if (!validos.length) return [];

    const corteMin = validos.reduce((m, i) => (i.cutoff < m ? i.cutoff : m), validos[0].cutoff);
    const cortePorCliente = new Map(validos.map((i) => [i.cli_codigo, i.cutoff]));
    const codigos = [...cortePorCliente.keys()];

    const notas: Array<Record<string, any>> = [];
    for (let i = 0; i < codigos.length; i += LOTE_EM) {
      notas.push(
        ...(await this.erp.consultar('nf-saida', {
          empresa: EMPRESA,
          campos: [
            'NFS',
            'CLI_CODIGO',
            'REP_CODIGO',
            'DT_EMISSAO',
            'TOTAL_NOTA',
            { campo: 'representante.REP_NOME', como: 'REP_NOME' },
          ],
          filtros: [
            { campo: 'CLI_CODIGO', op: 'em', valor: codigos.slice(i, i + LOTE_EM) },
            { campo: 'DT_EMISSAO', op: 'maior', valor: corteMin },
            { campo: 'DT_CANCELAMENTO', op: 'nulo' },
            { campo: 'OPF_CODIGO', op: 'em', valor: OPERACOES_VENDA },
          ],
          limite: 20_000,
        })),
      );
    }

    const acc = new Map<string, VendaAposCarteiraRow>();
    for (const nota of notas) {
      const cli = Number(nota.CLI_CODIGO);
      const rep = nota.REP_CODIGO != null ? Number(nota.REP_CODIGO) : null;
      if (rep == null || rep === REP_DISPONIVEL) continue;

      const dt = String(nota.DT_EMISSAO ?? '').slice(0, 10);
      const corte = cortePorCliente.get(cli);
      if (!corte || !(dt > corte)) continue;

      const chave = `${cli}|${rep}`;
      const atual = acc.get(chave) ?? {
        cli_codigo: cli,
        rep_codigo: rep,
        rep_nome: nota.REP_NOME ?? null,
        valor: 0,
        pedidos: 0,
        ult_venda: null,
      };
      atual.valor += Number(nota.TOTAL_NOTA ?? 0);
      atual.pedidos += 1;
      const data = new Date(nota.DT_EMISSAO);
      if (!atual.ult_venda || data > atual.ult_venda) atual.ult_venda = data;
      acc.set(chave, atual);
    }

    return [...acc.values()].sort(
      (a, b) =>
        a.cli_codigo - b.cli_codigo ||
        (b.ult_venda?.getTime() ?? 0) - (a.ult_venda?.getTime() ?? 0),
    );
  }

  /**
   * Faturamento mensal de UM cliente nos últimos N meses. As notas do período
   * cabem folgadamente em uma consulta, então a quebra por mês é feita aqui —
   * o montador não expõe partes de data.
   */
  async serieMensalCliente(
    cliCodigo: number,
    meses = 12,
  ): Promise<
    Array<{ ano: number; mes: number; faturamento: number; pedidos: number; dias: number }>
  > {
    const notas = await this.erp.consultar<Record<string, any>>('nf-saida', {
      empresa: EMPRESA,
      campos: ['NFS', 'DT_EMISSAO', 'OPF_CODIGO', 'TOTAL_NOTA'],
      filtros: [
        { campo: 'CLI_CODIGO', op: 'igual', valor: cliCodigo },
        { campo: 'DT_EMISSAO', op: 'maior_igual', valor: this.mesesAtras(meses) },
        { campo: 'DT_CANCELAMENTO', op: 'nulo' },
        { campo: 'OPF_CODIGO', op: 'em', valor: TODAS_OPERACOES },
      ],
      limite: 20_000,
    });

    const porMes = new Map<
      string,
      { ano: number; mes: number; faturamento: number; pedidos: number; dias: Set<string> }
    >();
    for (const nota of notas) {
      const dia = String(nota.DT_EMISSAO ?? '').slice(0, 10);
      if (!dia) continue;
      const ano = Number(dia.slice(0, 4));
      const mes = Number(dia.slice(5, 7));
      const chave = `${ano}-${mes}`;
      const atual =
        porMes.get(chave) ?? { ano, mes, faturamento: 0, pedidos: 0, dias: new Set<string>() };
      const devolucao = OPERACOES_DEVOLUCAO.includes(String(nota.OPF_CODIGO ?? '').trim());
      atual.faturamento += Number(nota.TOTAL_NOTA ?? 0) * (devolucao ? -1 : 1);
      atual.pedidos += 1;
      atual.dias.add(dia);
      porMes.set(chave, atual);
    }

    return [...porMes.values()]
      .map(({ dias, ...resto }) => ({ ...resto, dias: dias.size }))
      .sort((a, b) => a.ano - b.ano || a.mes - b.mes);
  }
}
