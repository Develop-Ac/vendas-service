import { Injectable } from '@nestjs/common';
import { MssqlService } from 'src/common/mssql/mssql.service';

export interface ItemMaisVendido {
  pro_codigo: number;
  descricao: string;
  unidades: number;
  notas: number;
  receita: number;
  estoque: number;
}

/**
 * Universo atacado — o mesmo critério da carteirização.
 * 2 = atacado especial, 5 = atacado. Varejo fica de fora.
 */
const TABELAS_ATACADO = ['2', '5'];

/** Empresa do atacado. `Stage_Produtos` só tem a 3, mas o filtro é explícito. */
const EMPRESA_ATACADO = 3;

/**
 * Critérios de ordenação aceitos, e a expressão SQL de cada um.
 *
 * `notas` é o padrão: conta em **quantos pedidos distintos** a peça saiu, ou
 * seja, quantos lojistas diferentes a compraram. É o que "mais vendido"
 * significa numa vitrine.
 *
 * `unidades` soma peça a peça. Parece o critério óbvio e não é: medido nos
 * dados reais (12 meses de atacado), nove dos dez primeiros são grampo e
 * parafuso — item de centavos vendido em pacote de mil. Continua disponível
 * porque é uma escolha de negócio, não um defeito.
 *
 * `receita` ordena por faturamento e devolve uma vitrine só de para-brisa de
 * caminhão e picape nova.
 */
const CRITERIOS = {
  notas: 've.notas',
  unidades: 've.unidades',
  receita: 've.receita',
} as const;

export type CriterioMaisVendidos = keyof typeof CRITERIOS;

export const CRITERIO_PADRAO: CriterioMaisVendidos = 'notas';

export function criterioValido(valor?: string): CriterioMaisVendidos {
  return valor && valor in CRITERIOS
    ? (valor as CriterioMaisVendidos)
    : CRITERIO_PADRAO;
}

@Injectable()
export class MaisVendidosSqlServerRepository {
  constructor(private readonly mssql: MssqlService) {}

  /**
   * Os mais vendidos no atacado que **têm estoque para entregar**.
   *
   * Três decisões que o SQL não explica sozinho:
   *
   * 1. **`QUANTIDADE - QTDE_DEVOLVIDA`** e `DT_CANCELAMENTO IS NULL`: venda
   *    devolvida ou nota cancelada não é venda. Sem isso, uma devolução em
   *    massa continuaria empurrando a peça para o topo.
   * 2. **A nota é `EMPRESA + SERIE + NFS`**, não só `NFS`: o número da nota
   *    reinicia por série e por empresa, e contar só o `NFS` juntaria notas
   *    diferentes na mesma contagem.
   * 3. **`BLOQUEAR_VENDA` NÃO entra no filtro.** A coluna está marcada `'S'`
   *    em 43.180 dos 44.504 produtos do cadastro — ela não significa "bloqueado
   *    para venda" na prática. Usá-la derrubava o resultado de 3.888 peças para
   *    **6**. Quem filtra produto morto aqui é `INATIVO`.
   */
  async apurar(
    criterio: CriterioMaisVendidos,
    meses: number,
    limite: number,
  ): Promise<ItemMaisVendido[]> {
    const inList = TABELAS_ATACADO.map((t) => `'${t}'`).join(',');

    /*
     * `criterio` e `limite` entram interpolados porque `TOP` e `ORDER BY` não
     * aceitam parâmetro no T-SQL. Nenhum dos dois vem de fora: o critério é
     * validado contra o mapa `CRITERIOS` e o limite é um inteiro do próprio
     * serviço. `meses` vai como parâmetro de verdade.
     */
    const ordem = CRITERIOS[criterio];

    return this.mssql.query<ItemMaisVendido>(
      `
      WITH atac AS (
        SELECT cli_codigo FROM dbo.vw_clientes WHERE tabela_preco IN (${inList})
      ),
      vendas AS (
        SELECT v.PRO_CODIGO,
               SUM(v.QUANTIDADE - ISNULL(v.QTDE_DEVOLVIDA, 0)) AS unidades,
               COUNT(DISTINCT CONCAT(v.EMPRESA, '-', v.SERIE, '-', v.NFS)) AS notas,
               SUM(v.liquido_produto) AS receita
        FROM dbo.vw_analise_vendas v
        WHERE v.DT_CANCELAMENTO IS NULL
          AND v.dt_emissao_convertida >= DATEADD(MONTH, -@meses, CAST(GETDATE() AS date))
          AND v.CLI_CODIGO IN (SELECT cli_codigo FROM atac)
        GROUP BY v.PRO_CODIGO
        HAVING SUM(v.QUANTIDADE - ISNULL(v.QTDE_DEVOLVIDA, 0)) > 0
      )
      SELECT TOP ${limite}
             ve.PRO_CODIGO                        AS pro_codigo,
             p.PRO_DESCRICAO                      AS descricao,
             CAST(ve.unidades AS INT)             AS unidades,
             ve.notas                             AS notas,
             CAST(ve.receita AS DECIMAL(14, 2))   AS receita,
             CAST(p.ESTOQUE_DISPONIVEL AS INT)    AS estoque
      FROM vendas ve
      JOIN dbo.Stage_Produtos p
        ON p.PRO_CODIGO = ve.PRO_CODIGO
       AND p.EMPRESA = @empresa
      WHERE p.ESTOQUE_DISPONIVEL > 0
        AND p.INATIVO <> 'S'
      ORDER BY ${ordem} DESC
      `,
      { meses, empresa: EMPRESA_ATACADO },
    );
  }
}
