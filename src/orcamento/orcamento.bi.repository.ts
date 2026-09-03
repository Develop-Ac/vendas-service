import { Injectable } from '@nestjs/common';
import { MssqlService } from '../common/mssql/mssql.service';

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
  mix1_liquido: number;
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
   * `total_item` é o valor líquido do item; `total_desconto` vem NEGATIVO na
   * view — por isso o desconto sai com sinal trocado e o bruto é líquido + desconto.
   */
  async bolsaVendedor(rep: number, ano: number, mes: number): Promise<BolsaVendedorRow> {
    const rows = await this.mssql.query<BolsaVendedorRow>(
      `
      SELECT COUNT(DISTINCT CONCAT(v.EMPRESA,'-',v.SERIE,'-',v.NFS)) AS notas,
             COALESCE(SUM(v.total_item), 0)                          AS venda_liquida,
             COALESCE(-SUM(v.total_desconto), 0)                     AS desconto,
             COALESCE(SUM(CASE WHEN v.MIX_CUSTO = 1 THEN v.total_item END), 0) AS mix1_liquido
      FROM dbo.vw_analise_vendas v
      WHERE v.vendedor_venda = @rep
        AND v.mes_comissional = @mes
        AND v.ano_comissional = @ano
        AND v.local_venda = 'ATACADO'
        AND v.DT_CANCELAMENTO IS NULL
      `,
      { rep, mes, ano },
    );
    const r = rows[0] ?? { notas: 0, venda_liquida: 0, desconto: 0, mix1_liquido: 0 };
    return {
      notas: Number(r.notas ?? 0),
      venda_liquida: Number(r.venda_liquida ?? 0),
      desconto: Number(r.desconto ?? 0),
      mix1_liquido: Number(r.mix1_liquido ?? 0),
    };
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
