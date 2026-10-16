<#
  Cria no SRVTESTE a tarefa agendada "Copo15 - Atualizar dados", que dispara o workflow "Atualizar dados"
  no GitHub de hora em hora (11h às 23h, de 15/10 a 01/12). O agendamento do próprio GitHub costuma
  atrasar ou pular horários; a tarefa local garante a execução. O workflow roda no runner deste servidor.

  A tarefa só chama a API do GitHub (HTTPS 443); a consulta ao banco continua sendo feita pelo workflow.
  Se já houver uma atualização na fila ou rodando, a tarefa não dispara outra.

  COMO USAR (no SRVTESTE, PowerShell "Executar como administrador"):
    powershell -ExecutionPolicy Bypass -File .\agendar_atualizacao.ps1 -Token COLE_O_TOKEN_AQUI

  -Token: token do GitHub com permissão "Actions: Read and write" no repositório 15anos_espetto
          (pode ser o mesmo cadastrado como GH_TOKEN na Vercel). Ele fica gravado criptografado
          (DPAPI da máquina) em C:\ProgramData\copo15, com acesso só para SYSTEM e administradores.

  Testar na hora:   Start-ScheduledTask -TaskName 'Copo15 - Atualizar dados'
  Ver o log:        Get-Content C:\ProgramData\copo15\logs\disparo.log -Tail 20
  Remover:          Unregister-ScheduledTask -TaskName 'Copo15 - Atualizar dados' -Confirm:$false
#>
param(
    [Parameter(Mandatory)][string]$Token,
    [string]$Repo = 'rafaelfeitosa94/15anos_espetto',
    [string]$Workflow = 'atualizar-dados.yml',
    [string]$Inicio = '11:00',
    [int]$Horas = 12,               # 11h + 12 repetições = última às 23h
    [string]$Pasta = 'C:\ProgramData\copo15'
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security
$Tarefa = 'Copo15 - Atualizar dados'

function Passo($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Execute o PowerShell como administrador.' }

Passo 'Validando o token no GitHub'
$h = @{ Authorization = "Bearer $Token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'copo15-tarefa'; 'X-GitHub-Api-Version' = '2022-11-28' }
$wf = Invoke-RestMethod "https://api.github.com/repos/$Repo/actions/workflows/$Workflow" -Headers $h
Write-Host "  Workflow encontrado: $($wf.name) ($($wf.state))"

Passo "Gravando o token criptografado em $Pasta"
New-Item -ItemType Directory -Force $Pasta, "$Pasta\logs" | Out-Null
$cifrado = [Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($Token), $null,
    [Security.Cryptography.DataProtectionScope]::LocalMachine)
[IO.File]::WriteAllBytes("$Pasta\token.bin", $cifrado)
# só SYSTEM e administradores leem a pasta
& icacls $Pasta /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

Passo 'Gravando o script de disparo'
$disparo = @'
# Gerado por agendar_atualizacao.ps1: dispara o workflow "Atualizar dados" no GitHub.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Security
$Pasta = '__PASTA__'; $Repo = '__REPO__'; $Workflow = '__WORKFLOW__'
$log = "$Pasta\logs\disparo.log"
function Log($t) { Add-Content -Path $log -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $t) -Encoding UTF8 }
try {
    $hoje = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, 'E. South America Standard Time').ToString('yyyy-MM-dd')
    # período da ação (o dia 30/11 termina de entrar no banco em 01/12)
    if ($hoje -lt '2026-10-15' -or $hoje -gt '2026-12-01') { Log "fora do período da ação ($hoje)"; exit 0 }
    $token = [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(
        [IO.File]::ReadAllBytes("$Pasta\token.bin"), $null, [Security.Cryptography.DataProtectionScope]::LocalMachine))
    $h = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'User-Agent' = 'copo15-tarefa'; 'X-GitHub-Api-Version' = '2022-11-28' }
    $base = "https://api.github.com/repos/$Repo/actions/workflows/$Workflow"
    foreach ($st in 'queued', 'in_progress') {
        $r = Invoke-RestMethod "$base/runs?status=$st&per_page=1" -Headers $h
        if ($r.total_count -gt 0) { Log "já existe execução $st; nada a fazer"; exit 0 }
    }
    Invoke-RestMethod "$base/dispatches" -Method Post -Headers $h -ContentType 'application/json' -Body '{"ref":"main"}' | Out-Null
    Log 'workflow disparado'
} catch {
    Log "ERRO: $($_.Exception.Message)"
    exit 1
}
'@
$disparo = $disparo.Replace('__PASTA__', $Pasta).Replace('__REPO__', $Repo).Replace('__WORKFLOW__', $Workflow)
[IO.File]::WriteAllText("$Pasta\disparar_atualizacao.ps1", $disparo, (New-Object Text.UTF8Encoding $true))

Passo "Criando a tarefa agendada '$Tarefa' (de hora em hora, $Inicio às 23h)"
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Pasta\disparar_atualizacao.ps1`""
$gatilho = New-ScheduledTaskTrigger -Daily -At $Inicio
$rep = New-ScheduledTaskTrigger -Once -At $Inicio -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours $Horas -Minutes 1)
$gatilho.Repetition = $rep.Repetition
$conf = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$usuario = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilho -Settings $conf -Principal $usuario `
    -Description 'Dispara o workflow Atualizar dados (dashboard Copo 15 Anos) no GitHub' -Force | Out-Null

Passo 'Testando agora'
Start-ScheduledTask -TaskName $Tarefa
Start-Sleep -Seconds 15
Get-Content "$Pasta\logs\disparo.log" -Tail 3
$info = Get-ScheduledTaskInfo -TaskName $Tarefa
Write-Host "`nPronto. Próxima execução: $($info.NextRunTime)" -ForegroundColor Green
