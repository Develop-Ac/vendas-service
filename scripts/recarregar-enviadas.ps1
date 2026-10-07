# Recarrega SÓ as mensagens enviadas (fromMe) de cada sessão rep-*, uma por vez,
# esperando a anterior terminar e pausando entre elas — para não empilhar carga
# no WAHA/vendas-service da .144 (incidente de 28/09). Uso:
#   .\scripts\recarregar-enviadas.ps1 -Desde 2026-09-29 -PausaMin 15
param(
  [string]$Base = 'http://vendas-service.acacessorios.local',
  [string[]]$Sessoes = @('rep-163','rep-200','rep-316','rep-349','rep-354'),
  [string]$Desde = '2026-09-29',
  [int]$PausaMin = 15
)
foreach ($s in $Sessoes) {
  $body = @{ sessao = $s; desde = "${Desde}T00:00:00-04:00"; so_enviadas = $true } | ConvertTo-Json
  try { Invoke-RestMethod -Method Post -Uri "$Base/whatsapp/historico" -ContentType 'application/json' -Body $body | Out-Null }
  catch { Write-Host "$s: $($_.Exception.Message)"; continue }
  Write-Host "$(Get-Date -Format HH:mm) $s iniciada"
  do {
    Start-Sleep -Seconds 30
    $st = (Invoke-RestMethod "$Base/whatsapp/historico") | Where-Object { $_.sessao -eq $s }
  } while (-not $st.terminado_em)
  Write-Host "$(Get-Date -Format HH:mm) $s: $($st.chats) chats, $($st.lidas) lidas, $($st.gravadas) gravadas, $($st.midias) mídias, erro=$($st.erro)"
  if ($s -ne $Sessoes[-1]) { Start-Sleep -Seconds ($PausaMin * 60) }
}
