# Executa dbo.sp_dashboard_copo15 e grava o JSON (coluna payload) em um arquivo UTF-8.
# Usa o SqlClient nativo do .NET (Windows PowerShell 5.1): não precisa de Python nem driver ODBC no runner.
# Conexão: variáveis DB_SERVER, DB_USER, DB_PASSWORD (secrets do GitHub) e DB_DATABASE (padrão master).
param(
    [Parameter(Mandatory)][string]$Inicio,
    [Parameter(Mandatory)][string]$Fim,
    [Parameter(Mandatory)][ValidateSet('vendas', 'produtos_espetto', 'produtos_parceiros')][string]$Parte,
    [Parameter(Mandatory)][string]$Saida
)
$ErrorActionPreference = 'Stop'

$csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$csb['Data Source'] = $env:DB_SERVER
$csb['Initial Catalog'] = $(if ($env:DB_DATABASE) { $env:DB_DATABASE } else { 'master' })
$csb['User ID'] = $env:DB_USER
$csb['Password'] = $env:DB_PASSWORD
$csb['Connect Timeout'] = 30
$csb['Application Name'] = 'dashboard-copo15-runner'

$cn = New-Object System.Data.SqlClient.SqlConnection $csb.ConnectionString
try {
    $cn.Open()
    $cmd = $cn.CreateCommand()
    $cmd.CommandText = 'dbo.sp_dashboard_copo15'
    $cmd.CommandType = [System.Data.CommandType]::StoredProcedure
    $cmd.CommandTimeout = 900
    [void]$cmd.Parameters.Add('@inicio', [System.Data.SqlDbType]::Date)
    [void]$cmd.Parameters.Add('@fim', [System.Data.SqlDbType]::Date)
    [void]$cmd.Parameters.Add('@parte', [System.Data.SqlDbType]::VarChar, 20)
    $cmd.Parameters['@inicio'].Value = [datetime]::ParseExact($Inicio, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@fim'].Value = [datetime]::ParseExact($Fim, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@parte'].Value = $Parte
    $payload = $cmd.ExecuteScalar()
    if (-not $payload) { throw "A procedure não retornou dados ($Parte $Inicio..$Fim)" }
    [System.IO.File]::WriteAllText($Saida, [string]$payload, (New-Object System.Text.UTF8Encoding $false))
}
finally {
    $cn.Dispose()
}
