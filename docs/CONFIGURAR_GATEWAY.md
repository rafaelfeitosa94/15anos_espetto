# Atualização via on-premises data gateway (Power Automate)

```
Dashboard (Vercel)  ─┐                                   ┌─> SQL Server ad01\bartender
  botão "Atualizar"  ├─> Fluxo Power Automate (HTTP) ──> gateway ─┘   dbo.sp_dashboard_copo15
GitHub Actions 13:30 ┘        (FLOW_URL)
```

O conector SQL do Power Automate **não executa consultas livres pelo gateway**. Só executa
**stored procedures**, com limite de 8 MB de resposta e 110 s por chamada. Por isso:

- a consulta fica na procedure [`sql/sp_dashboard_copo15.sql`](../sql/sp_dashboard_copo15.sql), com a mesma lógica do extrator;
- cada chamada traz uma parte (`vendas`, `produtos_espetto`, `produtos_parceiros`), e as três rodam em paralelo.
  No teste de 7 dias levou cerca de 29 s.

## 1. Criar a procedure no SQL Server

Abra `sql/sp_dashboard_copo15.sql` no SSMS, conectado em `ad01\bartender`, banco **master**
(onde ficam as views do projeto), e execute.

Teste rápido no SSMS:

```sql
EXEC dbo.sp_dashboard_copo15 @inicio = '2026-10-06', @fim = '2026-10-12', @parte = 'vendas';
```

> **Recomendado:** as tabelas de origem (`bd_vendas_v3`, `BD_PRODUTOS_V2`, `BD_TC_V2`, `BD_PAGAMENTOS_V2`)
> são *heaps* sem índice, então cada chamada lê a tabela inteira. Com o servidor ocupado (atualizações do Power BI)
> o tempo pode passar de 110 s. Um índice em `dataVenda` nessas tabelas deixa a consulta muito mais rápida.
> Avalie com quem mantém a carga (ETL).

## 2. Criar o fluxo no Power Automate

Exige licença **Premium**, porque os gatilhos/ações HTTP e Resposta são premium.

1. **Novo fluxo → Fluxo da nuvem instantâneo → "Quando uma solicitação HTTP for recebida"**
   - *Quem pode disparar o fluxo:* **Qualquer pessoa**. A segurança vem da assinatura `sig` na URL, que é secreta.
   - *Esquema JSON do corpo da solicitação:*
     ```json
     { "type": "object", "properties": {
         "inicio": { "type": "string" }, "fim": { "type": "string" }, "parte": { "type": "string" } } }
     ```
2. **Ação: SQL Server → "Executar procedimento armazenado (V2)"**
   - Conexão: **SQL Server Authentication** pelo **gateway** instalado no servidor do banco
     (servidor `ad01\bartender`, banco `master`, usuário de leitura do BI).
   - Procedimento: `[dbo].[sp_dashboard_copo15]`
   - Parâmetros: `inicio` = `triggerBody()?['inicio']`, `fim` = `triggerBody()?['fim']`, `parte` = `triggerBody()?['parte']`
3. **Ação: Resposta** (sucesso)
   - Código de status: `200`
   - Cabeçalhos: `Content-Type: application/json`
   - Corpo (expressão):
     `first(body('Executar_procedimento_armazenado_(V2)')?['ResultSets']?['Table1'])?['payload']`
4. **Ação: Resposta** (erro). Em *Configurar execução após*, marque **falhou / atingiu o tempo limite**.
   - Código de status: `500`
   - Corpo (expressão): `string(outputs('Executar_procedimento_armazenado_(V2)')?['body'])`

   O dashboard lê essa mensagem para decidir se mostra o aviso de **reautenticação**.
5. Em *Configurações* do gatilho, defina o tempo limite da ação SQL para **PT2M**.
6. Salve e copie a **URL HTTP POST** do gatilho. Essa é a `FLOW_URL`, e ela é secreta.

## 3. Configurar os segredos

| Onde | Nome | Valor |
|---|---|---|
| Vercel → Settings → Environment Variables | `FLOW_URL` | URL do gatilho HTTP |
| Vercel | `DASH_USER`, `DASH_PASS`, `AUTH_SECRET` | login do dashboard e texto aleatório longo |
| GitHub → Settings → Secrets and variables → Actions | `FLOW_URL` | a mesma URL |

## 4. Validação em duas etapas (quando o aviso aparecer)

A conexão do SQL pelo gateway usa autenticação do SQL Server e não expira. O que pode exigir uma nova
validação é a **conta Microsoft dona do fluxo/conexão**: senha alterada, política de acesso condicional ou
inatividade. Quando isso acontece:

- o dashboard mostra um aviso vermelho no topo e o status **"Reautenticação necessária"** na barra lateral;
- o botão **🔐 Validar conexão (2 etapas)** abre o passo a passo e o link do Power Automate. Ao entrar com a
  conta, a Microsoft envia a aprovação para o celular (Authenticator);
- depois, **Testar conexão** confirma que voltou a funcionar.

A senha **não é armazenada** no dashboard nem no repositório. A segunda etapa só pode ser aprovada na página da
Microsoft, e esse é o fluxo que o botão abre.

## 5. Agenda

- **GitHub Actions** (`.github/workflows/atualizar-dados.yml`): roda todo dia às **13:30** (16:30 UTC),
  de 15/10 a 01/12. Consulta o período inteiro da ação, regrava `data/dados.json` e faz commit, e a Vercel publica.
  Também dá para rodar manualmente em *Actions → Atualizar dados (gateway) → Run workflow*, informando datas.
- **Botão "Atualizar dados"** no dashboard: consulta **ao vivo** os últimos 3 dias e mescla com o snapshot.
- **Tarefa local do Windows** (13:30): plano B pelo extrator Python, caso o gateway esteja fora.
