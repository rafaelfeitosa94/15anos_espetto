/*
  Procedure usada pelo runner do GitHub (scripts/exec-sp.ps1) para o dashboard "Ação Copo 15 Anos".
  Retorna UMA linha com a coluna [payload] contendo um JSON compacto. Cada chamada traz só uma @parte:
    'vendas'             comandas, faturamento e comandas acima do limite (todas as lojas)
    'produtos_espetto'   produtos das lojas Espetto
    'produtos_parceiros' produtos de Villa Lobos e Cabo Frio Collab
  As três partes são chamadas em paralelo, em blocos de 7 dias. As tabelas de origem têm índice em
  dataVenda (sql/indices_dataVenda.sql); OPTION (RECOMPILE) faz o otimizador usar as datas reais.

  Regras (iguais às views vw_faturamento_espetto_cupom / vw_faturamento_cabofrio_collab_cupom e às views
  *_ano_anterior, para comparar 2026 x 2025 com a mesma conta):
  - Faturamento da comanda = consumo (valLiquido - valAcrescimo) + taxa de serviço - cortesias da comanda.
  - Comanda conta para o copo quando o CONSUMO (sem taxa de serviço) é MAIOR que @limite (todas as lojas).
  - Espetto: base bd_espetto_2025; Cabo Frio Collab: base bd_mane_2025, loja 13; Villa Lobos: Zig
    (vw_faturamento_villa_lobos_cupom, valor da comanda sem serviço separado).
  - Produtos: lógica da prod_15_anos_espetto (Espetto), base Mané loja 13 (Collab) e Zig (Villa Lobos).

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
IF OBJECT_ID('tempdb..#v') IS NOT NULL DROP TABLE #v;
IF OBJECT_ID('tempdb..#t') IS NOT NULL DROP TABLE #t;
IF OBJECT_ID('tempdb..#pg') IS NOT NULL DROP TABLE #pg;
IF OBJECT_ID('tempdb..#ven') IS NOT NULL DROP TABLE #ven;
IF OBJECT_ID('tempdb..#prod') IS NOT NULL DROP TABLE #prod;
IF OBJECT_ID('tempdb..#lj') IS NOT NULL DROP TABLE #lj;
IF OBJECT_ID('tempdb..#pd') IS NOT NULL DROP TABLE #pd;

-- valor = faturamento da comanda (consumo + serviço - cortesia); consumo = base da regra do copo
CREATE TABLE #com (loja nvarchar(150), data date, valor decimal(16, 2), consumo decimal(16, 2));
-- comandas/serviço/cortesia por comanda (Espetto e Mané); chaves em varchar(50) para permitir hash join
CREATE TABLE #v  (base char(1), loja nvarchar(150), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), consumo float);
CREATE TABLE #t  (base char(1), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), servico float);
CREATE TABLE #pg (base char(1), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), cortesia float);
CREATE TABLE #prod (loja nvarchar(150), data date, produto nvarchar(300), qtd decimal(16, 3), valor decimal(16, 2));

IF @parte = 'vendas'
BEGIN
-- Espetto (E) e Cabo Frio Collab / Mané loja 13 (M): mesma lógica da vw_faturamento_espetto_cupom e da
-- vw_faturamento_cabofrio_collab_cupom (serviço e cortesia somados por comanda), com filtro de data.
INSERT #v (base, loja, cod, data, tipo, comanda, consumo)
SELECT 'E', l.lojas, CAST(v.codLoja AS varchar(50)), CAST(v.dataVenda AS date), CAST(v.tipoVenda AS varchar(50)),
       CAST(v.controle AS varchar(50)), SUM(v.valLiquido) - SUM(v.valAcrescimo)
FROM bd_espetto_2025.dbo.bd_vendas_v3 v
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = v.codLoja
WHERE v.cancelada = 'N' AND v.dataVenda >= @ini AND v.dataVenda < @fimx
GROUP BY l.lojas, CAST(v.codLoja AS varchar(50)), CAST(v.dataVenda AS date), CAST(v.tipoVenda AS varchar(50)), CAST(v.controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #v (base, loja, cod, data, tipo, comanda, consumo)
SELECT 'M', 'MAN CABO FRIO COLLAB', '13', CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)),
       CAST(controle AS varchar(50)), SUM(valLiquido) - SUM(valAcrescimo)
FROM bd_mane_2025.dbo.bd_vendas_v3
WHERE codLoja = 13 AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
GROUP BY CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #t (base, cod, data, tipo, comanda, servico)
SELECT 'E', CAST(codLoja AS varchar(50)), CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50)), SUM(valTaxaServico)
FROM bd_espetto_2025.dbo.BD_TC_V2
WHERE cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
GROUP BY CAST(codLoja AS varchar(50)), CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #t (base, cod, data, tipo, comanda, servico)
SELECT 'M', '13', CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50)), SUM(valTaxaServico)
FROM bd_mane_2025.dbo.BD_TC_V2
WHERE codLoja = 13 AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
GROUP BY CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #pg (base, cod, data, tipo, comanda, cortesia)
SELECT 'E', CAST(codLoja AS varchar(50)), CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50)), SUM(valor)
FROM bd_espetto_2025.dbo.BD_PAGAMENTOS_V2
WHERE receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
GROUP BY CAST(codLoja AS varchar(50)), CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #pg (base, cod, data, tipo, comanda, cortesia)
SELECT 'M', '13', CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50)), SUM(valor)
FROM bd_mane_2025.dbo.BD_PAGAMENTOS_V2
WHERE codLoja = 13 AND receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N' AND dataVenda >= @ini AND dataVenda < @fimx
GROUP BY CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #com (loja, data, valor, consumo)
SELECT v.loja, v.data, v.consumo + ISNULL(t.servico, 0) - ISNULL(pg.cortesia, 0), v.consumo
FROM #v v
LEFT JOIN #t t ON t.base = v.base AND t.cod = v.cod AND t.data = v.data AND t.tipo = v.tipo AND t.comanda = v.comanda
LEFT JOIN #pg pg ON pg.base = v.base AND pg.cod = v.cod AND pg.data = v.data AND pg.tipo = v.tipo AND pg.comanda = v.comanda
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

-- Villa Lobos (Zig): valor por comanda (sem taxa de serviço separada)
INSERT #com (loja, data, valor, consumo)
SELECT LOJA, DATA, SUM(VALOR), SUM(VALOR)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim
GROUP BY LOJA, DATA, COMANDAS
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);
END

-- Vendas por loja/dia: comanda conta para o copo quando o CONSUMO (sem taxa de serviço) é maior que @limite
SELECT loja, data,
       SUM(valor) AS fat, COUNT(*) AS com,
       SUM(CASE WHEN consumo > @limite THEN 1 ELSE 0 END) AS c250,
       SUM(CASE WHEN consumo > @limite THEN consumo ELSE 0 END) AS f250
INTO #ven
FROM #com
WHERE loja IS NOT NULL
GROUP BY loja, data
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

IF @parte = 'produtos_espetto'
-- Produtos Espetto (lógica da prod_15_anos_espetto)
INSERT #prod (loja, data, produto, qtd, valor)
SELECT l.lojas, CAST(p.dataVenda AS date), p.descricaoProduto, SUM(p.quantidade), SUM(p.valTotal)
FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
LEFT JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = p.codLoja
WHERE p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY l.lojas, CAST(p.dataVenda AS date), p.descricaoProduto
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

IF @parte = 'produtos_parceiros'
BEGIN
-- Produtos Villa Lobos
INSERT #prod (loja, data, produto, qtd, valor)
SELECT LOJA, DATA, PRODUTO, SUM(QUANTIDADE), SUM(VALOR)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim
GROUP BY LOJA, DATA, PRODUTO
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

-- Produtos Cabo Frio Collab (base Mané, loja 13)
INSERT #prod (loja, data, produto, qtd, valor)
SELECT 'MAN CABO FRIO COLLAB', CAST(p.dataVenda AS date), p.descricaoProduto, SUM(p.quantidade), SUM(p.valTotal)
FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
WHERE p.codLoja = 13 AND p.cancelado = 'N' AND p.quantidade >= 1 AND p.valUnitario > 1
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY CAST(p.dataVenda AS date), p.descricaoProduto
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);
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
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

SELECT @produtos = STUFF((
    SELECT ',"' + REPLACE(REPLACE(produto, '\', '\\'), '"', '\"') + '"'
    FROM #pd ORDER BY id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

SELECT @vendas = STUFF((
    SELECT ',[' + CAST(l.id AS varchar(10)) + ',"' + CONVERT(char(10), v.data, 120) + '",'
         + CONVERT(varchar(30), CAST(v.fat AS decimal(16, 2))) + ',' + CAST(v.com AS varchar(10)) + ','
         + CAST(v.c250 AS varchar(10)) + ',' + CONVERT(varchar(30), CAST(v.f250 AS decimal(16, 2))) + ']'
    FROM #ven v JOIN #lj l ON l.loja = v.loja
    ORDER BY l.id, v.data FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

SELECT @prods = STUFF((
    SELECT ',[' + CAST(l.id AS varchar(10)) + ',"' + CONVERT(char(10), p.data, 120) + '",'
         + CAST(d.id AS varchar(10)) + ',' + CONVERT(varchar(30), CAST(SUM(p.qtd) AS decimal(16, 3))) + ','
         + CONVERT(varchar(30), CAST(SUM(p.valor) AS decimal(16, 2))) + ']'
    FROM #prod p JOIN #lj l ON l.loja = p.loja JOIN #pd d ON d.produto = p.produto
    GROUP BY l.id, p.data, d.id
    ORDER BY l.id, p.data, d.id FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

SELECT CAST('{"parte":"' + @parte + '","inicio":"' + CONVERT(char(10), @inicio, 120) + '","fim":"' + CONVERT(char(10), @fim, 120)
     + '","gerado_em":"' + CONVERT(varchar(19), GETDATE(), 126)
     + '","limite":' + CONVERT(varchar(20), @limite)
     + ',"lojas":[' + ISNULL(@lojas, '') + '],"produtos":[' + ISNULL(@produtos, '')
     + '],"vendas":[' + ISNULL(@vendas, '') + '],"prod":[' + ISNULL(@prods, '') + ']}' AS nvarchar(max)) AS payload;
-- </corpo>
END
GO
