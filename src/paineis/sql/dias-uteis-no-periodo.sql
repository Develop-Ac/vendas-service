SELECT COUNT(*) AS [count]
FROM dbo.d_calendario
WHERE dbo.d_calendario.is_dia_util = 1
  AND (dbo.d_calendario.data >= CAST(@de AS date) AND dbo.d_calendario.data < DATEADD(day, 1, CAST(@ate AS date)));
