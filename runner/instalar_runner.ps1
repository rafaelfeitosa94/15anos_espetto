<#
  Instala o runner do GitHub Actions no servidor da rede (SRVTESTE) como serviço do Windows.
  O runner só faz conexões de SAÍDA para o GitHub (HTTPS 443): nenhuma porta é aberta no servidor.

  COMO USAR (no SRVTESTE, PowerShell "Executar como administrador"):
    1. No GitHub: repositório 15anos_espetto -> Settings -> Actions -> Runners -> New self-hosted runner -> Windows.
       Copie só o valor depois de "--token" no comando ./config.cmd mostrado na página (vale por 1 hora).
    2. Rode:
         powershell -ExecutionPolicy Bypass -File .\instalar_runner.ps1 -Token COLE_O_TOKEN_AQUI

  Para remover depois:  cd C:\actions-runner ; .\config.cmd remove --token <token de remoção da mesma página>
#>
param(
    [Parameter(Mandatory)][string]$Token,
    [string]$Repo = 'https://github.com/rafaelfeitosa94/15anos_espetto',
    [string]$Pasta = 'C:\actions-runner',
    [string]$ServidorSql = 'ad01',
    [int]$PortaSql = 1433
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Passo($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Execute o PowerShell como administrador.' }

Passo "Testando acesso ao SQL Server ($ServidorSql : $PortaSql) e ao GitHub"
$sql = Test-NetConnection $ServidorSql -Port $PortaSql -WarningAction SilentlyContinue
if (-not $sql.TcpTestSucceeded) { throw "Este servidor não alcança $ServidorSql na porta $PortaSql (SQL Server)." }
Write-Host "  SQL Server: OK ($($sql.RemoteAddress))"
$git = Test-NetConnection 'github.com' -Port 443 -WarningAction SilentlyContinue
if (-not $git.TcpTestSucceeded) { throw 'Este servidor não acessa github.com (porta 443).' }
Write-Host '  GitHub: OK'

Passo 'Baixando a versão mais recente do runner (github.com/actions/runner)'
$rel = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'instalar-runner' }
$asset = $rel.assets | Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } | Select-Object -First 1
if (-not $asset) { throw 'Não encontrei o pacote win-x64 na release do runner.' }
New-Item -ItemType Directory -Force $Pasta | Out-Null
$zip = Join-Path $Pasta $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
Write-Host "  $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)"

# confere o SHA-256 publicado nas notas da release
if ($rel.body -match '<!-- BEGIN SHA win-x64 -->\s*([0-9a-f]{64})\s*<!-- END SHA win-x64 -->') {
    $esperado = $Matches[1]
    $obtido = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($obtido -ne $esperado) { Remove-Item $zip; throw "SHA-256 não confere ($obtido <> $esperado). Instalação cancelada." }
    Write-Host '  SHA-256 conferido.'
} else {
    Write-Warning 'Não encontrei o SHA-256 nas notas da release; seguindo sem conferir.'
}

Passo "Extraindo em $Pasta"
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $Pasta)
Remove-Item $zip

Passo 'Registrando o runner no repositório e instalando como serviço do Windows'
Push-Location $Pasta
try {
    & .\config.cmd --unattended --url $Repo --token $Token --name $env:COMPUTERNAME `
        --labels 'sqlserver' --work '_work' --runasservice --replace
    if ($LASTEXITCODE -ne 0) { throw "config.cmd terminou com código $LASTEXITCODE" }
} finally { Pop-Location }

Passo 'Status do serviço'
Get-Service 'actions.runner.*' | Format-Table Name, Status, StartType -AutoSize
Write-Host "`nPronto! No GitHub (Settings -> Actions -> Runners) o runner '$env:COMPUTERNAME' deve aparecer como Idle." -ForegroundColor Green
