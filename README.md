# Dashboard – Ação Copo 15 Anos (Espetto Carioca)

Monitoramento da ação de 15/10 a 30/11/2026: cada comanda acima de **R$ 250,00** ganha um copo comemorativo.

## Como funciona

```
GitHub Actions (tarefa do SRVTESTE e agenda do GitHub de hora em hora, 11h40–23h40, ou botão "Atualizar dados")
   └─> runner no SRVTESTE (rede da empresa) ─> SQL Server AD01\BARTENDER (dbo.sp_dashboard_copo15)
          └─> commit de data/dados.json pela API do GitHub ─> Vercel publica o dashboard
```

- `public/`: página do dashboard (login, filtros, KPIs, ranking, top 10 produtos, mapa, tema claro/escuro),
  no padrão visual do Manual da Marca Espetto Carioca (imagens em `public/img/`).
- `api/login.js`: login (cookie HttpOnly assinado, 12h).
- `api/data.js`: entrega `data/dados.json` só para usuários autenticados.
- `api/atualizar.js`: botão "Atualizar dados" (dispara o workflow) e status do servidor de atualização.
- `.github/workflows/atualizar-dados.yml`: agenda e execução no runner (`runs-on: [self-hosted, windows, sqlserver]`).
- `scripts/atualizar-sql.js` + `scripts/exec-sp.ps1`: consulta, consolidação e publicação (rodam no runner).
- `lib/consolidar.js`: consolidação no formato de `data/dados.json`.
- `sql/`: procedure `sp_dashboard_copo15`, índices em `dataVenda` e script de teste.
- `runner/instalar_runner.ps1`: instalação do runner no SRVTESTE.
- `extrator/`: `gerar_ano_anterior.py` e `complementar_ano_anterior.py` (dados de 2025) e o extrator Python antigo (plano B, tarefa desativada).

Instalação do runner, secrets e variáveis: **[docs/CONFIGURAR_RUNNER.md](docs/CONFIGURAR_RUNNER.md)**.

## Regras de cálculo

| Indicador | Regra |
|---|---|
| Faturamento | soma por comanda de consumo (valLiquido − valAcrescimo) + taxa de serviço − cortesias da comanda (mesma conta das views `vw_faturamento_*_cupom`) |
| Comandas > R$ 250 | comandas com **consumo** (sem taxa de serviço) maior que R$ 250, em todas as lojas |
| Comandas | total de comandas distintas |
| Ticket médio | faturamento ÷ comandas |
| Copos entregues | quantidade do item de venda **COPO ESPETTO ANIVER 15** (lançado a R$ 0) nas comandas: produtos do Espetto, da Mané loja 13 (Cabo Frio Collab) e da Zig (Villa Lobos). Península (PDV próprio, base `bd_peninsula_frest`): item **COPO NIVER ESPETTO** |
| Comandas com copo | comandas em que o item do copo foi lançado |
| Estoque usado | copos entregues acumulados desde 15/10 até a data final do filtro, versus copos enviados à loja |
| Recarga do banco | o Fabric recarrega as tabelas de vendas, produtos e pagamentos várias vezes ao dia; se um dia já fechado vier com bem menos comandas, copos entregues ou valor de produtos que a versão publicada, o runner espera 5 min e consulta de novo (até 3 vezes) e, se persistir, mantém a versão publicada dessas lojas/dias (vendas, copos, produtos e comandas com copo) |
| vs 2025 | mesmos indicadores nas **mesmas datas** de 2025 (15/10–30/11/2025), para as lojas selecionadas |
| Detalhe de copos | clique em **Copos entregues** para ver data, loja, número da comanda, unidades do copo e valor do consumo; acima de R$ 250 em laranja e a partir de R$ 500 em vermelho |

Fontes: bases `bd_espetto_2025` (Espetto) e `bd_mane_2025` loja 13 (Cabo Frio Collab), Zig (Villa Lobos), pela
procedure `dbo.sp_dashboard_copo15`.

O runner consulta o detalhe das comandas diretamente nas tabelas de origem, em blocos de datas, sem exigir atualização da procedure no SQL Server.

### Ano anterior (comparação)

Views criadas em `master` (script `sql/views_ano_anterior.sql`), com a mesma estrutura das atuais e filtro de
15/10/2025 a 30/11/2025:

| View | Origem |
|---|---|
| `vw_faturamento_espetto_cupom_ano_anterior` | `vw_faturamento_espetto_cupom` |
| `vw_faturamento_cabofrio_collab_cupom_ano_anterior` | `vw_faturamento_cabofrio_collab_cupom` |
| `prod_15_anos_espetto_ano_anterior` | `prod_15_anos_espetto` |
| `prod_15_anos_cabofrio_collab_ano_anterior` | produtos da base Mané, loja 13 |

Todas têm a coluna extra `VALOR_CONSUMO` (base da regra do copo). Villa Lobos não tem ano anterior, porque a Zig
começa em 22/01/2026. Os dados de 2025 não mudam: `data/ano_anterior.json` é gerado uma vez com
`python extrator/gerar_ano_anterior.py`.

Duas lojas têm parte de 2025 só na tabela diária antiga `bd_espetto.dbo.[BD VENDAS]` ([Faturamento Bruto] -
DELIVERY, sem comandas nem produtos). `python extrator/complementar_ano_anterior.py` (rodar depois do
`gerar_ano_anterior.py`) acrescenta esses dias:

| Loja | BD VENDAS (só faturamento) | Degust (com comandas) |
|---|---|---|
| Grande Rio | 15/10 a 09/11/2025 | a partir de 11/12/2025 (de 10/11 a 10/12 não há dados) |
| Carrefour Caxias | 15/10 a 05/11/2025 | a partir de 06/11/2025 |

No dashboard essas lojas são comparadas com 2026 só nas mesmas datas (marcadas com * no ranking): o
faturamento nos dias com dado em 2025; comandas, ticket médio e > R$ 250 nos dias com comandas em 2025.

## Variáveis de ambiente na Vercel

| Nome | Valor |
|---|---|
| `DASH_USER` | usuário de acesso |
| `DASH_PASS` | senha de acesso |
| `AUTH_SECRET` | texto aleatório longo (assinatura do cookie) |
| `GH_TOKEN` | token fine-grained com *Actions: Read and write* no repositório (botão "Atualizar dados") |

Secrets do GitHub Actions: `DB_SERVER` (`ad01,1433`), `DB_USER`, `DB_PASSWORD`.

## Rodar localmente

```bash
node dev-server.js
```

## Atualização manual

Clique em **Atualizar dados** no dashboard, rode o workflow manualmente no GitHub
(*Actions → Atualizar dados → Run workflow*) ou execute `extrator\atualizar.bat` (plano B local).

## Península (bd_peninsula_frest)

PDV próprio, fora do Degust. `BD_PRODUTOS` (itens; DATA em texto dd/mm/aaaa; comanda = NUM_LANCTO) e `BD_VENDAS`
(TOT_CUPON por comanda). Valor da comanda = TOT_CUPON nos dias em que a `BD_VENDAS` tem dados; nos outros dias, a
soma de `BD_PRODUTOS.TOTAL` da comanda. 2025 (comparação): `BD_VENDAS` de 15/10 a 30/11/2025, via `extrator/complementar_ano_anterior.py`. Copos = item
**COPO NIVER ESPETTO**. No detalhamento, Faturamento = TOT_PAGO da `BD_VENDAS`.
Sem dados de 2025 (a base começa em 02/01/2026).

Ranking de lojas: coluna **Chopp 15 anos** = quantidade vendida de **CHOPP P/ COPO 15 ANOS ESPETTO** (Degust) e
**CHOPP P/COPO 15ANOS** (Zig, Villa Lobos) no período do filtro, a partir dos produtos.
