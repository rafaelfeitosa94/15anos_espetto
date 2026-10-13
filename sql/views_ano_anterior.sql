/*
  Views do ANO ANTERIOR (mesmo período da ação, 15/10/2025 a 30/11/2025) para comparação no dashboard.
  Mesma estrutura das views atuais (consultada com sp_helptext em 13/10/2026), com o filtro de data
  aplicado também dentro de cada subconsulta (usa os índices em dataVenda).

  Nas subconsultas, codLoja/tipoVenda/controle (varchar(max) nas tabelas) são convertidos para varchar(50):
  o SQL Server não faz hash join em colunas (max), e sem isso a junção por comanda fica muito lenta.

  Coluna extra VALOR_CONSUMO (= valLiquido - valAcrescimo da comanda, sem taxa de serviço e sem cortesia):
  é a base da regra "comanda acima de R$ 250" usada no dashboard, para comparar os dois anos com a mesma regra.

    vw_faturamento_espetto_cupom_ano_anterior        <- vw_faturamento_espetto_cupom
    vw_faturamento_cabofrio_collab_cupom_ano_anterior <- vw_faturamento_cabofrio_collab_cupom
    prod_15_anos_espetto_ano_anterior                 <- prod_15_anos_espetto
    prod_15_anos_cabofrio_collab_ano_anterior         <- produtos da base Mané, loja 13 (Cabo Frio Collab)

  Villa Lobos não tem view de ano anterior: os dados da Zig começam em 22/01/2026 (loja nova).
*/
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

IF OBJECT_ID('dbo.vw_faturamento_espetto_cupom_ano_anterior', 'V') IS NOT NULL
    DROP VIEW dbo.vw_faturamento_espetto_cupom_ano_anterior;
GO
CREATE VIEW dbo.vw_faturamento_espetto_cupom_ano_anterior AS
WITH vendas AS (
    SELECT
        CAST(v.codLoja AS varchar(50)) AS codloja,
        l.lojas AS loja,
        v.dataVenda AS data,
        CAST(v.tipoVenda AS varchar(50)) AS tipo_venda,
        SUM(v.valLiquido) AS valor,
        SUM(v.valAcrescimo) AS acrescimo,
        CAST(v.controle AS varchar(50)) AS comanda,
        l.MUNICIPIO AS municipio,
        l.UF AS uf
    FROM bd_espetto_2025.dbo.bd_vendas_v3 v
    INNER JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST l
        ON l.id = v.codLoja
    WHERE v.cancelada = 'N'
      AND v.dataVenda >= '20251015' AND v.dataVenda < '20251201'
    GROUP BY CAST(v.codLoja AS varchar(50)), v.dataVenda, CAST(v.controle AS varchar(50)), CAST(v.tipoVenda AS varchar(50)), l.lojas, l.MUNICIPIO, l.UF
),
tc AS (
    SELECT
        CAST(codLoja AS varchar(50)) AS codloja,
        dataVenda AS data,
        CAST(tipoVenda AS varchar(50)) AS tipo_venda,
        CAST(controle AS varchar(50)) AS comanda,
        SUM(qtdCliente) AS qtdCliente,
        SUM(valTaxaServico) AS servico
    FROM bd_espetto_2025.dbo.BD_TC_V2
    WHERE cancelada = 'N'
      AND dataVenda >= '20251015' AND dataVenda < '20251201'
    GROUP BY CAST(codLoja AS varchar(50)), dataVenda, CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
),
cortesia AS (
    SELECT
        CAST(codLoja AS varchar(50)) AS codloja,
        dataVenda AS data,
        CAST(tipoVenda AS varchar(50)) AS tipo_venda,
        CAST(controle AS varchar(50)) AS comanda,
        SUM(valor) AS valor_cortesia
    FROM bd_espetto_2025.dbo.BD_PAGAMENTOS_V2
    WHERE receita IN ('cortesia', 'DUO GORMET')
      AND cancelada = 'N'
      AND dataVenda >= '20251015' AND dataVenda < '20251201'
    GROUP BY CAST(codLoja AS varchar(50)), dataVenda, CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
)
SELECT
    v.loja AS LOJA,
    v.data AS DATA_HORA,
    v.valor - v.acrescimo
        + ISNULL(t.servico, 0)
        - ISNULL(pg.valor_cortesia, 0) AS FATURAMENTO,
    v.comanda AS COMANDA,
    YEAR(v.data) AS ANO,
    MONTH(v.data) AS MES,
    CAST('ESPETTO' AS NVARCHAR(20)) AS MARCA,
    ISNULL(t.qtdCliente, 0) AS TC,
    v.municipio AS MUNICÍPIO,
    v.tipo_venda AS [TIPO VENDA],
    v.uf AS UF,
    v.valor - v.acrescimo AS VALOR_CONSUMO
FROM vendas v
LEFT JOIN tc t
    ON t.codloja = v.codloja AND t.data = v.data AND t.tipo_venda = v.tipo_venda AND t.comanda = v.comanda
LEFT JOIN cortesia pg
    ON pg.codloja = v.codloja AND pg.data = v.data AND pg.tipo_venda = v.tipo_venda AND pg.comanda = v.comanda;
GO

IF OBJECT_ID('dbo.vw_faturamento_cabofrio_collab_cupom_ano_anterior', 'V') IS NOT NULL
    DROP VIEW dbo.vw_faturamento_cabofrio_collab_cupom_ano_anterior;
GO
CREATE VIEW dbo.vw_faturamento_cabofrio_collab_cupom_ano_anterior AS
WITH vendas AS (
    SELECT
        CAST(v.codLoja AS varchar(50)) AS codloja,
        l.lojas AS loja,
        v.dataVenda AS data,
        CAST(v.tipoVenda AS varchar(50)) AS tipo_venda,
        CAST(v.controle AS varchar(50)) AS comanda,
        SUM(v.valLiquido) AS valor,
        SUM(v.valAcrescimo) AS acrescimo,
        l.MUNICÍPIO AS municipio,
        l.UF AS uf
    FROM bd_mane_2025.dbo.bd_vendas_v3 v
    INNER JOIN bd_mane_2025.dbo.BD_LOJAS_DEGUST l
        ON l.id = v.codLoja
    WHERE v.cancelada = 'N' AND v.codLoja = 13
      AND v.dataVenda >= '20251015' AND v.dataVenda < '20251201'
    GROUP BY CAST(v.codLoja AS varchar(50)), l.lojas, v.dataVenda, CAST(v.tipoVenda AS varchar(50)), CAST(v.controle AS varchar(50)), l.MUNICÍPIO, l.UF
),
tc AS (
    SELECT CAST(codLoja AS varchar(50)) AS codLoja, dataVenda, CAST(tipoVenda AS varchar(50)) AS tipoVenda,
           CAST(controle AS varchar(50)) AS controle,
           SUM(qtdCliente) AS qtdCliente, SUM(valTaxaServico) AS servico
    FROM bd_mane_2025.dbo.BD_TC_V2
    WHERE cancelada = 'N' AND codLoja = 13
      AND dataVenda >= '20251015' AND dataVenda < '20251201'
    GROUP BY CAST(codLoja AS varchar(50)), dataVenda, CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
),
cortesia AS (
    SELECT CAST(codLoja AS varchar(50)) AS codLoja, dataVenda, CAST(tipoVenda AS varchar(50)) AS tipoVenda,
           CAST(controle AS varchar(50)) AS controle, SUM(valor) AS valor_cortesia
    FROM bd_mane_2025.dbo.BD_PAGAMENTOS_V2
    WHERE receita IN ('cortesia', 'DUO GORMET') AND cancelada = 'N' AND codLoja = 13
      AND dataVenda >= '20251015' AND dataVenda < '20251201'
    GROUP BY CAST(codLoja AS varchar(50)), dataVenda, CAST(tipoVenda AS varchar(50)), CAST(controle AS varchar(50))
)
SELECT
    v.loja AS LOJA,
    v.data AS DATA_HORA,
    v.valor - v.acrescimo
        + ISNULL(t.servico, 0)
        - ISNULL(pg.valor_cortesia, 0) AS FATURAMENTO,
    v.comanda AS COMANDA,
    YEAR(v.data) AS ANO,
    MONTH(v.data) AS MES,
    CAST('ESPETTO' AS NVARCHAR(20)) AS MARCA,
    ISNULL(t.qtdCliente, 0) AS TC,
    v.municipio AS MUNICÍPIO,
    v.tipo_venda AS [TIPO VENDA],
    v.uf AS UF,
    v.valor - v.acrescimo AS VALOR_CONSUMO
FROM vendas v
LEFT JOIN tc t
    ON t.codLoja = v.codloja AND t.dataVenda = v.data AND t.tipoVenda = v.tipo_venda AND t.controle = v.comanda
LEFT JOIN cortesia pg
    ON pg.codLoja = v.codloja AND pg.dataVenda = v.data AND pg.tipoVenda = v.tipo_venda AND pg.controle = v.comanda;
GO

IF OBJECT_ID('dbo.prod_15_anos_espetto_ano_anterior', 'V') IS NOT NULL
    DROP VIEW dbo.prod_15_anos_espetto_ano_anterior;
GO
CREATE VIEW dbo.prod_15_anos_espetto_ano_anterior AS (
SELECT lojas AS 'LOJA',
       dataVenda AS 'DATA',
       codProduto AS 'COD. PRODUTO',
       descricaoProduto AS 'PRODUTO',
       SUM(quantidade) AS 'QUANTIDADE',
       SUM(valTotal) AS 'VALOR',
       tipoVenda AS 'TIPO VENDA',
       'ESPETTO' AS 'MARCA'
FROM bd_espetto_2025.dbo.BD_PRODUTOS_V2
LEFT JOIN bd_espetto_2025.dbo.BD_LOJAS_DEGUST
    ON bd_espetto_2025.dbo.BD_LOJAS_DEGUST.id = bd_espetto_2025.dbo.BD_PRODUTOS_V2.codLoja
WHERE cancelado = 'N' AND quantidade >= 1 AND valUnitario > 1
  AND dataVenda >= '20251015' AND dataVenda < '20251201'
GROUP BY lojas, dataVenda, codProduto, descricaoProduto, tipoVenda
);
GO

IF OBJECT_ID('dbo.prod_15_anos_cabofrio_collab_ano_anterior', 'V') IS NOT NULL
    DROP VIEW dbo.prod_15_anos_cabofrio_collab_ano_anterior;
GO
CREATE VIEW dbo.prod_15_anos_cabofrio_collab_ano_anterior AS (
SELECT 'MAN CABO FRIO COLLAB' AS 'LOJA',
       dataVenda AS 'DATA',
       codProduto AS 'COD. PRODUTO',
       descricaoProduto AS 'PRODUTO',
       SUM(quantidade) AS 'QUANTIDADE',
       SUM(valTotal) AS 'VALOR',
       tipoVenda AS 'TIPO VENDA',
       'MANE' AS 'MARCA'
FROM bd_mane_2025.dbo.BD_PRODUTOS_V2
WHERE codLoja = 13 AND cancelado = 'N' AND quantidade >= 1 AND valUnitario > 1
  AND dataVenda >= '20251015' AND dataVenda < '20251201'
GROUP BY dataVenda, codProduto, descricaoProduto, tipoVenda
);
GO
