const crypto = require('crypto');

// Credenciais: defina DASH_USER, DASH_PASS e AUTH_SECRET nas variáveis de ambiente da Vercel.
// Os valores padrão abaixo servem apenas de fallback (senha guardada como hash SHA-256).
const USER = process.env.DASH_USER || 'mkt_impettus';
const PASS_HASH = process.env.DASH_PASS
  ? sha256(process.env.DASH_PASS)
  : '7a6535f9d44bef7ba52c94a9f9a1c31862067eef874f9f67482752cf36f8e784';
// Sem AUTH_SECRET a chave é aleatória por instância (seguro, mas o login expira a cada reinício da função).
// Defina AUTH_SECRET na Vercel com um texto aleatório longo.
const SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'c15_sess';
const TTL_SEC = 12 * 60 * 60;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkCredentials(user, pass) {
  return safeEqual(user || '', USER) && safeEqual(sha256(pass || ''), PASS_HASH);
}

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function issueCookie(res) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const payload = `${USER}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_SEC}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

function isAuthenticated(req) {
  const raw = req.headers.cookie || '';
  const m = raw.split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  if (!m) return false;
  const token = m.slice(COOKIE.length + 1);
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!safeEqual(sig, sign(payload))) return false;
  const exp = Number(payload.split('.').pop());
  return Number.isFinite(exp) && exp > Date.now() / 1000;
}

module.exports = { checkCredentials, issueCookie, clearCookie, isAuthenticated, sha256 };
