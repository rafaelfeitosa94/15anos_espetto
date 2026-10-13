// Botão "Atualizar dados": dispara o workflow "Atualizar dados" no GitHub, que roda no runner instalado na
// rede da empresa (SRVTESTE) e consulta o SQL Server. Também informa o andamento/status da última execução.
//
//   POST /api/atualizar   -> dispara o workflow (se já houver um em andamento, só devolve o status dele)
//   GET  /api/atualizar   -> status da execução mais recente
//
// Variáveis de ambiente (Vercel): GH_TOKEN (token fine-grained com "Actions: Read and write" no repositório),
// GH_REPO (padrão rafaelfeitosa94/15anos_espetto), GH_WORKFLOW (padrão atualizar-dados.yml).
const { isAuthenticated } = require('../lib/auth');

const REPO = process.env.GH_REPO || 'rafaelfeitosa94/15anos_espetto';
const WORKFLOW = process.env.GH_WORKFLOW || 'atualizar-dados.yml';
const FILA_MAX_MIN = 10; // na fila há mais que isso = runner provavelmente desligado/offline

async function gh(metodo, rota, corpo) {
  const r = await fetch(`${process.env.GH_API_URL || 'https://api.github.com'}/repos/${REPO}${rota}`, { // GH_API_URL: só testes
    method: metodo,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dashboard-copo15',
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  if (!r.ok) {
    const e = new Error(`GitHub ${r.status}: ${texto.slice(0, 200)}`);
    e.status = r.status;
    throw e;
  }
  return texto ? JSON.parse(texto) : {};
}

function resumo(run) {
  if (!run) return { status: 'sem_execucao' };
  const minutosNaFila = (Date.now() - new Date(run.created_at).getTime()) / 60000;
  let status = run.status === 'completed' ? (run.conclusion === 'success' ? 'ok' : 'falhou') : 'executando';
  if (run.status === 'queued' && minutosNaFila > FILA_MAX_MIN) status = 'runner_offline';
  return {
    status,
    fase: run.status,                 // queued | in_progress | completed
    conclusao: run.conclusion,        // success | failure | cancelled | null
    evento: run.event,                // schedule | workflow_dispatch
    criado_em: run.created_at,
    atualizado_em: run.updated_at,
    url: run.html_url,
    id: run.id,
  };
}

async function ultimaExecucao() {
  const j = await gh('GET', `/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  return (j.workflow_runs || [])[0];
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ ok: false, error: 'não autenticado' });
  if (!process.env.GH_TOKEN) {
    return res.status(200).json({ ok: false, execucao: { status: 'nao_configurado', mensagem: 'GH_TOKEN não configurado na Vercel' } });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, execucao: resumo(await ultimaExecucao()) });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false });

    const atual = await ultimaExecucao();
    if (atual && atual.status !== 'completed') {
      return res.status(200).json({ ok: true, disparado: false, execucao: resumo(atual) });
    }
    const disparadoEm = new Date().toISOString();
    await gh('POST', `/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main' });
    return res.status(200).json({ ok: true, disparado: true, disparado_em: disparadoEm, execucao: { status: 'executando', fase: 'queued' } });
  } catch (e) {
    return res.status(200).json({ ok: false, execucao: { status: 'erro', mensagem: String(e.message).slice(0, 300) } });
  }
};
