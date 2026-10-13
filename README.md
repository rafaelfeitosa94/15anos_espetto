# Dashboard – Ação Copo 15 Anos (Espetto Carioca)

Monitoramento da ação de 15/10 a 30/11/2026: cada comanda acima de **R$ 250,00** ganha um copo comemorativo.

## Como funciona

```
SQL Server (ad01\bartender)  ──>  extrator/atualizar_dados.py  ──>  data/dados.json
     (rede local)                 (tarefa agendada, 14h)              │ git push
                                                                      ▼
                                              GitHub  ──>  Vercel (deploy automático)
```

- `public/` – página do dashboard (login, filtros, KPIs, ranking, top 10 produtos, mapa, tema claro/escuro), no padrão visual do Manual da Marca Espetto Carioca (paleta, tipografia, ícones, grafismos e texturas em `public/img/`).
- `api/login.js` – login (cookie HttpOnly assinado, 12h).
- `api/data.js` – entrega `data/dados.json` apenas para usuários autenticados.
- `extrator/` – script Python que consulta o banco e publica os dados.

## Regras de cálculo

| Indicador | Regra |
|---|---|
| Comandas > R$ 250 | soma do valor por comanda (loja + dia + comanda) maior que R$ 250 |
| Faturamento | consumo das comandas + taxa de serviço – cortesias (mesma fórmula da `vw_faturamento_espetto_cupom`) |
| Comandas | total de comandas distintas |
| Ticket médio | faturamento ÷ comandas |
| Copos utilizados | comandas > R$ 250 acumuladas desde 15/10 até a data final do filtro, versus copos enviados à loja |

**Villa Lobos** vem de `vw_faturamento_villa_lobos_cupom` (comandas e produtos na mesma consulta).
**Cabo Frio Collab** vem de `vw_faturamento_cabofrio_collab_cupom` (valor por comanda já com serviço/cortesia da própria comanda); produtos da base do Mané (`bd_mane_2025.dbo.BD_PRODUTOS_V2`, loja 13).
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

## Rodar localmente

```bash
node dev-server.js
```

## Atualização manual

Execute `extrator\atualizar.bat` (ou aguarde a tarefa das 14h). O botão **Atualizar dados** no dashboard
recarrega a versão mais recente publicada.
