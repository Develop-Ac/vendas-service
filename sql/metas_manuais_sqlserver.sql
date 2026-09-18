/* =====================================================================
   Metas manuais do vendedor no BI (SQL Server, base BI) — aplicar MANUALMENTE.

   A meta editada em Vendas > Representantes > Meta & Performance fica no
   Postgres (ven_meta_vendedor). Os cards do Metabase leem só
   dbo.f_metas_vendedores, que é carregada da planilha por
   sp_ImportarMetasDoExcel (apaga e reinsere todos os meses da planilha).

   Este script cria:
     1. dbo.f_metas_vendedores_manual  — metas manuais, preservadas entre importações;
     2. dbo.sp_AplicarMetasManuais     — sobrepõe as manuais em f_metas_vendedores;
     3. dbo.sp_GravarMetaManual        — ponto único de escrita do vendas-service;
     4. sp_ImportarMetasDoExcel reaplicando as manuais ao final;
     5. carga das metas manuais já existentes no Postgres.
   ===================================================================== */

IF OBJECT_ID('dbo.f_metas_vendedores_manual') IS NULL
CREATE TABLE dbo.f_metas_vendedores_manual (
    cod_vendedor   INT            NOT NULL,
    vendedor       VARCHAR(50)    NOT NULL,  -- UPPER/TRIM: casa com nome_representante nos cards
    ano            INT            NOT NULL,
    mes            INT            NOT NULL,  -- mês comissional (26 -> 25)
    valor_total    DECIMAL(18,2)  NOT NULL,
    atualizado_em  DATETIME2(0)   NOT NULL CONSTRAINT DF_MetasManual_atualizado DEFAULT SYSDATETIME(),
    CONSTRAINT PK_f_metas_vendedores_manual PRIMARY KEY (cod_vendedor, ano, mes)
);
GO

CREATE OR ALTER PROCEDURE dbo.sp_AplicarMetasManuais
    @ano INT = NULL,
    @mes INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    BEGIN TRAN;

    -- Substitui (em vez de UPDATE) para nunca somar em dobro se a planilha
    -- trouxer mais de uma linha do mesmo vendedor no período.
    DELETE f
    FROM dbo.f_metas_vendedores f
    JOIN dbo.f_metas_vendedores_manual m
      ON m.cod_vendedor = f.cod_vendedor AND m.ano = f.ano AND m.mes = f.mes
    WHERE (@ano IS NULL OR m.ano = @ano)
      AND (@mes IS NULL OR m.mes = @mes);

    ;WITH Periodo AS (
        SELECT v.ano_comissional AS ano,
               v.mes_comissional AS mes,
               MIN(v.data_date)  AS data_inicial,
               MAX(v.data_date)  AS data_final,
               SUM(CASE WHEN d.is_dia_util = 1 THEN 1 ELSE 0 END) AS dias_uteis
        FROM dbo.vw_d_calendario_tipado v
        JOIN dbo.d_calendario d ON CAST(d.data AS date) = v.data_date
        GROUP BY v.ano_comissional, v.mes_comissional
    )
    INSERT INTO dbo.f_metas_vendedores
        (cod_vendedor, vendedor, data_inicial, data_final, valor_total, valor_diario, mes, ano)
    SELECT m.cod_vendedor, m.vendedor, p.data_inicial, p.data_final, m.valor_total,
           CAST(m.valor_total / NULLIF(p.dias_uteis, 0) AS DECIMAL(18,4)),
           m.mes, m.ano
    FROM dbo.f_metas_vendedores_manual m
    LEFT JOIN Periodo p ON p.ano = m.ano AND p.mes = m.mes
    WHERE (@ano IS NULL OR m.ano = @ano)
      AND (@mes IS NULL OR m.mes = @mes);

    COMMIT;
END
GO

CREATE OR ALTER PROCEDURE dbo.sp_GravarMetaManual
    @cod_vendedor INT,
    @vendedor     VARCHAR(50),
    @ano          INT,
    @mes          INT,
    @valor_total  DECIMAL(18,2)
AS
BEGIN
    SET NOCOUNT ON;

    MERGE dbo.f_metas_vendedores_manual AS alvo
    USING (SELECT @cod_vendedor AS cod_vendedor, @ano AS ano, @mes AS mes) AS src
       ON alvo.cod_vendedor = src.cod_vendedor AND alvo.ano = src.ano AND alvo.mes = src.mes
    WHEN MATCHED THEN
        UPDATE SET vendedor = @vendedor, valor_total = @valor_total, atualizado_em = SYSDATETIME()
    WHEN NOT MATCHED THEN
        INSERT (cod_vendedor, vendedor, ano, mes, valor_total)
        VALUES (@cod_vendedor, @vendedor, @ano, @mes, @valor_total);

    EXEC dbo.sp_AplicarMetasManuais @ano = @ano, @mes = @mes;
END
GO

-- Usuário do vendas-service em produção (db_datawriter não inclui EXECUTE).
GRANT EXECUTE ON dbo.sp_GravarMetaManual TO BI_READ_ONLY;
GO

/* ---------------------------------------------------------------------
   sp_ImportarMetasDoExcel: corpo original + reaplicação das manuais.
   --------------------------------------------------------------------- */
ALTER PROCEDURE [dbo].[sp_ImportarMetasDoExcel]
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @caminhoPlanilha NVARCHAR(MAX);
    DECLARE @nomeAba NVARCHAR(MAX);

    SET @caminhoPlanilha = N'\\192.168.1.249\dados\COMERCIAL\Demonstrativos\Apoio\Meta Vendedores.xlsx';
    SET @nomeAba = N'Metas$';

    DECLARE @sqlQuery NVARCHAR(MAX);

    SET @sqlQuery = N'
    DELETE fmv
    FROM dbo.f_metas_vendedores AS fmv
    JOIN (
        SELECT DISTINCT ANO, MÊS
        FROM OPENROWSET(''Microsoft.ACE.OLEDB.16.0'',
                        ''Excel 12.0;Database=' + REPLACE(@caminhoPlanilha, '''', '''''') + ';HDR=YES'',
                        ''SELECT ANO, MÊS FROM [' + @nomeAba + ']'')
    ) AS excelData ON fmv.ano = excelData.ANO AND fmv.mes = excelData.MÊS;';

    EXEC sp_executesql @sqlQuery;

    SET @sqlQuery = N'
    INSERT INTO dbo.f_metas_vendedores (
        cod_vendedor, vendedor, data_inicial, data_final, valor_total, valor_diario, mes, ano
    )
    SELECT
        COD, VENDEDOR, [DATA INICIAL], [DATA FINAL], [VALOR TOTAL], [VALOR DIÁRIO], MÊS, ANO
    FROM OPENROWSET(''Microsoft.ACE.OLEDB.16.0'',
                    ''Excel 12.0;Database=' + REPLACE(@caminhoPlanilha, '''', '''''') + ';HDR=YES'',
                    ''SELECT COD, VENDEDOR, [DATA INICIAL], [DATA FINAL], [VALOR TOTAL], [VALOR DIÁRIO], MÊS, ANO FROM [' + @nomeAba + ']'');';

    EXEC sp_executesql @sqlQuery;

    -- A importação apaga os meses da planilha; as metas manuais voltam por cima.
    EXEC dbo.sp_AplicarMetasManuais;

    SET NOCOUNT OFF;
END
GO

/* ---------------------------------------------------------------------
   Carga inicial: metas manuais existentes em ven_meta_vendedor (Postgres).
   --------------------------------------------------------------------- */
MERGE dbo.f_metas_vendedores_manual AS alvo
USING (VALUES
    (163, 'ALISSON',                         2026, 9, 220000.00),
    (200, 'FERNANDO',                        2026, 9, 140000.00),
    (218, 'GABRIEL',                         2026, 9,      0.00),
    (326, 'EDILSOM SALES',                   2026, 9,      0.00),
    (349, 'CRISTIANO BIASOTTO SANTOS ALVES', 2026, 9,  80000.00),
    (353, 'JOAO',                            2026, 9,  60000.00),
    (326, 'EDILSOM SALES',                   2026, 8,      0.00),
    (348, 'THAINARA FLORENCIO KORT',         2026, 8,  80000.00),
    (349, 'CRISTIANO BIASOTTO SANTOS ALVES', 2026, 8,  80000.00),
    (348, 'THAINARA FLORENCIO KORT',         2026, 7,      0.00),
    (349, 'CRISTIANO BIASOTTO SANTOS ALVES', 2026, 7,      0.00)
) AS src (cod_vendedor, vendedor, ano, mes, valor_total)
   ON alvo.cod_vendedor = src.cod_vendedor AND alvo.ano = src.ano AND alvo.mes = src.mes
WHEN MATCHED THEN
    UPDATE SET vendedor = src.vendedor, valor_total = src.valor_total, atualizado_em = SYSDATETIME()
WHEN NOT MATCHED THEN
    INSERT (cod_vendedor, vendedor, ano, mes, valor_total)
    VALUES (src.cod_vendedor, src.vendedor, src.ano, src.mes, src.valor_total);
GO

EXEC dbo.sp_AplicarMetasManuais;
GO
