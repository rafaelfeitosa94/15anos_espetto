// Consulta ao SQL Server através do on-premises data gateway (Power Automate) e consolidação
// no mesmo formato de data/dados.json gerado pelo extrator Python.
const fs = require('fs');
const path = require('path');

const PARTES = ['vendas', 'produtos_espetto', 'produtos_parceiros'];
const INICIO_ACAO = '2026-10-15';
const FIM_ACAO = '2026-11-30';
const LIMITE = 250;

// nomes no banco que diferem do código da planilha (mesmo mapa do extrator Python)
const ALIASES = { 'MAN COLLAB CABO FRIO': 'MAN CABO FRIO COLLAB' };

function norm(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
  t = t.replace(/VILLA/g, 'VILA').split(/\s+/).filter(Boolean).join(' ');
  return ALIASES[t] || t;
}

function carregarLojas(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'extrator', 'lojas.json'), 'utf8'));
}

function dias(inicio, fim) {
  const out = [];
  const d = new Date(inicio + 'T12:00:00Z');
  const end = new Date(fim + 'T12:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

function hojeSP() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function agoraISO() {
  // ISO com fuso de São Paulo (-03:00), igual ao extrator Python
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}-03:00`;
}

/** Classifica falhas do fluxo/gateway para o aviso de reautenticação no dashboard. */
function classificarErro(status, texto) {
  const t = String(texto || '').toLowerCase();
  if (status === 401 || status === 403 ||
      /unauthori|credential|credencia|expired|expirad|reauth|sign in|login|aadsts|token|consent|connection.*(invalid|not found)|conex/.test(t)) {
    return 'reautenticar';
  }
  if (/gateway|offline|unreachable|could not connect|n[aã]o foi poss/.test(t)) return 'gateway_offline';
  if (status === 408 || status === 504 || /timeout|timed out|tempo limite/.test(t)) return 'timeout';
  return 'erro';
}

class ErroGateway extends Error {
  constructor(tipo, mensagem, status) { super(mensagem); this.tipo = tipo; this.status = status; }
}

/** Chama o fluxo do Power Automate para uma parte/período e devolve o payload já em objeto. */
async function chamarFluxo(url, { inicio, fim, parte }, { timeoutMs = 115000, tentativas = 2 } = {}) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inicio, fim, parte }),
        signal: ctrl.signal,
      });
      const texto = await r.text();
      if (!r.ok) throw new ErroGateway(classificarErro(r.status, texto), texto.slice(0, 500), r.status);
      let obj = JSON.parse(texto);
      if (typeof obj === 'string') obj = JSON.parse(obj);           // corpo enviado como texto
      if (obj && obj.payload) obj = typeof obj.payload === 'string' ? JSON.parse(obj.payload) : obj.payload;
      if (!obj || !Array.isArray(obj.lojas)) throw new ErroGateway('erro', 'Resposta inesperada do fluxo', r.status);
      return obj;
    } catch (e) {
      ultimo = e.name === 'AbortError' ? new ErroGateway('timeout', 'Tempo limite ao consultar o gateway') :
        e instanceof ErroGateway ? e : new ErroGateway(classificarErro(0, e.message), e.message);
      if (ultimo.tipo === 'reautenticar') break; // não adianta repetir
    } finally {
      clearTimeout(timer);
    }
  }
  throw ultimo;
}

/** Divide [inicio, fim] em blocos de N dias. */
function blocos(inicio, fim, n) {
  const out = [];
  const ds = dias(inicio, fim);
  for (let i = 0; i < ds.length; i += n) out.push({ inicio: ds[i], fim: ds[Math.min(i + n, ds.length) - 1] });
  return out;
}

/**
 * Consulta as 3 partes em paralelo; dentro de cada parte, o período é dividido em blocos de
 * `diasPorBloco` dias consultados em sequência (cada chamada precisa ficar abaixo de 110 s no gateway:
 * 7 dias de produtos ≈ 20 s; 47 dias numa chamada só ≈ 112 s).
 */
async function consultarPeriodo(url, inicio, fim, opts = {}) {
  const lista = blocos(inicio, fim, opts.diasPorBloco || 7);
  const porParte = await Promise.all(PARTES.map(async (parte) => {
    const res = [];
    for (const b of lista) res.push(await chamarFluxo(url, { ...b, parte }, opts));
    return res;
  }));
  return porParte.flat();
}

/**
 * Monta (ou atualiza) o objeto de dados do dashboard.
 * base: dados.json anterior (opcional) — os dias dentro da janela consultada são substituídos.
 */
function consolidar({ lojasCfg, payloads, janela, base, periodo }) {
  periodo = periodo || (base && base.periodo) || { inicio: INICIO_ACAO, fim: FIM_ACAO };
  const listaDias = dias(periodo.inicio, periodo.fim);
  const idxDia = Object.fromEntries(listaDias.map((d, i) => [d, i]));
  const idxLoja = Object.fromEntries(lojasCfg.map((l, i) => [norm(l.codigo), i]));
  const naJanela = (iso) => iso >= janela.inicio && iso <= janela.fim;

  const vendas = new Map();   // "li|di" -> [fat, com, c250, f250]
  const prod = new Map();     // "li|di|pi" -> [qtd, valor]
  const nomesProd = [];
  const idxProd = new Map();
  const pid = (nome) => {
    if (!idxProd.has(nome)) { idxProd.set(nome, nomesProd.length); nomesProd.push(nome); }
    return idxProd.get(nome);
  };

  // 1) mantém da base o que está fora da janela consultada
  if (base && base.periodo && base.periodo.inicio === periodo.inicio && base.periodo.fim === periodo.fim) {
    for (const [li, di, f, c, c2, f2] of base.vendas || []) {
      if (!naJanela(base.dias[di])) vendas.set(`${li}|${di}`, [f, c, c2, f2]);
    }
    for (const [li, di, pi, q, v] of base.prod || []) {
      if (!naJanela(base.dias[di])) prod.set(`${li}|${di}|${pid(base.produtos[pi])}`, [q, v]);
    }
  }

  // 2) adiciona o resultado do gateway
  const ignoradas = new Set();
  for (const p of payloads) {
    const lojaI = (i) => {
      const li = idxLoja[norm(p.lojas[i])];
      if (li === undefined) ignoradas.add(p.lojas[i]);
      return li;
    };
    for (const [l, d, f, c, c2, f2] of p.vendas || []) {
      const li = lojaI(l);
      if (li === undefined || idxDia[d] === undefined || !naJanela(d)) continue;
      const k = `${li}|${idxDia[d]}`;
      const cur = vendas.get(k) || [0, 0, 0, 0];
      vendas.set(k, [cur[0] + f, cur[1] + c, cur[2] + c2, cur[3] + f2]);
    }
    for (const [l, d, pIdx, q, v] of p.prod || []) {
      const li = lojaI(l);
      if (li === undefined || idxDia[d] === undefined || !naJanela(d)) continue;
      const k = `${li}|${idxDia[d]}|${pid(String(p.produtos[pIdx]).trim().toUpperCase())}`;
      const cur = prod.get(k) || [0, 0];
      prod.set(k, [cur[0] + q, cur[1] + v]);
    }
  }

  const r2 = (x) => Math.round(x * 100) / 100;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const ordenar = (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] || 0) - (b[2] || 0);
  return {
    dados: {
      atualizado_em: agoraISO(),
      periodo,
      limite: LIMITE,
      limite_inclui_servico: false,
      fonte: 'gateway',
      lojas: lojasCfg.map(({ codigo, nome, cidade, uf, endereco, copos, lat, lng }) =>
        ({ codigo, nome, cidade, uf, endereco, copos, lat, lng })),
      dias: listaDias,
      vendas: [...vendas.entries()]
        .filter(([, v]) => v[0] || v[1])
        .map(([k, v]) => { const [li, di] = k.split('|').map(Number); return [li, di, r2(v[0]), v[1], v[2], r2(v[3])]; })
        .sort(ordenar),
      produtos: nomesProd,
      prod: [...prod.entries()]
        .filter(([, v]) => v[0] > 0)
        .map(([k, v]) => { const [li, di, pi] = k.split('|').map(Number); return [li, di, pi, r3(v[0]), r2(v[1])]; })
        .sort(ordenar),
    },
    ignoradas: [...ignoradas],
  };
}

module.exports = {
  PARTES, INICIO_ACAO, FIM_ACAO, norm, dias, blocos, hojeSP, agoraISO, carregarLojas,
  chamarFluxo, consultarPeriodo, consolidar, classificarErro, ErroGateway,
};
