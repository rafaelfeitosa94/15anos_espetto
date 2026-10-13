/*
  Índices por data de venda para a procedure dbo.sp_dashboard_copo15 (consulta pelo gateway).
  As tabelas eram heaps sem índice: cada chamada lia a tabela inteira (até 11 milhões de linhas)
  e, com o servidor ocupado, passava do limite de 110 s do gateway.

  - Índice não clusterizado comum (não filtrado: índices filtrados fazem falhar inserções de sessões
    com QUOTED_IDENTIFIER OFF, o que poderia quebrar o ETL).
  - Chave dataVenda + colunas usadas pela procedure em INCLUDE (índice de cobertura).
  - SQL Express não cria índice ONLINE: a tabela fica bloqueada para escrita durante a criação.
  - Idempotente: só cria se ainda não existir.
*/
SET LOCK_TIMEOUT 60000;  -- desiste se não conseguir o bloqueio em 60 s (não trava o ETL)

-- ===================== bd_espetto_2025 =====================
USE bd_espetto_2025;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bd_vendas_v3_dataVenda' AND object_id = OBJECT_ID('dbo.bd_vendas_v3'))
    CREATE NONCLUSTERED INDEX IX_bd_vendas_v3_dataVenda ON dbo.bd_vendas_v3 (dataVenda)
    INCLUDE (codLoja, cancelada, tipoVenda, controle, valLiquido, valAcrescimo);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_TC_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_TC_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_TC_V2_dataVenda ON dbo.BD_TC_V2 (dataVenda)
    INCLUDE (codLoja, cancelada, tipoVenda, controle, valTaxaServico);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_PAGAMENTOS_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_PAGAMENTOS_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_PAGAMENTOS_V2_dataVenda ON dbo.BD_PAGAMENTOS_V2 (dataVenda)
    INCLUDE (codLoja, cancelada, receita, tipoVenda, controle, valor);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_PRODUTOS_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_PRODUTOS_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_PRODUTOS_V2_dataVenda ON dbo.BD_PRODUTOS_V2 (dataVenda)
    INCLUDE (codLoja, cancelado, quantidade, valUnitario, valTotal, descricaoProduto);
GO

-- ===================== bd_mane_2025 (Cabo Frio Collab) =====================
SET LOCK_TIMEOUT 60000;
USE bd_mane_2025;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_bd_vendas_v3_dataVenda' AND object_id = OBJECT_ID('dbo.bd_vendas_v3'))
    CREATE NONCLUSTERED INDEX IX_bd_vendas_v3_dataVenda ON dbo.bd_vendas_v3 (dataVenda)
    INCLUDE (codLoja, cancelada, tipoVenda, controle, valLiquido, valAcrescimo);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_TC_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_TC_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_TC_V2_dataVenda ON dbo.BD_TC_V2 (dataVenda)
    INCLUDE (codLoja, cancelada, tipoVenda, controle, valTaxaServico);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_PAGAMENTOS_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_PAGAMENTOS_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_PAGAMENTOS_V2_dataVenda ON dbo.BD_PAGAMENTOS_V2 (dataVenda)
    INCLUDE (codLoja, cancelada, receita, tipoVenda, controle, valor);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BD_PRODUTOS_V2_dataVenda' AND object_id = OBJECT_ID('dbo.BD_PRODUTOS_V2'))
    CREATE NONCLUSTERED INDEX IX_BD_PRODUTOS_V2_dataVenda ON dbo.BD_PRODUTOS_V2 (dataVenda)
    INCLUDE (codLoja, cancelado, quantidade, valUnitario, valTotal, descricaoProduto);
GO
