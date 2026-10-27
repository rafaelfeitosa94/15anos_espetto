# Consulta somente as comandas que tiveram o item do copo lançado.
# valor = soma dos produtos da comanda (consumo); faturamento = soma dos pagamentos não cancelados da comanda
# (BD_PAGAMENTOS_V2, que usa o mesmo controle da tabela de produtos). Villa Lobos (Zig): faturamento = valor.
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
    SELECT CAST(p.codLoja AS varchar(50)) AS cod, CAST(p.dataVenda AS date) AS data,
           CAST(p.tipoVenda AS varchar(50)) AS tipo, CAST(p.controle AS varchar(50)) AS comanda,
           SUM(p.valTotal) AS valor
    FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.cancelado = 'N' AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.codLoja AS varchar(50)), CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), copo_e AS (
    SELECT CAST(p.codLoja AS varchar(50)) AS cod, CAST(p.dataVenda AS date) AS data,
           CAST(p.tipoVenda AS varchar(50)) AS tipo, CAST(p.controle AS varchar(50)) AS comanda,
           SUM(p.quantidade) AS copos
    FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.codLoja AS varchar(50)), CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), chopp_e AS (
    -- chopp vendido no copo comemorativo (item @chopp), por comanda
    SELECT CAST(p.codLoja AS varchar(50)) AS cod, CAST(p.dataVenda AS date) AS data,
           CAST(p.tipoVenda AS varchar(50)) AS tipo, CAST(p.controle AS varchar(50)) AS comanda,
           SUM(p.quantidade) AS qtd, SUM(p.valTotal) AS valor
    FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @chopp
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.codLoja AS varchar(50)), CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), pag_e AS (
    SELECT CAST(g.codLoja AS varchar(50)) AS cod, CAST(g.dataVenda AS date) AS data,
           CAST(g.controle AS varchar(50)) AS comanda, SUM(g.valor) AS valor
    FROM bd_espetto_2025.dbo.BD_PAGAMENTOS_V2 g
    WHERE g.cancelada = 'N' AND g.dataVenda >= @inicio AND g.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(g.codLoja AS varchar(50)), CAST(g.dataVenda AS date), CAST(g.controle AS varchar(50))
), consumo_m AS (
    SELECT CAST(p.dataVenda AS date) AS data, CAST(p.tipoVenda AS varchar(50)) AS tipo,
           CAST(p.controle AS varchar(50)) AS comanda, SUM(p.valTotal) AS valor
    FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.codLoja = 13 AND p.cancelado = 'N' AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), copo_m AS (
    SELECT CAST(p.dataVenda AS date) AS data, CAST(p.tipoVenda AS varchar(50)) AS tipo,
           CAST(p.controle AS varchar(50)) AS comanda, SUM(p.quantidade) AS copos
    FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.codLoja = 13 AND p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), chopp_m AS (
    SELECT CAST(p.dataVenda AS date) AS data, CAST(p.tipoVenda AS varchar(50)) AS tipo,
           CAST(p.controle AS varchar(50)) AS comanda, SUM(p.quantidade) AS qtd, SUM(p.valTotal) AS valor
    FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
    WHERE p.codLoja = 13 AND p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @chopp
      AND p.dataVenda >= @inicio AND p.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(p.dataVenda AS date), CAST(p.tipoVenda AS varchar(50)), CAST(p.controle AS varchar(50))
), pag_m AS (
    SELECT CAST(g.dataVenda AS date) AS data, CAST(g.controle AS varchar(50)) AS comanda, SUM(g.valor) AS valor
    FROM bd_mane_2025.dbo.BD_PAGAMENTOS_V2 g
    WHERE g.codLoja = 13 AND g.cancelada = 'N' AND g.dataVenda >= @inicio AND g.dataVenda < DATEADD(day, 1, @fim)
    GROUP BY CAST(g.dataVenda AS date), CAST(g.controle AS varchar(50))
), comandas AS (
    SELECT l.lojas AS loja, p.data, p.comanda, CAST(ISNULL(e.valor, 0) AS decimal(16,2)) AS valor,
           CAST(p.copos AS decimal(16,3)) AS copos, CAST(g.valor AS decimal(16,2)) AS faturamento,
           CAST(ISNULL(h.qtd, 0) AS decimal(16,3)) AS chopp_qtd, CAST(ISNULL(h.valor, 0) AS decimal(16,2)) AS chopp_valor
    FROM copo_e p
    LEFT JOIN consumo_e e ON p.cod=e.cod AND p.data=e.data AND p.tipo=e.tipo AND p.comanda=e.comanda
    LEFT JOIN pag_e g ON g.cod=p.cod AND g.data=p.data AND g.comanda=p.comanda
    LEFT JOIN chopp_e h ON h.cod=p.cod AND h.data=p.data AND h.tipo=p.tipo AND h.comanda=p.comanda
    JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON CAST(l.id AS varchar(50))=p.cod
    UNION ALL
    SELECT 'MAN CABO FRIO COLLAB', p.data, p.comanda, CAST(ISNULL(m.valor, 0) AS decimal(16,2)), CAST(p.copos AS decimal(16,3)),
           CAST(g.valor AS decimal(16,2)), CAST(ISNULL(h.qtd, 0) AS decimal(16,3)), CAST(ISNULL(h.valor, 0) AS decimal(16,2))
    FROM copo_m p LEFT JOIN consumo_m m ON p.data=m.data AND p.tipo=m.tipo AND p.comanda=m.comanda
    LEFT JOIN pag_m g ON g.data=p.data AND g.comanda=p.comanda
    LEFT JOIN chopp_m h ON h.data=p.data AND h.tipo=p.tipo AND h.comanda=p.comanda
    UNION ALL
    SELECT v.LOJA, CAST(v.DATA AS date), CAST(v.COMANDAS AS nvarchar(100)),
           CAST(SUM(v.VALOR) AS decimal(16,2)),
           CAST(SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@item THEN v.QUANTIDADE ELSE 0 END) AS decimal(16,3)),
           CAST(SUM(v.VALOR) AS decimal(16,2)),
           CAST(SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@chopp_vl THEN v.QUANTIDADE ELSE 0 END) AS decimal(16,3)),
           CAST(SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@chopp_vl THEN v.VALOR ELSE 0 END) AS decimal(16,2))
    FROM master.dbo.vw_faturamento_villa_lobos_cupom v
    WHERE v.DATA >= @inicio AND v.DATA < DATEADD(day, 1, @fim)
    GROUP BY v.LOJA, CAST(v.DATA AS date), v.COMANDAS
    HAVING SUM(CASE WHEN UPPER(LTRIM(RTRIM(v.PRODUTO)))=@item THEN v.QUANTIDADE ELSE 0 END) > 0
    UNION ALL
    -- Península (PDV próprio, bd_peninsula_frest; DATA em texto dd/mm/aaaa): valor = soma dos produtos da
    -- comanda; faturamento = TOT_PAGO da BD_VENDAS (NULL enquanto a BD_VENDAS não tiver a comanda)
    SELECT N'ESP PENÍNSULA', p.data, p.comanda, CAST(p.valor AS decimal(16,2)), CAST(p.copos AS decimal(16,3)),
           CAST(v.pago AS decimal(16,2)), CAST(0 AS decimal(16,3)), CAST(0 AS decimal(16,2))
    FROM (
        SELECT TRY_CONVERT(date, DATA, 103) AS data, CAST(NUM_LANCTO AS nvarchar(100)) AS comanda, SUM(TOTAL) AS valor,
               SUM(CASE WHEN UPPER(LTRIM(RTRIM(DESC_RES))) = @item_pen THEN QTE ELSE 0 END) AS copos
        FROM bd_peninsula_frest.dbo.BD_PRODUTOS
        WHERE TRY_CONVERT(date, DATA, 103) >= @inicio AND TRY_CONVERT(date, DATA, 103) <= @fim
        GROUP BY TRY_CONVERT(date, DATA, 103), CAST(NUM_LANCTO AS nvarchar(100))
    ) p
    LEFT JOIN (
        SELECT TRY_CONVERT(date, DATA, 103) AS data, CAST(NUM_LANCTO AS nvarchar(100)) AS comanda, SUM(TOT_PAGO) AS pago
        FROM bd_peninsula_frest.dbo.BD_VENDAS
        WHERE TRY_CONVERT(date, DATA, 103) >= @inicio AND TRY_CONVERT(date, DATA, 103) <= @fim
        GROUP BY TRY_CONVERT(date, DATA, 103), CAST(NUM_LANCTO AS nvarchar(100))
    ) v ON v.data = p.data AND v.comanda = p.comanda
    WHERE p.copos > 0
)
SELECT loja, CONVERT(char(10), data, 120) AS data, comanda, valor, copos, faturamento, chopp_qtd, chopp_valor
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
    [void]$cmd.Parameters.Add('@item_pen', [System.Data.SqlDbType]::NVarChar, 100)
    [void]$cmd.Parameters.Add('@chopp', [System.Data.SqlDbType]::NVarChar, 100)
    [void]$cmd.Parameters.Add('@chopp_vl', [System.Data.SqlDbType]::NVarChar, 100)
    $cmd.Parameters['@inicio'].Value = [datetime]::ParseExact($Inicio, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@fim'].Value = [datetime]::ParseExact($Fim, 'yyyy-MM-dd', $null)
    $cmd.Parameters['@item'].Value = 'COPO ESPETTO ANIVER 15'
    $cmd.Parameters['@item_pen'].Value = 'COPO NIVER ESPETTO'
    $cmd.Parameters['@chopp'].Value = 'CHOPP P/ COPO 15 ANOS ESPETTO'   # Espetto e Mané (Degust)
    $cmd.Parameters['@chopp_vl'].Value = 'CHOPP P/COPO 15ANOS'          # Villa Lobos (Zig)
    $reader = $cmd.ExecuteReader()
    $items = New-Object System.Collections.Generic.List[object]
    while ($reader.Read()) {
        $items.Add([ordered]@{
            loja = [string]$reader['loja']
            data = [string]$reader['data']
            comanda = [string]$reader['comanda']
            valor = [decimal]$reader['valor']
            copos = [decimal]$reader['copos']
            faturamento = $(if ($reader['faturamento'] -is [DBNull]) { $null } else { [decimal]$reader['faturamento'] })
            chopp_quantidade = [decimal]$reader['chopp_qtd']
            chopp_valor = [decimal]$reader['chopp_valor']
        })
    }
    $reader.Close()
    $json = ConvertTo-Json -InputObject @($items.ToArray()) -Compress -Depth 4
    [System.IO.File]::WriteAllText($Saida, $json, (New-Object System.Text.UTF8Encoding $false))
}
finally {
    $cn.Dispose()
}
