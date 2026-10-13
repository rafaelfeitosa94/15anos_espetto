/*
  Procedure usada pelo Power Automate (via on-premises data gateway) para o dashboard
  "Ação Copo 15 Anos". Retorna UMA linha com a coluna [payload] contendo um JSON compacto.

  Por que procedure: o conector SQL do Power Automate NÃO executa consultas livres
  ("Executar uma consulta SQL (V2)") através do gateway; só procedures. Limites do gateway:
  resposta de até 8 MB e 110 segundos — por isso o JSON é compacto e cada chamada traz só uma @parte:
    'vendas'             comandas, faturamento e comandas acima do limite (todas as lojas)
    'produtos_espetto'   produtos das lojas Espetto
    'produtos_parceiros' produtos de Villa Lobos e Cabo Frio Collab
  As tabelas de origem são heaps (sem índice), então cada parte faz varredura completa; as três partes
  são chamadas em paralelo pelo dashboard/workflow.

  Regras (iguais às do extrator Python):
  - Espetto: comandas de bd_vendas_v3 (valor = valLiquido - valAcrescimo por comanda);
    taxa de serviço e cortesias somadas apenas no total do dia (a vw_faturamento_espetto_cupom
    repete esses valores em cada comanda).
  - Villa Lobos: vw_faturamento_villa_lobos_cupom (comandas e produtos).
  - Cabo Frio Collab: mesma lógica da vw_faturamento_cabofrio_collab_cupom (serviço e cortesia por comanda),
    aplicada direto nas tabelas da base Mané com filtro de data (a view filtra só no final e fica lenta);
    produtos da base Mané (loja 13).
  - Produtos Espetto: mesma lógica da prod_15_anos_espetto (sem o filtro fixo de data).
  - Comanda conta para o copo quando o valor é MAIOR que @limite.

  SQL Server 2014: sem FOR JSON / STRING_AGG, o JSON é montado com FOR XML PATH.
*/
-- Obrigatório para os métodos XML (.value) usados na montagem do JSON: estas opções ficam gravadas na procedure.
-- (o sqlcmd usa QUOTED_IDENTIFIER OFF por padrão; no SSMS já vem ON)
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
IF OBJECT_ID('dbo.sp_dashboard_copo15', 'P') IS NOT NULL
    DROP PROCEDURE dbo.sp_dashboard_copo15;
GO
CREATE PROCEDURE dbo.sp_dashboard_copo15
    @inicio date,
    @fim    date,
    @parte  varchar(20) = 'vendas'
AS
BEGIN
-- <corpo>
SET NOCOUNT ON;
DECLARE @ini datetime = @inicio, @fimx datetime = DATEADD(day, 1, CAST(@fim AS datetime));
DECLARE @limite decimal(14, 2) = 250.00;

IF OBJECT_ID('tempdb..#com') IS NOT NULL DROP TABLE #com;
IF OBJECT_ID('tempdb..#aj') IS NOT NULL DROP TABLE #aj;
IF OBJECT_ID('tempdb..#ven') IS NOT NULL DROP TABLE #ven;
IF OBJECT_ID('tempdb..#prod') IS NOT NULL DROP TABLE #prod;
IF OBJECT_ID('tempdb..#lj') IS NOT NULL DROP TABLE #lj;
IF OBJECT_ID('tempdb..#pd') IS NOT NULL DROP TABLE #pd;

CREATE TABLE #com (loja nvarchar(150), data date, valor decimal(16, 2));
CREATE TABLE #aj (loja nvarchar(150), data date, valor decimal(16, 2));
CREATE TABLE #prod (loja nvarchar(150), data date, produto nvarchar(300), qtd decimal(16, 3), valor decimal(16, 2));

IF @parte = 'vendas'
BEGIN
-- Espetto: valor por comanda
INSERT #com (loja, data, valor)
SELECT l.lojas, CAST(v.dataVenda AS date), SUM(v.valLiquido) - SUM(v.valAcrescimo)
FROM bd_espetto_2025.dbo.bd_vendas_v3 v
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = v.codLoja
WHERE v.cancelada = 'N' AND v.dataVenda >= @ini AND v.dataVenda < @fimx
GROUP BY l.lojas, CAST(v.dataVenda AS date), v.tipoVenda, v.controle
OPTION (MAX_GRANT_PERCENT = 5);

-- Espetto: taxa de serviço (+) e cortesias (-) do dia
INSERT #aj (loja, data, valor)
SELECT l.lojas, CAST(x.dataVenda AS date), SUM(x.valor)
FROM (
    SELECT codLoja, dataVenda, SUM(valTaxaServico) AS valor
    FROM bd_espetto_2025.dbo.BD_TC_V2
    WHERE cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY codLoja, dataVenda
    UNION ALL
    SELECT codLoja, dataVenda, -SUM(valor)
    FROM bd_espetto_2025.dbo.BD_PAGAMENTOS_V2
    WHERE receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY codLoja, dataVenda
) x
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = x.codLoja
GROUP BY l.lojas, CAST(x.dataVenda AS date)
OPTION (MAX_GRANT_PERCENT = 5);

-- Villa Lobos: valor por comanda
INSERT #com (loja, data, valor)
SELECT LOJA, DATA, SUM(VALOR)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim
GROUP BY LOJA, DATA, COMANDAS
OPTION (MAX_GRANT_PERCENT = 5);

-- Cabo Frio Collab: valor por comanda (lógica da vw_faturamento_cabofrio_collab_cupom)
INSERT #com (loja, data, valor)
SELECT 'MAN CABO FRIO COLLAB', v.data, v.valor - v.acrescimo + ISNULL(t.servico, 0) - ISNULL(pg.cortesia, 0)
FROM (
    SELECT CAST(dataVenda AS date) AS data, tipoVenda, controle,
           SUM(valLiquido) AS valor, SUM(valAcrescimo) AS acrescimo
    FROM bd_mane_2025.dbo.bd_vendas_v3
    WHERE codLoja = 13 AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY CAST(dataVenda AS date), tipoVenda, controle
) v
LEFT JOIN (
    SELECT CAST(dataVenda AS date) AS data, tipoVenda, controle, SUM(valTaxaServico) AS servico
    FROM bd_mane_2025.dbo.BD_TC_V2
    WHERE codLoja = 13 AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY CAST(dataVenda AS date), tipoVenda, controle
) t ON t.data = v.data AND t.tipoVenda = v.tipoVenda AND t.controle = v.controle
LEFT JOIN (
    SELECT CAST(dataVenda AS date) AS data, tipoVenda, controle, SUM(valor) AS cortesia
    FROM bd_mane_2025.dbo.BD_PAGAMENTOS_V2
    WHERE codLoja = 13 AND receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N'
      AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY CAST(dataVenda AS date), tipoVenda, controle
) pg ON pg.data = v.data AND pg.tipoVenda = v.tipoVenda AND pg.controle = v.controle
OPTION (MAX_GRANT_PERCENT = 5);
END

-- Vendas por loja/dia
SELECT loja, data,
       SUM(fat) AS fat, SUM(com) AS com, SUM(c250) AS c250, SUM(f250) AS f250
INTO #ven
FROM (
    SELECT loja, data, valor AS fat, 1 AS com,
           CASE WHEN valor > @limite THEN 1 ELSE 0 END AS c250,
           CASE WHEN valor > @limite THEN valor ELSE 0 END AS f250
    FROM #com
    UNION ALL
    SELECT loja, data, valor, 0, 0, 0 FROM #aj
) t
WHERE loja IS NOT NULL
GROUP BY loja, data
OPTION (MAX_GRANT_PERCENT = 5);

IF @parte = 'produtos_espetto'
-- Produtos Espetto (lógica da prod_15_anos_espetto)
INSERT #prod (loja, data, produto, qtd, valor)
SELECT l.lojas, CAST(p.dataVenda AS date), p.descricaoProduto, SUM(p.quantidade), SUM(p.valTotal)
FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
LEFT JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = p.codLoja
WHERE p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY l.lojas, CAST(p.dataVenda AS date), p.descricaoProduto
OPTION (MAX_GRANT_PERCENT = 5);

IF @parte = 'produtos_parceiros'
BEGIN
-- Produtos Villa Lobos
INSERT #prod (loja, data, produto, qtd, valor)
SELECT LOJA, DATA, PRODUTO, SUM(QUANTIDADE), SUM(VALOR)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim
GROUP BY LOJA, DATA, PRODUTO
OPTION (MAX_GRANT_PERCENT = 5);

-- Produtos Cabo Frio Collab (base Mané, loja 13)
INSERT #prod (loja, data, produto, qtd, valor)
SELECT 'MAN CABO FRIO COLLAB', CAST(p.dataVenda AS date), p.descricaoProduto, SUM(p.quantidade), SUM(p.valTotal)
FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
WHERE p.codLoja = 13 AND p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY CAST(p.dataVenda AS date), p.descricaoProduto
OPTION (MAX_GRANT_PERCENT = 5);
END

DELETE FROM #prod WHERE loja IS NULL OR qtd <= 0;
UPDATE #prod SET produto = UPPER(LTRIM(RTRIM(
    REPLACE(REPLACE(REPLACE(ISNULL(produto, ''), CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '))));

-- Dicionários (índices a partir de 0)
SELECT ROW_NUMBER() OVER (ORDER BY loja) - 1 AS id, loja
INTO #lj FROM (SELECT loja FROM #ven UNION SELECT loja FROM #prod) x;
SELECT ROW_NUMBER() OVER (ORDER BY produto) - 1 AS id, produto
INTO #pd FROM (SELECT DISTINCT produto FROM #prod) x;

DECLARE @lojas nvarchar(max), @produtos nvarchar(max), @vendas nvarchar(max), @prods nvarchar(max);

SELECT @lojas = STUFF((
    SELECT ',"' + REPLACE(REPLACE(loja, '\', '\\'), '"', '\"') + '"'
    FROM #lj ORDER BY id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5);

SELECT @produtos = STUFF((
    SELECT ',"' + REPLACE(REPLACE(produto, '\', '\\'), '"', '\"') + '"'
    FROM #pd ORDER BY id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5);

SELECT @vendas = STUFF((
    SELECT ',[' + CAST(l.id AS varchar(10)) + ',"' + CONVERT(char(10), v.data, 120) + '",'
         + CONVERT(varchar(30), CAST(v.fat AS decimal(16, 2))) + ',' + CAST(v.com AS varchar(10)) + ','
         + CAST(v.c250 AS varchar(10)) + ',' + CONVERT(varchar(30), CAST(v.f250 AS decimal(16, 2))) + ']'
    FROM #ven v JOIN #lj l ON l.loja = v.loja
    ORDER BY l.id, v.data FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5);

SELECT @prods = STUFF((
    SELECT ',[' + CAST(l.id AS varchar(10)) + ',"' + CONVERT(char(10), p.data, 120) + '",'
         + CAST(d.id AS varchar(10)) + ',' + CONVERT(varchar(30), CAST(SUM(p.qtd) AS decimal(16, 3))) + ','
         + CONVERT(varchar(30), CAST(SUM(p.valor) AS decimal(16, 2))) + ']'
    FROM #prod p JOIN #lj l ON l.loja = p.loja JOIN #pd d ON d.produto = p.produto
    GROUP BY l.id, p.data, d.id
    ORDER BY l.id, p.data, d.id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5);

SELECT CAST('{"parte":"' + @parte + '","inicio":"' + CONVERT(char(10), @inicio, 120) + '","fim":"' + CONVERT(char(10), @fim, 120)
     + '","gerado_em":"' + CONVERT(varchar(19), GETDATE(), 126)
     + '","limite":' + CONVERT(varchar(20), @limite)
     + ',"lojas":[' + ISNULL(@lojas, '') + '],"produtos":[' + ISNULL(@produtos, '')
     + '],"vendas":[' + ISNULL(@vendas, '') + '],"prod":[' + ISNULL(@prods, '') + ']}' AS nvarchar(max)) AS payload;
-- </corpo>
END
GO
