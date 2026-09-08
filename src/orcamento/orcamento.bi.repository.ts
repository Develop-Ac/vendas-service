import { Injectable } from '@nestjs/common';
import { MssqlService } from '../common/mssql/mssql.service';
import { MesDre } from './regua';
import { CelulaComissao, ConfigComissao } from './comissao';

/* =============================================================================
   ORÇAMENTO — leitura no BI (SQL Server, somente leitura).
   -----------------------------------------------------------------------------
   O que a tela pergunta ao BI é sempre HISTÓRICO consolidado:
     - a bolsa de desconto do vendedor no mês comissional (26 a 25);
     - o resumo do cliente (crédito em aberto, faturamento, último preço pago);
     - os pares "vendem juntos" do atacado (apuração semanal).
   Saldo e preço de tabela NÃO vêm daqui — vêm do ERP ao vivo.
   ============================================================================= */

export interface BolsaVendedorRow {
  notas: number;
  venda_liquida: number;
  desconto: number;
  custo: number;
  mix1_liquido: number;
}

export interface BolsaClienteRow {
  cli_codigo: number;
  cli_nome: string;
  venda_liquida: number;
  desconto: number;
  custo: number;
}

export interface ResumoClienteBi {
  faturamento_12m: number;
  pedidos_12m: number;
  ult_compra: string | null;
  valor_em_aberto: number;
  titulos_vencidos: number;
  crediario: string | null;
  limite_credito: number;
  desconto_padrao: number | null;
}

export interface UltimoPrecoRow {
  pro_codigo: number;
  dt_emissao: string;
  unitario: number;
  quantidade: number;
}

export interface ParRelacionado {
  pro_codigo: number;
  pro_relacionado: number;
  juntos: number;
  base: number;
}

export interface ParSubgrupo {
  subgrp_codigo: number;
  pro_relacionado: number;
  juntos: number;
  base: number;
}

/**
 * Mês comissional: fecha no dia 25. De 26 em diante já é o mês seguinte —
 * a mesma convenção de vw_analise_vendas (mes_comissional / ano_comissional).
 */
export function mesComissional(hoje = new Date()): { ano: number; mes: number; inicio: string; fim: string } {
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth() + 1;
  if (hoje.getDate() >= 26) {
    mes += 1;
    if (mes === 13) { mes = 1; ano += 1; }
  }
  const ini = new Date(ano, mes - 2, 26);
  const fim = new Date(ano, mes - 1, 25);
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { ano, mes, inicio: ymd(ini), fim: ymd(fim) };
}

@Injectable()
export class OrcamentoBiRepository {
  constructor(private readonly mssql: MssqlService) {}

  /**
   * Venda do vendedor no mês comissional corrente, no canal ATACADO.
   * A base é `liquido_produto` (quantidade × unitário − desconto do item − rateio
   * do desconto da nota; devolução entra NEGATIVA), a mesma do painel e da
   * comissão. NÃO usar `total_item`: é o TOTAL do item do ERP, que ignora o
   * desconto dado na nota e soma a devolução como venda — inflava a bolsa.
   * `total_desconto` vem NEGATIVO na view, por isso o sinal trocado; o custo
   * (`custo_produto`) já vem negativo na devolução.
   */
  async bolsaVendedor(rep: number, ano: number, mes: number): Promise<BolsaVendedorRow> {
    const rows = await this.mssql.query<BolsaVendedorRow>(
      `
      SELECT COUNT(DISTINCT CONCAT(v.EMPRESA,'-',v.SERIE,'-',v.NFS)) AS notas,
             COALESCE(SUM(v.liquido_produto), 0)                     AS venda_liquida,
             COALESCE(-SUM(v.total_desconto), 0)                     AS desconto,
             COALESCE(SUM(v.custo_produto), 0)                       AS custo,
             COALESCE(SUM(CASE WHEN v.MIX_CUSTO = 1 THEN v.liquido_produto END), 0) AS mix1_liquido
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda = @rep
        AND v.mes_comissional = @mes
        AND v.ano_comissional = @ano
        AND v.local_venda = 'ATACADO'
        AND v.DT_CANCELAMENTO IS NULL
      `,
      { rep, mes, ano },
    );
    const r = rows[0] ?? { notas: 0, venda_liquida: 0, desconto: 0, custo: 0, mix1_liquido: 0 };
    return {
      notas: Number(r.notas ?? 0),
      venda_liquida: Number(r.venda_liquida ?? 0),
      desconto: Number(r.desconto ?? 0),
      custo: Number(r.custo ?? 0),
      mix1_liquido: Number(r.mix1_liquido ?? 0),
    };
  }

  /**
   * Venda líquida do vendedor no mês comissional por (mix, faixa) — as células
   * da comissão do atacado, a mesma leitura do fechamento (liquido_produto).
   */
  async celulasComissao(rep: number, ano: number, mes: number): Promise<CelulaComissao[]> {
    const rows = await this.mssql.query<{ mix: number; faixa: string; valor: number }>(
      `
      SELECT v.MIX_CUSTO AS mix, v.FAIXA_MIX AS faixa, COALESCE(SUM(v.liquido_produto), 0) AS valor
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda = @rep
        AND v.mes_comissional = @mes
        AND v.ano_comissional = @ano
        AND v.local_venda = 'ATACADO'
        AND v.DT_CANCELAMENTO IS NULL
      GROUP BY v.MIX_CUSTO, v.FAIXA_MIX
      `,
      { rep, mes, ano },
    );
    return rows.map((r) => ({ mix: Number(r.mix ?? 0), faixa: String(r.faixa ?? '').trim().toUpperCase(), valor: Number(r.valor ?? 0) }));
  }

  private cfgComissao: { em: number; cfg: ConfigComissao } | null = null;

  /** Tabelas da comissão do atacado (as mesmas do fechamento), com cache de 10 minutos. */
  async parametrosComissao(): Promise<ConfigComissao> {
    if (this.cfgComissao && Date.now() - this.cfgComissao.em < 10 * 60 * 1000) return this.cfgComissao.cfg;
    const [m1, m23, meta] = await Promise.all([
      this.mssql.query<{ faixa: string; atingiu_meta: boolean | number; percentual: number }>(
        `SELECT faixa, atingiu_meta, percentual FROM dbo.ComissaoAtacadoFaixaMix1 WHERE ativo = 1`,
      ),
      this.mssql.query<{ valor_min: number; valor_max: number; percentual: number }>(
        `SELECT valor_min, valor_max, percentual FROM dbo.ComissaoAtacadoFaixaMix23 WHERE ativo = 1 ORDER BY valor_max`,
      ),
      this.mssql.query<{ meta_mix1: number }>(`SELECT meta_mix1 FROM dbo.ComissaoAtacadoConfig WHERE id = 1`),
    ]);
    const cfg: ConfigComissao = {
      faixasMix1: m1.map((f) => ({ faixa: String(f.faixa ?? '').trim().toUpperCase(), atingiu_meta: !!Number(f.atingiu_meta), percentual: Number(f.percentual) })),
      faixasMix23: m23.map((f) => ({ valor_min: Number(f.valor_min), valor_max: Number(f.valor_max), percentual: Number(f.percentual) })),
      metaMix1: meta.length ? Number(meta[0].meta_mix1) : 0.3,
    };
    this.cfgComissao = { em: Date.now(), cfg };
    return cfg;
  }

  /**
   * DRE mensal do canal ATACADO (f_dre_base + receita bruta contábil), últimos
   * `meses` + 3 de folga — o piso da bolsa é calculado dela. Mês "fechado" =
   * tem custo e despesa com pessoal contabilizados (pessoal é o último grupo a
   * fechar; o mês corrente e o anterior costumam estar abertos).
   */
  async dreCanalMensal(meses = 12): Promise<MesDre[]> {
    const rows = await this.mssql.query<{ ano: number; mes: number; grupo: string; valor: number }>(
      `
      SELECT b.ANO AS ano, b.MES AS mes, b.GRUPO_SINTETICO_DRE AS grupo, SUM(b.VALOR_CONVERTIDO) AS valor
      FROM dbo.f_dre_base b
      WHERE b.LOCAL_VENDA = 'ATACADO'
        AND b.DATA_COMPETENCIA >= DATEADD(month, -@n, CAST(GETDATE() AS date))
      GROUP BY b.ANO, b.MES, b.GRUPO_SINTETICO_DRE
      `,
      { n: meses + 3 },
    );
    const rb = await this.mssql.query<{ ano: number; mes: number; valor: number }>(
      `
      SELECT r.ANO AS ano, r.MES AS mes, SUM(r.RECEITA_BRUTA_CONTABIL) AS valor
      FROM dbo.f_receita_bruta_contabil_canal_mensal r
      WHERE r.LOCAL_VENDA = 'ATACADO'
      GROUP BY r.ANO, r.MES
      `,
    );
    const porMes = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const k = `${Number(r.ano)}-${Number(r.mes)}`;
      const g = porMes.get(k) ?? {};
      g[String(r.grupo)] = (g[String(r.grupo)] ?? 0) + Number(r.valor ?? 0);
      porMes.set(k, g);
    }
    const receita = new Map(rb.map((r) => [`${Number(r.ano)}-${Number(r.mes)}`, Number(r.valor ?? 0)]));
    const v = (g: Record<string, number>, nome: string) => Number(g[nome] ?? 0);
    const out: MesDre[] = [];
    for (const [k, g] of porMes) {
      const [ano, mes] = k.split('-').map(Number);
      const cmv = -v(g, 'Custo dos produtos e serviços vendidos');
      const pessoal = -v(g, 'Despesa Com Pessoal');
      out.push({
        ano, mes,
        receita_bruta: receita.get(k) ?? 0,
        abatimento: -v(g, 'Abatimento de Receita Bruta'),
        cmv,
        comerciais: -v(g, 'Despesas Comerciais'),
        fixas: pessoal - v(g, 'Despesas Com Ocupação') - v(g, 'Despesas Gerais e Administrativas') - v(g, 'Despesas com Veículos')
          - v(g, 'Despesas Tributárias') - v(g, 'Resultado Financeiro') - v(g, 'Outras Receitas e Despesas Operacionais Líquidas'),
        fechado: cmv > 0 && pessoal > 0 && (receita.get(k) ?? 0) > 0,
      });
    }
    return out.sort((a, b) => a.ano * 100 + a.mes - (b.ano * 100 + b.mes));
  }

  /**
   * Receita líquida média por mês do canal ATACADO nos 3 meses comissionais
   * FECHADOS antes de (ano, mes) — decide o degrau do piso da bolsa. Base
   * `liquido_produto`, como a bolsa.
   */
  async volumeCanal3m(ano: number, mes: number): Promise<{ media_mes: number; meses: { ano: number; mes: number; receita: number }[] }> {
    const chaves: { ano: number; mes: number }[] = [];
    let a = ano, m = mes;
    for (let i = 0; i < 3; i++) {
      m -= 1;
      if (m === 0) { m = 12; a -= 1; }
      chaves.push({ ano: a, mes: m });
    }
    const rows = await this.mssql.query<{ ano: number; mes: number; receita: number }>(
      `
      SELECT v.ano_comissional AS ano, v.mes_comissional AS mes, COALESCE(SUM(v.liquido_produto), 0) AS receita
      FROM dbo.vw_analise_vendas v
      WHERE v.local_venda = 'ATACADO'
        AND v.DT_CANCELAMENTO IS NULL
        AND (
          (v.ano_comissional = @a1 AND v.mes_comissional = @m1) OR
          (v.ano_comissional = @a2 AND v.mes_comissional = @m2) OR
          (v.ano_comissional = @a3 AND v.mes_comissional = @m3)
        )
      GROUP BY v.ano_comissional, v.mes_comissional
      `,
      { a1: chaves[0].ano, m1: chaves[0].mes, a2: chaves[1].ano, m2: chaves[1].mes, a3: chaves[2].ano, m3: chaves[2].mes },
    );
    const meses = chaves.map((c) => ({
      ...c,
      receita: Number(rows.find((r) => Number(r.ano) === c.ano && Number(r.mes) === c.mes)?.receita ?? 0),
    }));
    return { media_mes: meses.reduce((s, x) => s + x.receita, 0) / 3, meses };
  }

  /**
   * A mesma venda do mês, por cliente — para o vendedor ver quem "gerou" a bolsa
   * (o saldo é dele, não do cliente; o rateio é só informação).
   */
  async bolsaPorCliente(rep: number, ano: number, mes: number): Promise<BolsaClienteRow[]> {
    const rows = await this.mssql.query<BolsaClienteRow>(
      `
      SELECT v.CLI_CODIGO                                   AS cli_codigo,
             MAX(v.CLI_NOME)                                AS cli_nome,
             COALESCE(SUM(v.liquido_produto), 0)            AS venda_liquida,
             COALESCE(-SUM(v.total_desconto), 0)            AS desconto,
             COALESCE(SUM(v.custo_produto), 0)              AS custo
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda = @rep
        AND v.mes_comissional = @mes
        AND v.ano_comissional = @ano
        AND v.local_venda = 'ATACADO'
        AND v.DT_CANCELAMENTO IS NULL
      GROUP BY v.CLI_CODIGO
      `,
      { rep, mes, ano },
    );
    return rows.map((r) => ({
      cli_codigo: Number(r.cli_codigo),
      cli_nome: String(r.cli_nome ?? ''),
      venda_liquida: Number(r.venda_liquida ?? 0),
      desconto: Number(r.desconto ?? 0),
      custo: Number(r.custo ?? 0),
    }));
  }

  /** Crédito em aberto, faturamento e última compra do cliente. */
  async resumoCliente(cli: number): Promise<ResumoClienteBi> {
    const rows = await this.mssql.query<any>(
      `
      WITH fat AS (
        SELECT SUM(n.valor_nota) AS faturamento_12m, COUNT(*) AS pedidos_12m, MAX(n.dia) AS ult_compra
        FROM (
          SELECT v.EMPRESA, v.SERIE, v.NFS, MAX(v.TOTAL_NOTA) AS valor_nota,
                 MAX(CAST(v.dt_emissao_convertida AS date)) AS dia
          FROM dbo.vw_analise_vendas v
          WHERE v.CLI_CODIGO = @cli AND v.DT_CANCELAMENTO IS NULL
            AND v.dt_emissao_convertida >= DATEADD(MONTH, -12, CAST(GETDATE() AS date))
          GROUP BY v.EMPRESA, v.SERIE, v.NFS
        ) n
      ),
      aberto AS (
        SELECT SUM(VALOR - VALOR_LIQUIDO_PAGO) AS valor_em_aberto,
               SUM(CASE WHEN VENCIMENTO < CAST(GETDATE() AS date) THEN 1 ELSE 0 END) AS titulos_vencidos
        FROM dbo.Stage_ContasReceber_Titulos
        WHERE CLI_CODIGO = @cli AND status = 0 AND DATA_PAGTO IS NULL
      )
      SELECT COALESCE(f.faturamento_12m, 0) AS faturamento_12m,
             COALESCE(f.pedidos_12m, 0)     AS pedidos_12m,
             f.ult_compra,
             COALESCE(a.valor_em_aberto, 0) AS valor_em_aberto,
             COALESCE(a.titulos_vencidos, 0) AS titulos_vencidos,
             sc.CREDIARIO                    AS crediario,
             COALESCE(sc.LIMITE_CREDITO, 0)  AS limite_credito,
             sc.DESCONTO_PADRAO              AS desconto_padrao
      FROM fat f
      CROSS JOIN aberto a
      LEFT JOIN dbo.Stage_Clientes sc ON sc.cli_codigo = @cli AND sc.EMPRESA = 3
      `,
      { cli },
    );
    const r = rows[0] ?? {};
    return {
      faturamento_12m: Number(r.faturamento_12m ?? 0),
      pedidos_12m: Number(r.pedidos_12m ?? 0),
      ult_compra: r.ult_compra ? new Date(r.ult_compra).toISOString().slice(0, 10) : null,
      valor_em_aberto: Number(r.valor_em_aberto ?? 0),
      titulos_vencidos: Number(r.titulos_vencidos ?? 0),
      crediario: r.crediario ?? null,
      limite_credito: Number(r.limite_credito ?? 0),
      desconto_padrao: r.desconto_padrao == null ? null : Number(r.desconto_padrao),
    };
  }

  /** Último preço unitário pago por este cliente em cada produto (argumento de negociação). */
  async ultimosPrecosCliente(cli: number, codigos: number[]): Promise<UltimoPrecoRow[]> {
    const lista = [...new Set(codigos.filter((c) => Number.isFinite(c)))].slice(0, 500);
    if (!lista.length) return [];
    const rows = await this.mssql.query<any>(
      `
      SELECT pro_codigo, dt_emissao, unitario, quantidade FROM (
        SELECT v.PRO_CODIGO AS pro_codigo,
               CAST(v.dt_emissao_convertida AS date) AS dt_emissao,
               v.UNITARIO AS unitario, v.QUANTIDADE AS quantidade,
               ROW_NUMBER() OVER (PARTITION BY v.PRO_CODIGO ORDER BY v.dt_emissao_convertida DESC, v.NFS DESC) AS rn
        FROM dbo.vw_analise_vendas v
        WHERE v.CLI_CODIGO = @cli AND v.DT_CANCELAMENTO IS NULL
          AND v.PRO_CODIGO IN (${lista.join(',')})
      ) t WHERE rn = 1
      `,
      { cli },
    );
    return rows.map((r: any) => ({
      pro_codigo: Number(r.pro_codigo),
      dt_emissao: new Date(r.dt_emissao).toISOString().slice(0, 10),
      unitario: Number(r.unitario ?? 0),
      quantidade: Number(r.quantidade ?? 0),
    }));
  }

  /**
   * Pares "vendem juntos" do atacado nos últimos N meses: notas em que os dois
   * itens saíram na mesma nota. Só pares com ≥ `minimo` ocorrências — abaixo
   * disso é coincidência, não padrão. Roda semanalmente (cron), nunca na tela.
   */
  async paresVendemJuntos(meses = 12, minimo = 3): Promise<ParRelacionado[]> {
    // Tabela temporária de propósito: como CTE, o conjunto de notas era
    // recalculado nos dois lados do self-join e na base — mais de 2 minutos.
    // Materializado e indexado por nota, a mesma apuração leva < 1 segundo.
    const rows = await this.mssql.query<any>(
      `
      SET NOCOUNT ON;
      SELECT DISTINCT CONCAT(v.EMPRESA,'-',v.SERIE,'-',v.NFS) AS nota, v.PRO_CODIGO
      INTO #n
      FROM dbo.vw_analise_vendas v
      WHERE v.EMPRESA = 3 AND v.local_venda = 'ATACADO' AND v.DT_CANCELAMENTO IS NULL
        AND v.dt_emissao_convertida >= DATEADD(MONTH, -@meses, CAST(GETDATE() AS date));
      CREATE CLUSTERED INDEX ix_n ON #n (nota, PRO_CODIGO);
      SELECT PRO_CODIGO, COUNT(*) AS notas INTO #base FROM #n GROUP BY PRO_CODIGO;
      SELECT a.PRO_CODIGO AS pro_codigo, b.PRO_CODIGO AS pro_relacionado,
             COUNT(*) AS juntos, MAX(ba.notas) AS base
      FROM #n a
      JOIN #n b ON b.nota = a.nota AND b.PRO_CODIGO <> a.PRO_CODIGO
      JOIN #base ba ON ba.PRO_CODIGO = a.PRO_CODIGO
      GROUP BY a.PRO_CODIGO, b.PRO_CODIGO
      HAVING COUNT(*) >= @minimo;
      DROP TABLE #base; DROP TABLE #n;
      `,
      { meses, minimo },
    );
    return rows.map((r: any) => ({
      pro_codigo: Number(r.pro_codigo),
      pro_relacionado: Number(r.pro_relacionado),
      juntos: Number(r.juntos),
      base: Number(r.base),
    }));
  }

  /**
   * Pares no nível do SUBGRUPO: para cada subgrupo, os produtos de OUTRO
   * subgrupo que saem na mesma nota. `juntos` conta notas distintas (uma nota
   * com três para-brisas e uma cola conta uma vez), `base` é o total de notas
   * em que o subgrupo saiu.
   */
  async paresSubgrupoVendemJuntos(meses = 12, minimo = 5): Promise<ParSubgrupo[]> {
    const rows = await this.mssql.query<any>(
      `
      SET NOCOUNT ON;
      SELECT DISTINCT CONCAT(v.EMPRESA,'-',v.SERIE,'-',v.NFS) AS nota, v.PRO_CODIGO, v.SUBGRP_CODIGO
      INTO #n
      FROM dbo.vw_analise_vendas v
      WHERE v.EMPRESA = 3 AND v.local_venda = 'ATACADO' AND v.DT_CANCELAMENTO IS NULL
        AND v.SUBGRP_CODIGO IS NOT NULL
        AND v.dt_emissao_convertida >= DATEADD(MONTH, -@meses, CAST(GETDATE() AS date));
      CREATE CLUSTERED INDEX ix_n ON #n (nota, PRO_CODIGO);
      SELECT SUBGRP_CODIGO, COUNT(DISTINCT nota) AS notas INTO #sg FROM #n GROUP BY SUBGRP_CODIGO;
      SELECT a.SUBGRP_CODIGO AS subgrp_codigo, b.PRO_CODIGO AS pro_relacionado,
             COUNT(DISTINCT a.nota) AS juntos, MAX(sg.notas) AS base
      FROM #n a
      JOIN #n b ON b.nota = a.nota AND b.SUBGRP_CODIGO <> a.SUBGRP_CODIGO
      JOIN #sg sg ON sg.SUBGRP_CODIGO = a.SUBGRP_CODIGO
      GROUP BY a.SUBGRP_CODIGO, b.PRO_CODIGO
      HAVING COUNT(DISTINCT a.nota) >= @minimo;
      DROP TABLE #sg; DROP TABLE #n;
      `,
      { meses, minimo },
    );
    return rows.map((r: any) => ({
      subgrp_codigo: Number(r.subgrp_codigo),
      pro_relacionado: Number(r.pro_relacionado),
      juntos: Number(r.juntos),
      base: Number(r.base),
    }));
  }
}
