# Consulta somente as comandas que tiveram o item do copo lançado.
# Roda no runner da rede e não exige atualizar/criar procedure no SQL Server.
param(
    [Parameter(Mandatory)][string]$Inicio,
    [Parameter(Mandatory)][string]$Fim,
    [Parameter(Mandatory)][string]$Saida
)
$ErrorActionPreference = 'Stop'

$csb = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
$csb['Data Source'] = $env:DB_SERVER
$csb['Initial Catalog'] = $(if ($env:DB_DATABASE) { $env:DB_DATABASE } else { 'master' })
$csb['User ID'] = $env:DB_USER
$csb['Password'] = $env:DB_PASSWORD
$csb['Connect Timeout'] = 30
$csb['Application Name'] = 'dashboard-copo15-comandas-runner'

$sql = @'
;WITH consumo_e AS (
    SELECT CAST(v.codLoja AS varchar(50)) AS cod, CAST(v.dataVenda AS date) AS data,
           CAST(v.controle AS varchar(50)) AS comanda,
           SUM(v.valLiquido) - SUM(v.valAcrescimo) AS valor
    FROM bd_espetto_2025.dbo.bd_vendas_v3 v
    WHERE v.cancelada = 'N' AND v.dataVenda >= @inicio AND v.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(v.codLoja AS varchar(50)), CAST(v.dataVenda AS date), CAST(v.controle AS varchar(50))
), copo_e AS (
    SELECT CAST(p.codLoja AS varchar(50)) AS cod, CAST(p.dataVenda AS date) AS data,
           CAST(p.controle AS varchar(50)) AS comanda,
           SUM(p.quantidade) AS copos
    FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.codLoja AS varchar(50)), CAST(p.dataVenda AS date), CAST(p.controle AS varchar(50))
), consumo_m AS (
    SELECT CAST(v.dataVenda AS date) AS data, CAST(v.controle AS varchar(50)) AS comanda,
           SUM(v.valLiquido) - SUM(v.valAcrescimo) AS valor
    FROM bd_mane_2025.dbo.bd_vendas_v3 v
    WHERE v.codLoja = 13 AND v.cancelada = 'N' AND v.dataVenda >= @inicio AND v.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(v.dataVenda AS date), CAST(v.controle AS varchar(50))
), copo_m AS (
    SELECT CAST(p.dataVenda AS date) AS data, CAST(p.controle AS varchar(50)) AS comanda, SUM(p.quantidade) AS copos
    FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.codLoja = 13 AND p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.dataVenda AS date), CAST(p.controle AS varchar(50))
), comandas AS (
    SELECT l.lojas AS loja, p.data, p.comanda, CAST(ISNULL(e.valor, 0) AS decimal(16,2)) AS valor, CAST(p.copos AS decimal(16,3)) AS copos
    FROM copo_e p
    LEFT JOIN consumo_e e ON p.cod=e.cod AND p.data=e.data AND p.comanda=e.comanda
    JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON CAST(l.id AS varchar(50))=p.cod
    UNION ALL
    SELECT 'MAN CABO FRIO COLLAB', m.data, m.comanda, CAST(m.valor AS decimal(16,2)), CAST(p.copos AS decimal(16,3))
    FROM copo_m p LEFT JOIN consumo_m m ON p.data=m.data AND p.comanda=m.comanda
    UNION ALL
    SELECT v.LOJA, CAST(v.DATA AS date), CAST(v.COMANDAS AS nvarchar(100)),
           CAST(SUM(v.VALOR) AS decimal(16,2)),
           CAST(SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@item THEN v.QUANTIDADE ELSE 0 END) AS decimal(16,3))
    FROM master.dbo.vw_faturamento_villa_lobos_cupom v
    WHERE v.DATA >= @inicio AND v.DATA < DATEADD(day, 1, @fim)
    GROUP BY v.LOJA, CAST(v.DATA AS date), v.COMANDAS
    HAVING SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@item THEN v.QUANTIDADE ELSE 0 END) > 0
)
SELECT loja, CONVERT(char(10), data, 120) AS data, comanda, valor, copos
FROM comandas
ORDER BY data, loja, comanda;
'@

$cn = New-Object System.Data.SqlClient.SqlConnection $csb.ConnectionString
try {
    $cn.Open()
    $cmd = $cn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 900
    [void]$cmd.Parameters.Add('@inicio', [System.Data.SqlDbType]::Date)
    [void]$cmd.Parameters.Add('@fim', [System.Data.SqlDbType]::Date)
    [void]$cmd.Parameters.Add('@item', [System.Data.SqlDbType]::NVarChar, 100)
    $cmd.Parameters['@inicio'].Value = [datetime]::ParseExact($Inicio, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@fim'].Value = [datetime]::ParseExact($Fim, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@item'].Value = 'COPO ESPETTO ANIVER 15'
    $reader = $cmd.ExecuteReader()
    $items = New-Object System.Collections.Generic.List[object]
    while ($reader.Read()) {
        $items.Add([ordered]@{
            loja = [string]$reader['loja']
            data = [string]$reader['data']
            comanda = [string]$reader['comanda']
            valor = [decimal]$reader['valor']
            copos = [decimal]$reader['copos']
        })
    }
    $reader.Close()
    $json = ConvertTo-Json -InputObject @($items.ToArray()) -Compress -Depth 4
    [System.IO.File]::WriteAllText($Saida, $json, (New-Object System.Text.UTF8Encoding $false))
}
finally {
    $cn.Dispose()
}
