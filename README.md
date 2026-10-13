# Dashboard – Ação Copo 15 Anos (Espetto Carioca)

Monitoramento da ação de 15/10 a 30/11/2026: cada comanda acima de **R$ 250,00** ganha um copo comemorativo.

## Como funciona

```
                    ┌── botão "Atualizar dados" (tempo real) ──┐
Dashboard (Vercel) ─┤                                          ├─> Fluxo Power Automate ─> on-premises gateway ─> SQL Server
                    └── data/dados.json  <── GitHub Actions 13:30 ┘        (FLOW_URL)              dbo.sp_dashboard_copo15
                                         <── tarefa local 13:30 (plano B: extrator Python)
```

- `public/`: página do dashboard (login, filtros, KPIs, ranking, top 10 produtos, mapa, tema claro/escuro),
  no padrão visual do Manual da Marca Espetto Carioca (imagens em `public/img/`).
- `api/login.js`: login (cookie HttpOnly assinado, 12h).
- `api/data.js`: entrega o snapshot `data/dados.json` só para usuários autenticados.
- `api/atualizar.js`: consulta ao vivo pelo gateway e status da conexão.
- `lib/gateway.js`: chamada ao fluxo e consolidação (mesmo formato do extrator Python).
- `sql/sp_dashboard_copo15.sql`: procedure executada pelo gateway; `sql/testar_procedure.py` testa sem criá-la.
- `.github/workflows/atualizar-dados.yml`: atualização diária às 13:30 pelo gateway.
- `extrator/`: extrator Python local (plano B), agendado no Windows às 13:30.

Passo a passo do gateway, do fluxo e dos segredos: **[docs/CONFIGURAR_GATEWAY.md](docs/CONFIGURAR_GATEWAY.md)**.

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
| `FLOW_URL` | URL do gatilho HTTP do fluxo do Power Automate (também como *secret* no GitHub) |

## Rodar localmente

```bash
node dev-server.js
```

## Atualização manual

Clique em **Atualizar dados** no dashboard (consulta ao vivo pelo gateway), rode o workflow manualmente no GitHub
(*Actions → Atualizar dados (gateway) → Run workflow*) ou execute `extrator\atualizar.bat` (plano B local).
