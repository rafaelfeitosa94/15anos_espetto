# Atualização pelo runner do GitHub na rede da empresa

```
GitHub Actions ── agenda: de hora em hora, 11h às 23h (15/10 a 01/12)
      │       └── botão "Atualizar dados" do dashboard (Vercel → API do GitHub)
      ▼
┌──────────────── rede da empresa ────────────────┐
│ SRVTESTE (runner)  ──>  AD01\BARTENDER (1433)    │
│  scripts/exec-sp.ps1     dbo.sp_dashboard_copo15 │
└──────────────────────────────────────────────────┘
      │ commit de data/dados.json pela API do GitHub
      ▼
Vercel publica o dashboard
```

- O **runner** é um serviço do Windows no SRVTESTE. Ele só faz conexões **de saída** para o GitHub
  (HTTPS 443), sem abrir porta e sem expor o banco na internet.
- Ele executa `dbo.sp_dashboard_copo15` em `AD01\BARTENDER` (porta 1433) com o SqlClient nativo do Windows,
  sem precisar instalar Python, driver ODBC ou git no servidor. O Node é instalado pelo próprio workflow.
- As tabelas de origem têm índices em `dataVenda` ([sql/indices_dataVenda.sql](../sql/indices_dataVenda.sql)).
  Cada atualização completa leva de 1 a 2 minutos.

## 1. Instalar o runner no SRVTESTE (uma vez)

1. No GitHub: **15anos_espetto → Settings → Actions → Runners → New self-hosted runner → Windows**.
   A página mostra um comando `./config.cmd --url ... --token XXXXX`. Copie **só o token**, que vale por 1 hora.
2. No SRVTESTE (por RDP), copie o arquivo [`runner/instalar_runner.ps1`](../runner/instalar_runner.ps1), abra o
   **PowerShell como administrador** na pasta dele e rode:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\instalar_runner.ps1 -Token COLE_O_TOKEN_AQUI
   ```
   O instalador:
   - testa o acesso ao SQL (`ad01:1433`) e ao GitHub;
   - baixa o runner oficial e confere o SHA-256;
   - instala em `C:\actions-runner` como serviço do Windows, com o rótulo `sqlserver`.
3. Em **Settings → Actions → Runners**, o runner `SRVTESTE` deve aparecer como **Idle**.

## 2. Secrets do repositório (Settings → Secrets and variables → Actions)

| Nome | Valor |
|---|---|
| `DB_SERVER` | `ad01,1433` |
| `DB_USER` | usuário de leitura do SQL (o mesmo usado pelo BI) |
| `DB_PASSWORD` | senha desse usuário |

> O secret `FLOW_URL` (Power Automate) não é mais usado. Se tiver sido criado, pode apagar.

## 3. Botão "Atualizar dados" (variável na Vercel)

O botão aciona o workflow pela API do GitHub. Crie um **token fine-grained**:
**GitHub → sua foto → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- *Repository access*: **Only select repositories → 15anos_espetto**
- *Permissions → Repository permissions → Actions*: **Read and write**. Deixe o resto sem acesso.
- *Expiration*: depois do fim da ação, por exemplo 31/12/2026.

Na Vercel (**Settings → Environment Variables**):

| Nome | Valor |
|---|---|
| `GH_TOKEN` | o token criado acima |
| `DASH_USER`, `DASH_PASS` | login do dashboard |
| `AUTH_SECRET` | texto aleatório longo |

Ao clicar em **Atualizar dados**, o dashboard aciona o servidor, mostra o andamento na barra lateral e recarrega
sozinho quando a nova versão estiver publicada, em cerca de 2 a 4 minutos.

## 4. Avisos no dashboard

- **"Última atualização falhou"**: a execução terminou com erro, por exemplo SQL fora do ar ou senha alterada.
  O botão do aviso abre o log no GitHub.
- **"Servidor offline"**: há uma execução na fila há mais de 10 minutos. O SRVTESTE está desligado, sem internet
  ou com o serviço `actions.runner.*` parado. Verifique em `services.msc` no SRVTESTE.

## 5. Testar

**Actions → Atualizar dados → Run workflow**. Antes de 15/10, informe datas passadas, por exemplo início
`2026-10-06` e fim `2026-10-12`, para ver números de verdade. Depois rode de novo **sem datas** para voltar ao
período da ação.

## Plano B

A tarefa do Windows no PC do BI (`extrator/agendar_tarefa.ps1`) roda o extrator Python às 15:00 e publica pelo git.
Com o runner funcionando, ela pode ser desativada:

```powershell
Disable-ScheduledTask -TaskName 'Dashboard Copo 15 Anos - Atualizacao'
```
