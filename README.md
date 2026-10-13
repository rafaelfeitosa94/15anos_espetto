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
- `extrator/`: extrator Python local (plano B), agendado no Windows às 15:00.

Instalação do runner, secrets e variáveis: **[docs/CONFIGURAR_RUNNER.md](docs/CONFIGURAR_RUNNER.md)**.

## Regras de cálculo

| Indicador | Regra |
|---|---|
| Comandas > R$ 250 | soma do valor por comanda (loja + dia + comanda) maior que R$ 250 |
| Faturamento | consumo das comandas + taxa de serviço – cortesias (mesma fórmula da `vw_faturamento_espetto_cupom`) |
| Comandas | total de comandas distintas |
| Ticket médio | faturamento ÷ comandas |
| Copos utilizados | comandas > R$ 250 acumuladas desde 15/10 até a data final do filtro, versus copos enviados à loja |

**Villa Lobos** vem de `vw_faturamento_villa_lobos_cupom` (comandas e produtos na mesma consulta).
**Cabo Frio Collab** usa a lógica da `vw_faturamento_cabofrio_collab_cupom` (valor por comanda já com serviço/cortesia
da própria comanda; na procedure, aplicada direto nas tabelas do Mané com filtro de data, com resultado idêntico); produtos da
base do Mané (`bd_mane_2025.dbo.BD_PRODUTOS_V2`, loja 13).
Produtos das demais lojas vêm de `prod_15_anos_espetto`.

> A `vw_faturamento_espetto_cupom` soma a taxa de serviço e as cortesias **do dia inteiro** em cada comanda,
> o que infla o valor individual. Por isso o extrator usa as mesmas tabelas base da view, aplicando serviço/cortesia
> apenas no total do dia. Configurações no topo de `extrator/atualizar_dados.py` (`LIMITE`, `LIMITE_INCLUI_SERVICO`).

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
