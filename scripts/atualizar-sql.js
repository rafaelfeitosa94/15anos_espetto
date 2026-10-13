// Executado pelo runner do GitHub instalado na rede (SRVTESTE): consulta o SQL Server pela procedure
// dbo.sp_dashboard_copo15, regrava data/dados.json e publica no GitHub pela API (sem precisar de git no
// servidor). A Vercel publica automaticamente a cada commit.
//
// Env: DB_SERVER, DB_USER, DB_PASSWORD (secrets), GITHUB_TOKEN, GITHUB_REPOSITORY (do Actions),
//      INICIO / FIM (opcionais; padrão = período da ação até hoje), SEM_PUBLICAR=1 (só gera o arquivo).
//      Testes: SAIDA (arquivo), PERIODO_INICIO / PERIODO_FIM.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const c = require('../lib/consolidar');

const ROOT = path.resolve(__dirname, '..');
const ARQ = process.env.SAIDA || path.join(ROOT, 'data', 'dados.json'); // SAIDA: só para testes
const PS1 = path.join(__dirname, 'exec-sp.ps1');

function execSP({ inicio, fim, parte }) {
  const saida = path.join(os.tmpdir(), `copo15_${parte}_${inicio}_${process.pid}.json`);
  const t = Date.now();
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
        '-Inicio', inicio, '-Fim', fim, '-Parte', parte, '-Saida', saida],
      { timeout: 20 * 60 * 1000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${parte} ${inicio}..${fim}: ${(stderr || err.message).trim()}`));
        try {
          const obj = JSON.parse(fs.readFileSync(saida, 'utf8'));
          fs.unlinkSync(saida);
          console.log(`  ${parte.padEnd(19)} ${inicio}..${fim} ${((Date.now() - t) / 1000).toFixed(1)}s`);
          resolve(obj);
        } catch (e) { reject(e); }
      });
  });
}

// ---------- publicação via Git Data API (commit de um arquivo, sem git local) ----------
async function gh(metodo, rota, corpo) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${rota}`, {
    method: metodo,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) { const e = new Error(`GitHub ${metodo} ${rota}: ${r.status} ${texto.slice(0, 300)}`); e.status = r.status; throw e; }
  return texto ? JSON.parse(texto) : {};
}

async function publicar(conteudo, mensagem) {
  const branch = process.env.GITHUB_REF_NAME || 'main';
  // autor = dono do repositório (a Vercel pode bloquear deploys de commits de autores desconhecidos)
  const autor = {
    name: process.env.GITHUB_REPOSITORY_OWNER,
    email: `${process.env.GITHUB_REPOSITORY_OWNER_ID}+${process.env.GITHUB_REPOSITORY_OWNER}@users.noreply.github.com`,
  };
  const blob = await gh('POST', '/git/blobs', { content: Buffer.from(conteudo).toString('base64'), encoding: 'base64' });
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const ref = await gh('GET', `/git/ref/heads/${branch}`);
    const commitAtual = await gh('GET', `/git/commits/${ref.object.sha}`);
    const arvoreAtual = await gh('GET', `/git/trees/${commitAtual.tree.sha}?recursive=1`);
    const atual = (arvoreAtual.tree || []).find(x => x.path === 'data/dados.json');
    if (atual && atual.sha === blob.sha) { console.log('Sem alterações em data/dados.json.'); return; }
    const arvore = await gh('POST', '/git/trees', {
      base_tree: commitAtual.tree.sha,
      tree: [{ path: 'data/dados.json', mode: '100644', type: 'blob', sha: blob.sha }],
    });
    const novo = await gh('POST', '/git/commits', {
      message: mensagem, tree: arvore.sha, parents: [ref.object.sha], author: autor, committer: autor,
    });
    try {
      await gh('PATCH', `/git/refs/heads/${branch}`, { sha: novo.sha });
      console.log(`Publicado: ${novo.sha.slice(0, 7)} (${mensagem})`);
      return;
    } catch (e) {
      if (e.status !== 422 || tentativa === 3) throw e; // 422 = branch avançou no meio; tenta de novo
    }
  }
}

(async () => {
  for (const v of ['DB_SERVER', 'DB_USER', 'DB_PASSWORD']) {
    if (!process.env[v]) { console.log(`::error::Secret ${v} não configurado no repositório.`); process.exit(1); }
  }
  let base = null;
  try { base = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { /* primeiro uso */ }
  // PERIODO_INICIO / PERIODO_FIM: só para testes fora do período da ação
  const periodo = { inicio: process.env.PERIODO_INICIO || c.INICIO_ACAO, fim: process.env.PERIODO_FIM || c.FIM_ACAO };
  const hoje = c.hojeSP();
  const inicio = process.env.INICIO || periodo.inicio;
  const fim = process.env.FIM || (hoje < periodo.fim ? hoje : periodo.fim);
  if (fim < inicio) { console.log(`Nada a consultar (${inicio} a ${fim}): a ação ainda não começou.`); return; }

  console.log(`Consultando ${inicio} a ${fim} em ${process.env.DB_SERVER}…`);
  const t = Date.now();
  const payloads = await c.consultarPeriodo(execSP, inicio, fim, { diasPorBloco: 7 });
  const { dados, ignoradas } = c.consolidar({ lojasCfg: c.carregarLojas(ROOT), payloads, janela: { inicio, fim }, base, periodo });
  dados.execucao = {
    status: 'ok', em: dados.atualizado_em, janela: { inicio, fim },
    runner: process.env.RUNNER_NAME || os.hostname(), evento: process.env.GITHUB_EVENT_NAME || 'manual',
  };
  const conteudo = JSON.stringify(dados);
  fs.writeFileSync(ARQ, conteudo);
  if (ignoradas.length) console.log('Lojas fora da ação (ignoradas):', ignoradas.join(', '));
  console.log(`Consulta OK em ${((Date.now() - t) / 1000).toFixed(1)}s: ${dados.vendas.length} linhas de vendas, ${dados.prod.length} de produtos.`);

  if (process.env.SEM_PUBLICAR) return;
  await publicar(conteudo, `dados: atualização ${hoje.split('-').reverse().join('/')} ${dados.atualizado_em.slice(11, 16)} (runner)`);
})().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exit(1);
});
