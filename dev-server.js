// Servidor local para testar o dashboard sem a Vercel: node dev-server.js  ->  http://localhost:3015
const http = require('http');
const fs = require('fs');
const path = require('path');

process.chdir(__dirname);
if (process.argv[2]) process.env.DATA_FILE = process.argv[2]; // ex.: node dev-server.js teste.json
const PORT = process.env.PORT || 3015;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const handlers = { '/api/login': require('./api/login'), '/api/data': require('./api/data') };

function wrapRes(res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  res.send = (s) => { res.end(s); return res; };
  // cookies "Secure" não são aceitos em http://localhost por alguns navegadores; remove localmente
  const set = res.setHeader.bind(res);
  res.setHeader = (k, v) => set(k, k.toLowerCase() === 'set-cookie' ? String(v).replace('; Secure', '') : v);
  return res;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const h = handlers[url.pathname];
  if (process.env.DEV_NOAUTH && !req.headers.cookie) {
    // somente local: autentica automaticamente (usado para capturas de tela headless)
    let c = '';
    require('./lib/auth').issueCookie({ setHeader: (_, v) => { c = String(v).split(';')[0]; } });
    req.headers.cookie = c;
  }
  if (h) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      Promise.resolve(h(req, wrapRes(res))).catch(e => { res.statusCode = 500; res.end(String(e)); });
    });
    return;
  }
  let p = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
  fs.createReadStream(p).pipe(res);
}).listen(PORT, () => console.log(`Dashboard local em http://localhost:${PORT}`));
