const { checkCredentials, issueCookie, clearCookie, isAuthenticated } = require('../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).json({ ok: isAuthenticated(req) });
  }
  if (req.method === 'DELETE') {
    clearCookie(res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false });
  }

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!checkCredentials(body.user, body.pass)) {
    await new Promise(r => setTimeout(r, 600));
    return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos' });
  }
  issueCookie(res);
  return res.status(200).json({ ok: true });
};
