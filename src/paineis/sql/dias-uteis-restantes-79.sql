/* MEDIDA: Dias Úteis Futuros do Período Filtrado
   - Se NÃO houver filtro de data (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date))) → retorna 0
   - Se houver filtro:
       * corta datas futuras na data de hoje (data_fim "inteligente")
       * conta dias úteis restantes entre data_fim+1 e fim original do filtro
*/

WITH CalendarioFiltrado AS (
    SELECT
        data_date
    FROM dbo.vw_d_calendario_tipado
    -- Truque: sem filtro, isso vira "WHERE 1=2" → zero linhas
    WHERE 1 = 2  OR (dbo.vw_d_calendario_tipado.data_date >= CAST(@de AS date) AND dbo.vw_d_calendario_tipado.data_date < DATEADD(day, 1, CAST(@ate AS date))) 
),

-- Detecta se há filtro aplicado (CalendarioFiltrado tem linhas ou não)
CheckFiltro AS (
    SELECT
        CASE WHEN EXISTS (SELECT 1 FROM CalendarioFiltrado)
             THEN 1 ELSE 0 END AS tem_filtro
),

-- Quando NÃO houver filtro: já devolve 0
RetornoSemFiltro AS (
    SELECT 0 AS dias_uteis_restantes
    FROM CheckFiltro
    WHERE tem_filtro = 0
),

-- Limites do período filtrado (só faz sentido se tem_filtro = 1)
LimitesPeriodo AS (
    SELECT
        MIN(data_date) AS data_ini,
        MAX(data_date) AS data_fim_original
    FROM CalendarioFiltrado
),

-- Data final "inteligente": min(fim_original, hoje)
DataFim AS (
    SELECT
        CASE
            WHEN lp.data_fim_original > CAST(GETDATE() AS date)
                THEN CAST(GETDATE() AS date)
            ELSE lp.data_fim_original
        END AS data_fim,
        lp.data_ini,
        lp.data_fim_original
    FROM LimitesPeriodo lp
    CROSS JOIN CheckFiltro cf
    WHERE cf.tem_filtro = 1          -- só entra aqui se existir filtro
),

-- Dias úteis FUTUROS dentro do período filtrado
DiasUteisRestantesCalc AS (
    SELECT
        SUM(
            CASE 
                WHEN d.is_dia_util = 1
                 AND cal.data_date > df.data_fim          -- depois da data_fim inteligente
                 AND cal.data_date <= df.data_fim_original -- até o fim original do filtro
                THEN 1 ELSE 0 
            END
        ) AS dias_uteis_restantes
    FROM dbo.vw_d_calendario_tipado cal
    JOIN dbo.d_calendario d
      ON CAST(d.data AS date) = cal.data_date
    CROSS JOIN DataFim df
    CROSS JOIN CheckFiltro cf
    WHERE cf.tem_filtro = 1
)

-- Resultado final:
--  - Se NÃO tiver filtro → vem só de RetornoSemFiltro (0)
--  - Se tiver filtro     → vem de DiasUteisRestantesCalc
SELECT dias_uteis_restantes
FROM RetornoSemFiltro

UNION ALL

SELECT dias_uteis_restantes
FROM DiasUteisRestantesCalc;
