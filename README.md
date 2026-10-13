# Dashboard – Ação Copo 15 Anos (Espetto Carioca)

Monitoramento da ação de 15/10 a 30/11/2026: cada comanda acima de **R$ 250,00** ganha um copo comemorativo.

## Como funciona

```
GitHub Actions (de hora em hora, 11h–23h, ou botão "Atualizar dados")
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
- `extrator/`: `gerar_ano_anterior.py` (dados de 2025) e o extrator Python antigo (plano B, tarefa desativada).

Instalação do runner, secrets e variáveis: **[docs/CONFIGURAR_RUNNER.md](docs/CONFIGURAR_RUNNER.md)**.

## Regras de cálculo

| Indicador | Regra |
|---|---|
| Faturamento | soma por comanda de consumo (valLiquido − valAcrescimo) + taxa de serviço − cortesias da comanda (mesma conta das views `vw_faturamento_*_cupom`) |
| Comandas > R$ 250 | comandas com **consumo** (sem taxa de serviço) maior que R$ 250, em todas as lojas |
| Comandas | total de comandas distintas |
| Ticket médio | faturamento ÷ comandas |
| Copos utilizados | comandas > R$ 250 acumuladas desde 15/10 até a data final do filtro, versus copos enviados à loja |
| vs 2025 | mesmos indicadores nas **mesmas datas** de 2025 (15/10–30/11/2025), para as lojas selecionadas |

Fontes: bases `bd_espetto_2025` (Espetto) e `bd_mane_2025` loja 13 (Cabo Frio Collab), Zig (Villa Lobos), pela
procedure `dbo.sp_dashboard_copo15`.

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
