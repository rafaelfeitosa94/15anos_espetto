# Cria (ou recria) a tarefa agendada do Windows que atualiza o dashboard todo dia às 14h.
# Executar no PowerShell:  powershell -ExecutionPolicy Bypass -File .\agendar_tarefa.ps1
$ErrorActionPreference = 'Stop'
$nome   = 'Dashboard Copo 15 Anos - Atualizacao'
$bat    = Join-Path $PSScriptRoot 'atualizar.bat'

$acao   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $PSScriptRoot
$gatilho = New-ScheduledTaskTrigger -Daily -At '14:00'
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
          -ExecutionTimeLimit (New-TimeSpan -Hours 1) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Settings $config `
    -Description 'Extrai dados do SQL Server e publica o dashboard da Ação Copo 15 Anos (GitHub -> Vercel).' -Force | Out-Null

Write-Host "Tarefa '$nome' agendada para todos os dias às 14:00."
Get-ScheduledTask -TaskName $nome | Get-ScheduledTaskInfo | Select-Object NextRunTime
