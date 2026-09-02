import { Injectable, Logger } from '@nestjs/common';
import { ErpApiService, FiltroErp } from '../common/erp-api/erp-api.service';
import { colunaTabela } from './regua';

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
  ESTOQUE_FORA_ESTABELECIMENTO: number;
  ESTOQUE_EM_TERCEIROS: number;
  REF_FABRICANTE: string | null;
  REF_FORNECEDOR: string | null;
  CODIGO_BARRAS: string | null;
  NCM: string | null;
  LOCALIZACAO: string | null;
  COMERCIALIZAVEL: string | null;
  MARCA: string | null;
  SUBGRUPO: string | null;
  GRUPO: string | null;
  PRECO_VENDA: number;
  PRECO1: number; PRECO2: number; PRECO3: number; PRECO4: number; PRECO5: number;
  PRECO6: number; PRECO7: number; PRECO8: number; PRECO9: number; PRECO10: number;
  PRECO_CUSTO: number;
  CUSTO_NOTA: number | null;
  DESCTO_MAXIMO: number | null;
  INATIVO: string | null;
  DT_ULTIMA_COMPRA: string | null;
}

/** Marca, subgrupo e grupo chegam por JOIN (catálogo: `marca`, `subgrupo`, `grupo` via subgrupo). */
const CAMPOS_PRODUTO: Array<string | { campo: string; como: string }> = [
  'PRO_CODIGO', 'PRO_DESCRICAO', 'REFERENCIA', 'REF_FABRICANTE', 'REF_FORNECEDOR', 'UNIDADE', 'APLICACOES',
  'SUBGRP_CODIGO', 'MAR_CODIGO', 'NCM', 'LOCALIZACAO', 'CODIGO_BARRAS', 'COMERCIALIZAVEL',
  'ESTOQUE_DISPONIVEL', 'ESTOQUE_RESERVADO', 'ESTOQUE_FORA_ESTABELECIMENTO', 'ESTOQUE_EM_TERCEIROS',
  'PRECO_VENDA', 'PRECO1', 'PRECO2', 'PRECO3', 'PRECO4', 'PRECO5',
  'PRECO6', 'PRECO7', 'PRECO8', 'PRECO9', 'PRECO10',
  'PRECO_CUSTO', 'CUSTO_NOTA', 'DESCTO_MAXIMO', 'INATIVO', 'DT_ULTIMA_COMPRA',
  { campo: 'marca.MAR_DESCRICAO', como: 'MARCA' },
  { campo: 'subgrupo.SUBGRP_DESCRICAO', como: 'SUBGRUPO' },
  { campo: 'grupo.GRP_DESCRICAO', como: 'GRUPO' },
];
const INCLUIR_PRODUTO = ['marca', 'subgrupo', 'grupo'];

export type ModoBusca = 'comeca' | 'contem';
/** Os "Localizar por" da EST012 do Celta. */
export type CampoBusca =
  | 'descricao'          // Descrição / Código (numérico = código)
  | 'codigo'
  | 'so_descricao'
  | 'referencia'
  | 'ref_fabricante'
  | 'ref_fornecedor'
  | 'codigo_barras'
  | 'aplicacao'
  | 'subgrupo'
  | 'localizacao'
  | 'todas_referencias' // referência OU fabricante OU fornecedor
  | 'marca'
  | 'generica';         // descrição (palavras em qualquer ordem) OU qualquer referência
export interface OpcoesBusca {
  modo?: ModoBusca;
  campo?: CampoBusca;
  comEstoque?: boolean;
  inativos?: boolean;
  comercializavel?: boolean;
  limite?: number;
}

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

/** `YYYY-MM-DD` de um valor de data vindo da API (string ISO ou Date), sem deslocar o dia. */
export function ymdDe(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const hojeYmd = () => ymdDe(new Date()) as string;

export interface PromocaoItem {
  pro_codigo: number;
  prom_codigo: number;
  descricao: string;
  data_final: string;
  somente_avista: boolean;
  durar_estoque: boolean;
  /** Preço promocional NA TABELA DO CLIENTE; null = a promoção não vale para essa tabela. */
  valor: number | null;
  /** Preço promocional do balcão (PROM_VALOR, tabela 1) — informativo, como a EST012 mostra. */
  valor_balcao: number | null;
}

/**
 * A erp-firebird-api considera a resposta TRUNCADA quando o número de linhas
 * é IGUAL ao limite pedido — e o ErpApiService transforma isso em erro. Logo,
 * pedir exatamente o que se espera (1 cliente, N produtos por código) falha
 * justamente quando dá certo. Pede-se sempre uma linha a mais e corta-se aqui.
 */
const FOLGA = 1;

@Injectable()
export class OrcamentoErpRepository {
  private readonly logger = new Logger(OrcamentoErpRepository.name);

  constructor(private readonly erp: ErpApiService) {}

  private normalizarProduto(r: Record<string, any>): ProdutoErp {
    const p: any = { ...r };
    for (const k of ['ESTOQUE_DISPONIVEL', 'ESTOQUE_RESERVADO', 'ESTOQUE_FORA_ESTABELECIMENTO', 'ESTOQUE_EM_TERCEIROS', 'PRECO_VENDA', 'PRECO_CUSTO',
      'PRECO1', 'PRECO2', 'PRECO3', 'PRECO4', 'PRECO5', 'PRECO6', 'PRECO7', 'PRECO8', 'PRECO9', 'PRECO10']) {
      p[k] = num(r[k]);
    }
    p.PRO_CODIGO = Number(r.PRO_CODIGO);
    p.SUBGRP_CODIGO = r.SUBGRP_CODIGO == null ? null : Number(r.SUBGRP_CODIGO);
    p.CUSTO_NOTA = r.CUSTO_NOTA == null ? null : Number(r.CUSTO_NOTA);
    p.DESCTO_MAXIMO = r.DESCTO_MAXIMO == null ? null : Number(r.DESCTO_MAXIMO);
    p.INATIVO = (r.INATIVO ?? '').toString().trim() || null;
    p.COMERCIALIZAVEL = (r.COMERCIALIZAVEL ?? '').toString().trim() || null;
    p.PRO_DESCRICAO = (r.PRO_DESCRICAO ?? '').toString().trim();
    for (const k of ['MARCA', 'SUBGRUPO', 'GRUPO', 'REF_FABRICANTE', 'REF_FORNECEDOR', 'CODIGO_BARRAS', 'NCM', 'LOCALIZACAO', 'REFERENCIA', 'UNIDADE']) {
      p[k] = (r[k] ?? '').toString().trim() || null;
    }
    return p as ProdutoErp;
  }

  /**
   * Busca de produto no padrão da pesquisa do Celta (EST012): todos os
   * "Localizar por" da tela, "Que começa com" ou "Contém", e os filtros (só
   * com estoque, listar inativos, só comercializável). O `%` no termo é
   * curinga, como lá. Em "Descrição / Código" e "Código", termo numérico é o
   * código exato. "Todas as referências" e "Pesquisa genérica" são OU entre
   * colunas — o montador da API só combina filtros com E, então viram
   * consultas paralelas com o resultado unido (sem repetir código).
   */
  async buscarProdutos(termo: string, o: OpcoesBusca = {}): Promise<ProdutoErp[]> {
    const t = termo.trim();
    if (!t) return [];
    const limite = o.limite ?? 60;
    const modo: ModoBusca = o.modo ?? 'comeca';
    const campo: CampoBusca = o.campo ?? 'descricao';
    const base = { empresa: EMPRESA, campos: CAMPOS_PRODUTO, incluir: INCLUIR_PRODUTO, limite: limite + FOLGA };
    const comuns: FiltroErp[] = [];
    if (!o.inativos) comuns.push({ campo: 'INATIVO', op: 'diferente', valor: 'S' });
    if (o.comEstoque) comuns.push({ campo: 'ESTOQUE_DISPONIVEL', op: 'maior', valor: 0 });
    if (o.comercializavel) comuns.push({ campo: 'COMERCIALIZAVEL', op: 'igual', valor: 'S' });

    const consultar = async (filtros: FiltroErp[]) =>
      this.erp.consultar<Record<string, any>>('produtos', {
        ...base,
        filtros: [...filtros, ...comuns],
        ordenar: [{ campo: 'PRO_DESCRICAO', dir: 'asc' }],
      });

    if ((campo === 'descricao' || campo === 'codigo') && /^\d+$/.test(t)) {
      const r = await this.erp.consultar<Record<string, any>>('produtos', {
        ...base,
        filtros: [{ campo: 'PRO_CODIGO', op: 'igual', valor: Number(t) }],
        limite: 1 + FOLGA,
      });
      return r.slice(0, 1).map((x) => this.normalizarProduto(x));
    }
    if (campo === 'codigo') return [];

    const T = t.toUpperCase();
    const padrao = modo === 'comeca' ? (T.endsWith('%') ? T : `${T}%`) : `%${T.replace(/^%+|%+$/g, '')}%`;
    const parecido = (coluna: string): FiltroErp[] => [{ campo: coluna, op: 'parecido', valor: padrao }];
    // Sem "%" e no modo "contém", cada palavra vira um "contém" (E): acha "amarok brisa" em qualquer ordem.
    const palavras = (coluna: string): FiltroErp[] =>
      T.includes('%') || modo === 'comeca'
        ? parecido(coluna)
        : T.split(/\s+/).filter((p) => p.length >= 3).slice(0, 6).map<FiltroErp>((p) => ({ campo: coluna, op: 'contem', valor: p }));

    const COLUNA: Partial<Record<CampoBusca, string>> = {
      descricao: 'PRO_DESCRICAO',
      so_descricao: 'PRO_DESCRICAO',
      referencia: 'REFERENCIA',
      ref_fabricante: 'REF_FABRICANTE',
      ref_fornecedor: 'REF_FORNECEDOR',
      codigo_barras: 'CODIGO_BARRAS',
      aplicacao: 'APLICACOES',
      localizacao: 'LOCALIZACAO',
      subgrupo: 'subgrupo.SUBGRP_DESCRICAO',
      marca: 'marca.MAR_DESCRICAO',
    };

    let lotes: FiltroErp[][];
    if (campo === 'todas_referencias') {
      lotes = [parecido('REFERENCIA'), parecido('REF_FABRICANTE'), parecido('REF_FORNECEDOR')];
    } else if (campo === 'generica') {
      const desc = palavras('PRO_DESCRICAO');
      lotes = [...(desc.length ? [desc] : []), parecido('REFERENCIA'), parecido('REF_FABRICANTE'), parecido('REF_FORNECEDOR'), parecido('APLICACOES')];
    } else {
      const coluna = COLUNA[campo] ?? 'PRO_DESCRICAO';
      const f = campo === 'descricao' || campo === 'so_descricao' || campo === 'aplicacao' ? palavras(coluna) : parecido(coluna);
      if (!f.length) return [];
      lotes = [f];
    }
    const resultados = await Promise.all(lotes.map((f) => consultar(f).catch((e) => { this.logger.warn(`busca ${campo}: ${(e as Error).message}`); return [] as Record<string, any>[]; })));
    const vistos = new Set<number>();
    const saida: ProdutoErp[] = [];
    for (const r of resultados) {
      for (const x of r) {
        const cod = Number(x.PRO_CODIGO);
        if (vistos.has(cod)) continue;
        vistos.add(cod);
        saida.push(this.normalizarProduto(x));
      }
    }
    return saida.slice(0, limite);
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
        incluir: INCLUIR_PRODUTO,
        filtros: [{ campo: 'PRO_CODIGO', op: 'em', valor: lote }],
        limite: lote.length + FOLGA,
        semCache: true, // saldo é a pergunta — nunca servir de cache
      });
      saida.push(...r.map((x) => this.normalizarProduto(x)));
    }
    return saida;
  }

  /**
   * Promoções VIGENTES (ATIVA = 'S' e hoje dentro do período) que valem para a
   * TABELA DO CLIENTE: o preço promocional é por tabela (PROM_VALOR2 para a 2,
   * PROM_VALOR5 para a 5…) e coluna zerada significa "não vale para esta
   * tabela". Quase toda promoção do Celta é do balcão (PROM_VALOR); a do
   * atacado é exceção — por isso PROM_VALOR nunca é usado para cliente 2/5.
   * Produto em mais de uma promoção: fica a de menor preço.
   */
  async promocoesVigentes(codigos: number[], tabelaPreco: string | null): Promise<Map<number, PromocaoItem>> {
    const saida = new Map<number, PromocaoItem>();
    const unicos = [...new Set(codigos.filter((c) => Number.isFinite(c)))];
    if (!unicos.length) return saida;
    const col = colunaTabela(tabelaPreco);
    const colPromo = col === 'PRECO_VENDA' ? 'PROM_VALOR' : col.replace('PRECO', 'PROM_VALOR');
    const hoje = hojeYmd();

    const promos = await this.erp.consultar<Record<string, any>>('promocoes', {
      empresa: EMPRESA,
      campos: ['PROM_CODIGO', 'PROM_DESCRICAO', 'DATA_FINAL', 'SOMENTE_AVISTA', 'DURAR_ESTOQUE'],
      filtros: [
        { campo: 'ATIVA', op: 'igual', valor: 'S' },
        { campo: 'DATA_INICIAL', op: 'menor_igual', valor: hoje },
        { campo: 'DATA_FINAL', op: 'maior_igual', valor: hoje },
      ],
      limite: 500 + FOLGA,
    });
    if (!promos.length) return saida;
    const cab = new Map(promos.map((p) => [Number(p.PROM_CODIGO), p]));

    const itens: Record<string, any>[] = [];
    for (let i = 0; i < unicos.length; i += 500) {
      const lote = unicos.slice(i, i + 500);
      const r = await this.erp.consultar<Record<string, any>>('promocoes-itens', {
        empresa: EMPRESA,
        campos: [...new Set(['PRO_CODIGO', 'PROM_CODIGO', colPromo, 'PROM_VALOR'])],
        filtros: [
          { campo: 'PROM_CODIGO', op: 'em', valor: [...cab.keys()] },
          { campo: 'PRO_CODIGO', op: 'em', valor: lote },
        ],
        limite: 5000 + FOLGA,
        semCache: true,
      });
      itens.push(...r);
    }
    // Prioridade: promoção com preço NA TABELA DO CLIENTE (menor preço). Sem
    // nenhuma, fica a do balcão só como informação (a EST012 mostra "de/por"
    // do varejo mesmo para cliente de atacado) — nunca aplicada ao preço.
    for (const it of itens) {
      const valor = num(it[colPromo]);
      const balcao = num(it.PROM_VALOR);
      if (!(valor > 0) && !(balcao > 0)) continue;
      const p = cab.get(Number(it.PROM_CODIGO));
      if (!p) continue;
      const pro = Number(it.PRO_CODIGO);
      const atual = saida.get(pro);
      const candidato: PromocaoItem = {
        pro_codigo: pro,
        prom_codigo: Number(it.PROM_CODIGO),
        descricao: String(p.PROM_DESCRICAO ?? '').trim(),
        data_final: ymdDe(p.DATA_FINAL) ?? hoje,
        somente_avista: String(p.SOMENTE_AVISTA ?? '').trim() === 'S',
        durar_estoque: String(p.DURAR_ESTOQUE ?? '').trim() === 'S',
        valor: valor > 0 ? Math.round(valor * 100) / 100 : null,
        valor_balcao: balcao > 0 ? Math.round(balcao * 100) / 100 : null,
      };
      if (!atual) { saida.set(pro, candidato); continue; }
      const melhor =
        candidato.valor != null && (atual.valor == null || candidato.valor < atual.valor)
          ? candidato
          : candidato.valor == null && atual.valor == null && candidato.valor_balcao != null && (atual.valor_balcao == null || candidato.valor_balcao < atual.valor_balcao)
            ? candidato
            : atual;
      saida.set(pro, melhor);
    }
    return saida;
  }

  /* ------------------------------------------------------------ imagens */

  /** IDs das fotos do produto (ordem 0 = produto, 1 = veículo). */
  imagensDoProduto(codigo: number): Promise<Array<{ id_imagem: number; ordem: number }>> {
    return this.erp.obterJson(`/erp/produtos/${codigo}/imagens?empresa=${EMPRESA}`);
  }

  /** Binário da foto, repassado como veio (Content-Type sniffado pela API). */
  imagem(id: number) {
    return this.erp.obterBinario(`/erp/imagens/${id}`);
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
