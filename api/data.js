const fs = require('fs');
const path = require('path');
const { isAuthenticated } = require('../lib/auth');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'não autenticado' });
  }
  try {
    const dir = path.join(process.cwd(), 'data');
    const dados = JSON.parse(fs.readFileSync(path.join(dir, process.env.DATA_FILE || 'dados.json'), 'utf8'));
    // mesmo período do ano anterior (arquivo estático gerado por extrator/gerar_ano_anterior.py)
    try {
      dados.ano_anterior = JSON.parse(fs.readFileSync(path.join(dir, 'ano_anterior.json'), 'utf8'));
    } catch { /* sem comparação */ }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify(dados));
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'dados indisponíveis' });
  }
};
