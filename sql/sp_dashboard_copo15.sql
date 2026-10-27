/*
  Procedure usada pelo runner do GitHub (scripts/exec-sp.ps1) para o dashboard "Ação Copo 15 Anos".
  Retorna UMA linha com a coluna [payload] contendo um JSON compacto. Cada chamada traz só uma @parte:
    'vendas'             comandas, faturamento, comandas acima do limite e copos entregues (todas as lojas)
    'produtos_espetto'   produtos das lojas Espetto
    'produtos_parceiros' produtos de Villa Lobos, Cabo Frio Collab e Península
  As três partes são chamadas em paralelo, em blocos de 7 dias. As tabelas de origem têm índice em
  dataVenda (sql/indices_dataVenda.sql); OPTION (RECOMPILE) faz o otimizador usar as datas reais.

  Copos entregues: quantidade do item de venda @item ('COPO ESPETTO ANIVER 15', lançado a R$ 0) e número de
  comandas em que ele foi lançado, por loja/dia, na parte 'vendas'. Fontes: produtos do Espetto, da Mané loja 13
  (Cabo Frio Collab) e da Zig (Villa Lobos). Península (PDV próprio, base bd_peninsula_frest): item @item_pen.

  Península: DATA em texto (dd/mm/aaaa). Comanda = NUM_LANCTO. Valor da comanda = BD_VENDAS.TOT_CUPON nos dias
  em que a BD_VENDAS tem dados; nos outros dias, soma de BD_PRODUTOS.TOTAL da comanda.

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
DECLARE @item nvarchar(100) = N'COPO ESPETTO ANIVER 15'; -- item lançado na comanda quando o copo é entregue
DECLARE @item_pen nvarchar(100) = N'COPO NIVER ESPETTO';    -- o mesmo item no PDV da Península
DECLARE @pen nvarchar(150) = N'ESP PENÍNSULA';

IF OBJECT_ID('tempdb..#com') IS NOT NULL DROP TABLE #com;
IF OBJECT_ID('tempdb..#v') IS NOT NULL DROP TABLE #v;
IF OBJECT_ID('tempdb..#t') IS NOT NULL DROP TABLE #t;
IF OBJECT_ID('tempdb..#pg') IS NOT NULL DROP TABLE #pg;
IF OBJECT_ID('tempdb..#ven') IS NOT NULL DROP TABLE #ven;
IF OBJECT_ID('tempdb..#prod') IS NOT NULL DROP TABLE #prod;
IF OBJECT_ID('tempdb..#lj') IS NOT NULL DROP TABLE #lj;
IF OBJECT_ID('tempdb..#pd') IS NOT NULL DROP TABLE #pd;
IF OBJECT_ID('tempdb..#cp') IS NOT NULL DROP TABLE #cp;
IF OBJECT_ID('tempdb..#cc') IS NOT NULL DROP TABLE #cc;
IF OBJECT_ID('tempdb..#pp') IS NOT NULL DROP TABLE #pp;
IF OBJECT_ID('tempdb..#pv') IS NOT NULL DROP TABLE #pv;

-- valor = faturamento da comanda (consumo + serviço - cortesia); consumo = base da regra do copo
CREATE TABLE #com (loja nvarchar(150), data date, valor decimal(16, 2), consumo decimal(16, 2));
-- comandas/serviço/cortesia por comanda (Espetto e Mané); chaves em varchar(50) para permitir hash join
CREATE TABLE #v  (base char(1), loja nvarchar(150), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), consumo float);
CREATE TABLE #t  (base char(1), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), servico float);
CREATE TABLE #pg (base char(1), cod varchar(50), data date, tipo varchar(50), comanda varchar(50), cortesia float);
-- copos entregues por loja/dia: cop = quantidade do item, ccop = comandas com o item
CREATE TABLE #cp (loja nvarchar(150), data date, cop decimal(16, 3), ccop int);
CREATE TABLE #cc (loja nvarchar(150), data date, comanda nvarchar(100), valor decimal(16, 2), copos decimal(16, 3));
-- Península: itens (#pp) e comandas da BD_VENDAS (#pv) do período
CREATE TABLE #pp (data date, comanda nvarchar(100), item nvarchar(300), qtd decimal(16, 3), total decimal(16, 2));
CREATE TABLE #pv (data date, comanda nvarchar(100), valor decimal(16, 2));
IF @parte IN ('vendas', 'produtos_parceiros')
INSERT #pp (data, comanda, item, qtd, total)
SELECT TRY_CONVERT(date, DATA, 103), NUM_LANCTO, UPPER(LTRIM(RTRIM(DESC_RES))), QTE, TOTAL
FROM bd_peninsula_frest.dbo.BD_PRODUTOS
WHERE TRY_CONVERT(date, DATA, 103) >= @inicio AND TRY_CONVERT(date, DATA, 103) <= @fim;
IF @parte = 'vendas'
INSERT #pv (data, comanda, valor)
SELECT TRY_CONVERT(date, DATA, 103), NUM_LANCTO, SUM(TOT_CUPON)
FROM bd_peninsula_frest.dbo.BD_VENDAS
WHERE TRY_CONVERT(date, DATA, 103) >= @inicio AND TRY_CONVERT(date, DATA, 103) <= @fim
GROUP BY TRY_CONVERT(date, DATA, 103), NUM_LANCTO;

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

-- Península: TOT_CUPON da BD_VENDAS; nos dias sem BD_VENDAS, soma dos produtos da comanda
INSERT #com (loja, data, valor, consumo)
SELECT @pen, data, valor, valor FROM #pv;
INSERT #com (loja, data, valor, consumo)
SELECT @pen, data, SUM(total), SUM(total)
FROM #pp
WHERE data NOT IN (SELECT DISTINCT data FROM #pv)
GROUP BY data, comanda;

-- Copos entregues (item @item, não cancelado)
INSERT #cp (loja, data, cop, ccop)
SELECT l.lojas, CAST(p.dataVenda AS date), SUM(p.quantidade),
       COUNT(DISTINCT CAST(p.codLoja AS varchar(50)) + '|' + CAST(p.tipoVenda AS varchar(50)) + '|' + CAST(p.controle AS varchar(50)))
FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2 p
JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l ON l.id = p.codLoja
WHERE p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY l.lojas, CAST(p.dataVenda AS date)
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #cp (loja, data, cop, ccop)
SELECT 'MAN CABO FRIO COLLAB', CAST(p.dataVenda AS date), SUM(p.quantidade),
       COUNT(DISTINCT CAST(p.tipoVenda AS varchar(50)) + '|' + CAST(p.controle AS varchar(50)))
FROM bd_mane_2025.dbo.BD_PRODUTOS_V2 p
WHERE p.codLoja = 13 AND p.cancelado = 'N' AND UPPER(LTRIM(RTRIM(p.descricaoProduto))) = @item
  AND p.dataVenda >= @ini AND p.dataVenda < @fimx
GROUP BY CAST(p.dataVenda AS date)
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #cp (loja, data, cop, ccop)
SELECT LOJA, DATA, SUM(QUANTIDADE), COUNT(DISTINCT COMANDAS)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim AND UPPER(LTRIM(RTRIM(PRODUTO))) = @item
GROUP BY LOJA, DATA
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);
-- Comandas com o item de copo lançado: consumo (sem serviço) e unidades do item.
INSERT #cc (loja, data, comanda, valor, copos)
SELECT v.loja, v.data, v.comanda, CAST(v.consumo AS decimal(16, 2)), p.copos
FROM #v v
JOIN (
    SELECT CAST(codLoja AS varchar(50)) AS cod, CAST(dataVenda AS date) AS data,
           CAST(tipoVenda AS varchar(50)) AS tipo, CAST(controle AS varchar(50)) AS comanda,
           SUM(quantidade) AS copos
    FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2
    WHERE cancelado = 'N' AND UPPER(LTRIM(RTRIM(descricaoProduto))) = @item
      AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY CAST(codLoja AS varchar(50)), CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
) p ON p.cod = v.cod AND p.data = v.data AND p.tipo = v.tipo AND p.comanda = v.comanda
WHERE v.base = 'E'
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #cc (loja, data, comanda, valor, copos)
SELECT v.loja, v.data, v.comanda, CAST(v.consumo AS decimal(16, 2)), p.copos
FROM #v v
JOIN (
    SELECT CAST(dataVenda AS date) AS data, CAST(tipoVenda AS varchar(50)) AS tipo,
           CAST(controle AS varchar(50)) AS comanda, SUM(quantidade) AS copos
    FROM bd_mane_2025.dbo.BD_PRODUTOS_V2
    WHERE codLoja = 13 AND cancelado = 'N' AND UPPER(LTRIM(RTRIM(descricaoProduto))) = @item
      AND dataVenda >= @ini AND dataVenda < @fimx
    GROUP BY CAST(dataVenda AS date), CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
) p ON p.data = v.data AND p.tipo = v.tipo AND p.comanda = v.comanda
WHERE v.base = 'M'
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

INSERT #cc (loja, data, comanda, valor, copos)
SELECT LOJA, DATA, CAST(COMANDAS AS nvarchar(100)), SUM(VALOR),
       SUM(CASE WHEN UPPER(LTRIM(RTRIM(PRODUTO))) = @item THEN QUANTIDADE ELSE 0 END)
FROM master.dbo.vw_faturamento_villa_lobos_cupom
WHERE DATA >= @inicio AND DATA <= @fim
GROUP BY LOJA, DATA, COMANDAS
HAVING SUM(CASE WHEN UPPER(LTRIM(RTRIM(PRODUTO))) = @item THEN QUANTIDADE ELSE 0 END) > 0
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

-- Península: copos (item @item_pen) e comandas com copo
INSERT #cp (loja, data, cop, ccop)
SELECT @pen, data, SUM(qtd), COUNT(DISTINCT comanda) FROM #pp WHERE item = @item_pen GROUP BY data;
INSERT #cc (loja, data, comanda, valor, copos)
SELECT @pen, c.data, c.comanda, ISNULL(v.valor, t.total), c.copos
FROM (SELECT data, comanda, SUM(qtd) AS copos FROM #pp WHERE item = @item_pen GROUP BY data, comanda) c
JOIN (SELECT data, comanda, SUM(total) AS total FROM #pp GROUP BY data, comanda) t ON t.data = c.data AND t.comanda = c.comanda
LEFT JOIN #pv v ON v.data = c.data AND v.comanda = c.comanda;
END

-- Vendas por loja/dia: comanda conta para o copo quando o CONSUMO (sem taxa de serviço) é maior que @limite
SELECT loja, data,
       SUM(valor) AS fat, COUNT(*) AS com,
       SUM(CASE WHEN consumo > @limite THEN 1 ELSE 0 END) AS c250,
       SUM(CASE WHEN consumo > @limite THEN consumo ELSE 0 END) AS f250,
       CAST(0 AS decimal(16, 3)) AS cop, 0 AS ccop
INTO #ven
FROM #com
WHERE loja IS NOT NULL
GROUP BY loja, data
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

-- junta os copos entregues às vendas do dia (e cria a linha se só houver copo)
UPDATE v SET cop = c.cop, ccop = c.ccop
FROM #ven v JOIN (SELECT loja, data, SUM(cop) AS cop, SUM(ccop) AS ccop FROM #cp GROUP BY loja, data) c
  ON c.loja = v.loja AND c.data = v.data;
INSERT #ven (loja, data, fat, com, c250, f250, cop, ccop)
SELECT c.loja, c.data, 0, 0, 0, 0, SUM(c.cop), SUM(c.ccop)
FROM #cp c
WHERE c.loja IS NOT NULL AND NOT EXISTS (SELECT 1 FROM #ven v WHERE v.loja = c.loja AND v.data = c.data)
GROUP BY c.loja, c.data;

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

-- Produtos Península (mesmo filtro das outras lojas: quantidade >= 1 e preço unitário > R$ 1)
INSERT #prod (loja, data, produto, qtd, valor)
SELECT @pen, data, item, SUM(qtd), SUM(total)
FROM #pp
WHERE qtd >= 1 AND total / qtd > 1
GROUP BY data, item;
END

DELETE FROM #prod WHERE loja IS NULL OR qtd <= 0;
UPDATE #prod SET produto = UPPER(LTRIM(RTRIM(
    REPLACE(REPLACE(REPLACE(ISNULL(produto, ''), CHAR(9), ' '), CHAR(10), ' '), CHAR(13), ' '))));

-- Dicionários (índices a partir de 0)
SELECT ROW_NUMBER() OVER (ORDER BY loja) - 1 AS id, loja
INTO #lj FROM (SELECT loja FROM #ven UNION SELECT loja FROM #prod UNION SELECT loja FROM #cc) x;
SELECT ROW_NUMBER() OVER (ORDER BY produto) - 1 AS id, produto
INTO #pd FROM (SELECT DISTINCT produto FROM #prod) x;

DECLARE @lojas nvarchar(max), @produtos nvarchar(max), @vendas nvarchar(max), @prods nvarchar(max), @comandas nvarchar(max);

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
         + CAST(v.c250 AS varchar(10)) + ',' + CONVERT(varchar(30), CAST(v.f250 AS decimal(16, 2))) + ','
         + CONVERT(varchar(30), CAST(v.cop AS decimal(16, 0))) + ',' + CAST(v.ccop AS varchar(10)) + ']'
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

SELECT @comandas = STUFF((
    SELECT ',[' + CAST(l.id AS varchar(10)) + ',"' + CONVERT(char(10), c.data, 120) + '","'
         + REPLACE(REPLACE(ISNULL(c.comanda, ''), '\', '\\'), '"', '\"') + '",'
         + CONVERT(varchar(30), CAST(c.valor AS decimal(16, 2))) + ','
         + CONVERT(varchar(30), CAST(c.copos AS decimal(16, 3))) + ']'
    FROM #cc c JOIN #lj l ON l.loja = c.loja
    ORDER BY l.id, c.data, c.comanda FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 1, '')
OPTION (MAX_GRANT_PERCENT = 5, RECOMPILE);

SELECT CAST('{"parte":"' + @parte + '","inicio":"' + CONVERT(char(10), @inicio, 120) + '","fim":"' + CONVERT(char(10), @fim, 120)
     + '","gerado_em":"' + CONVERT(varchar(19), GETDATE(), 126)
     + '","limite":' + CONVERT(varchar(20), @limite)
     + ',"lojas":[' + ISNULL(@lojas, '') + '],"produtos":[' + ISNULL(@produtos, '')
     + '],"vendas":[' + ISNULL(@vendas, '') + '],"prod":[' + ISNULL(@prods, '')
     + '],"comandas_copo":[' + ISNULL(@comandas, '') + ']}' AS nvarchar(max)) AS payload;
-- </corpo>
END
GO
