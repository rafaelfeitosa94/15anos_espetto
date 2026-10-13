// Atualização em tempo real: consulta o SQL Server pelo on-premises data gateway (fluxo do Power Automate)
// e devolve os dados do dashboard já mesclados com o último snapshot publicado (data/dados.json).
//
//   POST /api/atualizar                 -> consulta os últimos dias (padrão 3) e mescla com o snapshot
//   POST /api/atualizar?completo=1      -> consulta o período inteiro da ação
//   POST /api/atualizar?teste=1         -> só testa a conexão (consulta o dia de hoje, parte "vendas")
//
// Variável de ambiente obrigatória: FLOW_URL (URL do gatilho HTTP do fluxo, com a assinatura sig=...).
const fs = require('fs');
const path = require('path');
const { isAuthenticated } = require('../lib/auth');
const gw = require('../lib/gateway');

const DIAS_AO_VIVO = Number(process.env.DIAS_AO_VIVO || 3);

function isoAdd(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) return res.status(401).json({ ok: false, error: 'não autenticado' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const url = process.env.FLOW_URL;
  if (!url) {
    return res.status(200).json({ ok: false, gateway: { status: 'nao_configurado', mensagem: 'FLOW_URL não configurada na Vercel' } });
  }

  const root = process.cwd();
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const hoje = gw.hojeSP();
  let base = null;
  try { base = JSON.parse(fs.readFileSync(path.join(root, 'data', process.env.DATA_FILE || 'dados.json'), 'utf8')); } catch { /* sem snapshot */ }
  const periodo = (base && base.periodo) || { inicio: gw.INICIO_ACAO, fim: gw.FIM_ACAO };

  try {
    if (q.teste) {
      const t = Date.now();
      await gw.chamarFluxo(url, { inicio: hoje, fim: hoje, parte: 'vendas' }, { tentativas: 1 });
      return res.status(200).json({ ok: true, gateway: { status: 'ok', em: gw.agoraISO(), ms: Date.now() - t } });
    }

    const fim = hoje < periodo.fim ? hoje : periodo.fim;
    let inicio = q.completo ? periodo.inicio : isoAdd(hoje, -(DIAS_AO_VIVO - 1));
    if (inicio < periodo.inicio) inicio = periodo.inicio;
    if (fim < periodo.inicio) {
      // ação ainda não começou: nada a consultar
      return res.status(200).json({ ok: true, dados: base, gateway: { status: 'ok', em: gw.agoraISO(), aviso: 'A ação ainda não começou' } });
    }

    const payloads = await gw.consultarPeriodo(url, inicio, fim, { timeoutMs: 110000, tentativas: 1 });
    const { dados } = gw.consolidar({
      lojasCfg: gw.carregarLojas(root), payloads, janela: { inicio, fim }, base, periodo,
    });
    dados.gateway = { status: 'ok', em: dados.atualizado_em, janela: { inicio, fim } };
    return res.status(200).json({ ok: true, dados, gateway: dados.gateway });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      gateway: { status: e.tipo || 'erro', mensagem: String(e.message || e).slice(0, 300), em: gw.agoraISO() },
    });
  }
};
