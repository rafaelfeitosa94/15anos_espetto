const fs = require('fs');
const path = require('path');
const { isAuthenticated } = require('../lib/auth');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'não autenticado' });
  }
  try {
    const file = path.join(process.cwd(), 'data', process.env.DATA_FILE || 'dados.json');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'dados indisponíveis' });
  }
};
