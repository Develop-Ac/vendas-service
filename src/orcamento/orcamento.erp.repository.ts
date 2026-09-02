import { Injectable } from '@nestjs/common';
import { ErpApiService, FiltroErp } from '../common/erp-api/erp-api.service';

/* =============================================================================
   ORÇAMENTO — leitura AO VIVO no ERP (Celta) via erp-firebird-api.
   -----------------------------------------------------------------------------
   Duas perguntas que só o ERP responde na hora: "quanto tem em estoque AGORA"
   e "qual é o preço deste item NA TABELA DESTE CLIENTE". O BI é retrato do dia
   anterior e a média de venda é líquida de desconto — nenhum dos dois serve
   para montar um preço de proposta.

   Tudo é lote: a tela nunca pergunta produto a produto.
   ============================================================================= */

/** Empresa do atacado — a mesma dos orçamentos e do cadastro de preço. */
export const EMPRESA = 3;
/** Tabelas de preço que definem o universo do atacado (CLIENTES.TABELA_PRECO). */
export const TABELAS_ATACADO = ['2', '5'];

export interface ProdutoErp {
  PRO_CODIGO: number;
  PRO_DESCRICAO: string;
  REFERENCIA: string | null;
  UNIDADE: string | null;
  APLICACOES: string | null;
  SUBGRP_CODIGO: number | null;
  MAR_CODIGO: number | null;
  ESTOQUE_DISPONIVEL: number;
  ESTOQUE_RESERVADO: number;
  PRECO_VENDA: number;
  PRECO1: number; PRECO2: number; PRECO3: number; PRECO4: number; PRECO5: number;
  PRECO6: number; PRECO7: number; PRECO8: number; PRECO9: number; PRECO10: number;
  PRECO_CUSTO: number;
  CUSTO_NOTA: number | null;
  DESCTO_MAXIMO: number | null;
  INATIVO: string | null;
  DT_ULTIMA_COMPRA: string | null;
}

const CAMPOS_PRODUTO = [
  'PRO_CODIGO', 'PRO_DESCRICAO', 'REFERENCIA', 'UNIDADE', 'APLICACOES',
  'SUBGRP_CODIGO', 'MAR_CODIGO', 'ESTOQUE_DISPONIVEL', 'ESTOQUE_RESERVADO',
  'PRECO_VENDA', 'PRECO1', 'PRECO2', 'PRECO3', 'PRECO4', 'PRECO5',
  'PRECO6', 'PRECO7', 'PRECO8', 'PRECO9', 'PRECO10',
  'PRECO_CUSTO', 'CUSTO_NOTA', 'DESCTO_MAXIMO', 'INATIVO', 'DT_ULTIMA_COMPRA',
];

export interface ClienteErp {
  CLI_CODIGO: number;
  CLI_NOME: string;
  CPF_CNPJ: string | null;
  UF: string | null;
  CIDADE: string | null;
  FONE: string | null;
  CELULAR: string | null;
  CONTATO: string | null;
  REP_CODIGO: number | null;
  TABELA_PRECO: string | null;
  INATIVO: string | null;
  LIMITE_CREDITO: number | null;
  BLOQUEAR_VENDA_CREDIARIO: string | null;
  CON_CODIGO: number | null;
  DATA_ULT_COMPRA: string | null;
}

const CAMPOS_CLIENTE = [
  'CLI_CODIGO', 'CLI_NOME', 'CPF_CNPJ', 'UF', 'CIDADE', 'FONE', 'CELULAR', 'CONTATO',
  'REP_CODIGO', 'TABELA_PRECO', 'INATIVO', 'LIMITE_CREDITO', 'BLOQUEAR_VENDA_CREDIARIO',
  'CON_CODIGO', 'DATA_ULT_COMPRA',
];

const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

/**
 * A erp-firebird-api considera a resposta TRUNCADA quando o número de linhas
 * é IGUAL ao limite pedido — e o ErpApiService transforma isso em erro. Logo,
 * pedir exatamente o que se espera (1 cliente, N produtos por código) falha
 * justamente quando dá certo. Pede-se sempre uma linha a mais e corta-se aqui.
 */
const FOLGA = 1;

@Injectable()
export class OrcamentoErpRepository {
  constructor(private readonly erp: ErpApiService) {}

  private normalizarProduto(r: Record<string, any>): ProdutoErp {
    const p: any = { ...r };
    for (const k of ['ESTOQUE_DISPONIVEL', 'ESTOQUE_RESERVADO', 'PRECO_VENDA', 'PRECO_CUSTO',
      'PRECO1', 'PRECO2', 'PRECO3', 'PRECO4', 'PRECO5', 'PRECO6', 'PRECO7', 'PRECO8', 'PRECO9', 'PRECO10']) {
      p[k] = num(r[k]);
    }
    p.PRO_CODIGO = Number(r.PRO_CODIGO);
    p.SUBGRP_CODIGO = r.SUBGRP_CODIGO == null ? null : Number(r.SUBGRP_CODIGO);
    p.CUSTO_NOTA = r.CUSTO_NOTA == null ? null : Number(r.CUSTO_NOTA);
    p.DESCTO_MAXIMO = r.DESCTO_MAXIMO == null ? null : Number(r.DESCTO_MAXIMO);
    p.INATIVO = (r.INATIVO ?? '').toString().trim() || null;
    p.PRO_DESCRICAO = (r.PRO_DESCRICAO ?? '').toString().trim();
    return p as ProdutoErp;
  }

  /**
   * Busca de produto para a tela: código exato quando o termo é numérico;
   * senão TODAS as palavras do termo na descrição (o montador só combina
   * filtros com AND — cada palavra vira um `contem`). Sem resultado na
   * descrição, tenta a referência.
   */
  async buscarProdutos(termo: string, limite = 30): Promise<ProdutoErp[]> {
    const t = termo.trim();
    if (!t) return [];
    const base = { empresa: EMPRESA, campos: CAMPOS_PRODUTO, limite: limite + FOLGA };

    if (/^\d+$/.test(t)) {
      const r = await this.erp.consultar<Record<string, any>>('produtos', {
        ...base,
        filtros: [{ campo: 'PRO_CODIGO', op: 'igual', valor: Number(t) }],
        limite: 1 + FOLGA,
      });
      return r.slice(0, 1).map((x) => this.normalizarProduto(x));
    }

    // Com "%" no termo, a busca é a do balcão no Celta: "P/BRISA%AMAROK" = começa
    // com P/BRISA e depois tem AMAROK; "%AMAROK" = contém AMAROK. O curinga
    // final é implícito, como lá. Sem "%", cada palavra vira um "contém" (E).
    const filtroDescricao: FiltroErp[] = t.includes('%')
      ? [{ campo: 'PRO_DESCRICAO', op: 'parecido', valor: t.toUpperCase().endsWith('%') ? t.toUpperCase() : `${t.toUpperCase()}%` }]
      : t.toUpperCase().split(/\s+/).filter((p) => p.length >= 3).slice(0, 6)
          .map<FiltroErp>((p) => ({ campo: 'PRO_DESCRICAO', op: 'contem', valor: p }));
    if (!filtroDescricao.length) return [];
    const porDescricao = await this.erp.consultar<Record<string, any>>('produtos', {
      ...base,
      filtros: [...filtroDescricao, { campo: 'INATIVO', op: 'diferente', valor: 'S' }],
      ordenar: [{ campo: 'PRO_DESCRICAO', dir: 'asc' }],
    });
    if (porDescricao.length > 0) return porDescricao.slice(0, limite).map((x) => this.normalizarProduto(x));

    const porReferencia = await this.erp.consultar<Record<string, any>>('produtos', {
      ...base,
      filtros: [
        { campo: 'REFERENCIA', op: 'contem', valor: t.toUpperCase().replace(/[%_]/g, '') },
        { campo: 'INATIVO', op: 'diferente', valor: 'S' },
      ],
    });
    return porReferencia.slice(0, limite).map((x) => this.normalizarProduto(x));
  }

  /** Produtos por código, em lote (máx. 500 por chamada — teto do filtro `em`). */
  async produtosPorCodigo(codigos: number[]): Promise<ProdutoErp[]> {
    const unicos = [...new Set(codigos.filter((c) => Number.isFinite(c)))];
    if (unicos.length === 0) return [];
    const saida: ProdutoErp[] = [];
    for (let i = 0; i < unicos.length; i += 500) {
      const lote = unicos.slice(i, i + 500);
      const r = await this.erp.consultar<Record<string, any>>('produtos', {
        empresa: EMPRESA,
        campos: CAMPOS_PRODUTO,
        filtros: [{ campo: 'PRO_CODIGO', op: 'em', valor: lote }],
        limite: lote.length + FOLGA,
        semCache: true, // saldo é a pergunta — nunca servir de cache
      });
      saida.push(...r.map((x) => this.normalizarProduto(x)));
    }
    return saida;
  }

  private normalizarCliente(r: Record<string, any>): ClienteErp {
    return {
      CLI_CODIGO: Number(r.CLI_CODIGO),
      CLI_NOME: (r.CLI_NOME ?? '').toString().trim(),
      CPF_CNPJ: r.CPF_CNPJ ?? null,
      UF: r.UF ?? null,
      CIDADE: r.CIDADE ?? null,
      FONE: r.FONE ?? null,
      CELULAR: r.CELULAR ?? null,
      CONTATO: r.CONTATO ?? null,
      REP_CODIGO: r.REP_CODIGO == null ? null : Number(r.REP_CODIGO),
      TABELA_PRECO: (r.TABELA_PRECO ?? '').toString().trim() || null,
      INATIVO: (r.INATIVO ?? '').toString().trim() || null,
      LIMITE_CREDITO: r.LIMITE_CREDITO == null ? null : Number(r.LIMITE_CREDITO),
      BLOQUEAR_VENDA_CREDIARIO: (r.BLOQUEAR_VENDA_CREDIARIO ?? '').toString().trim() || null,
      CON_CODIGO: r.CON_CODIGO == null ? null : Number(r.CON_CODIGO),
      DATA_ULT_COMPRA: r.DATA_ULT_COMPRA ?? null,
    };
  }

  /**
   * Busca de cliente: código, CNPJ/CPF (só dígitos) ou nome. Por padrão restrita
   * ao universo do atacado (TABELA_PRECO 2/5) — `todos` abre para a base inteira.
   */
  async buscarClientes(termo: string, todos = false, limite = 20): Promise<ClienteErp[]> {
    const t = termo.trim();
    if (!t) return [];
    const filtros: FiltroErp[] = [];
    if (!todos) filtros.push({ campo: 'TABELA_PRECO', op: 'em', valor: TABELAS_ATACADO });
    const digitos = t.replace(/\D/g, '');
    if (/^\d+$/.test(t) && t.length <= 8) {
      filtros.push({ campo: 'CLI_CODIGO', op: 'igual', valor: Number(t) });
    } else if (digitos.length >= 11 && digitos.length === t.replace(/[.\-\/\s]/g, '').length) {
      filtros.push({ campo: 'CPF_DIGITOS', op: 'contem', valor: digitos });
    } else {
      for (const p of t.toUpperCase().split(/\s+/).filter((x) => x.length >= 3).slice(0, 5)) {
        filtros.push({ campo: 'CLI_NOME', op: 'contem', valor: p });
      }
    }
    const r = await this.erp.consultar<Record<string, any>>('clientes', {
      empresa: EMPRESA,
      campos: CAMPOS_CLIENTE,
      filtros,
      ordenar: [{ campo: 'CLI_NOME', dir: 'asc' }],
      limite: limite + FOLGA,
    });
    return r.slice(0, limite).map((x) => this.normalizarCliente(x));
  }

  async clientePorCodigo(cli: number): Promise<ClienteErp | null> {
    const r = await this.erp.consultar<Record<string, any>>('clientes', {
      empresa: EMPRESA,
      campos: CAMPOS_CLIENTE,
      filtros: [{ campo: 'CLI_CODIGO', op: 'igual', valor: cli }],
      limite: 1 + FOLGA,
      semCache: true,
    });
    return r.length ? this.normalizarCliente(r[0]) : null;
  }
}
