// Usado pelo GitHub Actions: consulta o período da ação pelo gateway (fluxo do Power Automate)
// e regrava data/dados.json. Em caso de falha, mantém os dados anteriores e registra o status do
// gateway no arquivo, para o dashboard exibir o aviso de reativação.
//
// Env: FLOW_URL (obrigatória), INICIO / FIM (opcionais, padrão = período da ação até hoje)
const fs = require('fs');
const path = require('path');
const gw = require('../lib/gateway');

const ROOT = path.resolve(__dirname, '..');
const ARQ = path.join(ROOT, 'data', 'dados.json');

(async () => {
  const url = process.env.FLOW_URL;
  if (!url) {
    console.log('::error::Secret FLOW_URL não configurado no repositório.');
    process.exit(1);
  }
  let base = null;
  try { base = JSON.parse(fs.readFileSync(ARQ, 'utf8')); } catch { /* primeiro uso */ }
  const periodo = { inicio: gw.INICIO_ACAO, fim: gw.FIM_ACAO };
  const hoje = gw.hojeSP();
  const inicio = process.env.INICIO || periodo.inicio;
  const fimPadrao = hoje < periodo.fim ? hoje : periodo.fim;
  const fim = process.env.FIM || fimPadrao;

  if (fim < inicio) {
    console.log(`Nada a consultar (${inicio} a ${fim}): a ação ainda não começou.`);
    return;
  }

  console.log(`Consultando ${inicio} a ${fim} pelo gateway…`);
  try {
    const t = Date.now();
    const payloads = await gw.consultarPeriodo(url, inicio, fim, { timeoutMs: 115000, tentativas: 3 });
    const { dados, ignoradas } = gw.consolidar({
      lojasCfg: gw.carregarLojas(ROOT), payloads, janela: { inicio, fim }, base, periodo,
    });
    dados.gateway = { status: 'ok', em: dados.atualizado_em, janela: { inicio, fim } };
    fs.writeFileSync(ARQ, JSON.stringify(dados));
    if (ignoradas.length) console.log('Lojas fora da ação (ignoradas):', ignoradas.join(', '));
    console.log(`OK em ${((Date.now() - t) / 1000).toFixed(1)}s: ${dados.vendas.length} linhas de vendas, ${dados.prod.length} de produtos.`);
  } catch (e) {
    console.log(`::error::Falha no gateway (${e.tipo}): ${e.message}`);
    if (base) {
      base.gateway = { status: e.tipo || 'erro', mensagem: String(e.message).slice(0, 300), em: gw.agoraISO() };
      fs.writeFileSync(ARQ, JSON.stringify(base));
    }
    process.exitCode = 1;
  }
})();
