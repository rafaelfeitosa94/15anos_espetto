// Consolidação dos resultados da procedure dbo.sp_dashboard_copo15 no mesmo formato de data/dados.json
// (o mesmo gerado pelo extrator Python). Usado pelo runner do GitHub instalado na rede (scripts/atualizar-sql.js).
const fs = require('fs');
const path = require('path');

const PARTES = ['vendas', 'produtos_espetto', 'produtos_parceiros', 'comandas_copo'];
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

/** Divide [inicio, fim] em blocos de N dias. */
function blocos(inicio, fim, n) {
  const out = [];
  const ds = dias(inicio, fim);
  for (let i = 0; i < ds.length; i += n) out.push({ inicio: ds[i], fim: ds[Math.min(i + n, ds.length) - 1] });
  return out;
}

/**
 * Executa as 3 partes em paralelo; dentro de cada parte, o período é dividido em blocos de
 * `diasPorBloco` dias consultados em sequência (blocos menores = menos memória no SQL Express).
 * `chamar({ inicio, fim, parte })` deve devolver o payload da procedure já em objeto.
 */
async function consultarPeriodo(chamar, inicio, fim, { diasPorBloco = 7 } = {}) {
  const lista = blocos(inicio, fim, diasPorBloco);
  const porParte = await Promise.all(PARTES.map(async (parte) => {
    const res = [];
    for (const b of lista) res.push(await chamar({ ...b, parte }));
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

  const vendas = new Map();   // "li|di" -> [fat, com, c250, f250, copos, comandas com copo]
  // "li|di|comanda" -> [valor de consumo, copos, faturamento (pagamentos), qtd chopp 15 anos, valor chopp 15 anos]
  const comandasCopo = new Map();
  const prod = new Map();     // "li|di|pi" -> [qtd, valor]
  const nomesProd = [];
  const idxProd = new Map();
  const pid = (nome) => {
    if (!idxProd.has(nome)) { idxProd.set(nome, nomesProd.length); nomesProd.push(nome); }
    return idxProd.get(nome);
  };

  // 1) mantém da base o que está fora da janela consultada
  if (base && base.periodo && base.periodo.inicio === periodo.inicio && base.periodo.fim === periodo.fim) {
    for (const [li, di, f, c, c2, f2, cp, ccp] of base.vendas || []) {
      if (!naJanela(base.dias[di])) vendas.set(`${li}|${di}`, [f, c, c2, f2, cp || 0, ccp || 0]);
    }
    for (const [li, di, pi, q, v] of base.prod || []) {
      if (!naJanela(base.dias[di])) prod.set(`${li}|${di}|${pid(base.produtos[pi])}`, [q, v]);
    }
    for (const [li, di, numero, valor, copos, fat = null, chq = 0, chv = 0] of base.comandas_copo || []) {
      if (!naJanela(base.dias[di])) comandasCopo.set(`${li}|${di}|${numero}`, [valor, copos, fat, chq, chv]);
    }
  }

  // 2) adiciona o resultado da procedure
  const ignoradas = new Set();
  for (const p of payloads) {
    const lojaI = (i) => {
      const li = idxLoja[norm(p.lojas[i])];
      if (li === undefined) ignoradas.add(p.lojas[i]);
      return li;
    };
    for (const [l, d, f, c, c2, f2, cp = 0, ccp = 0] of p.vendas || []) {
      const li = lojaI(l);
      if (li === undefined || idxDia[d] === undefined || !naJanela(d)) continue;
      const k = `${li}|${idxDia[d]}`;
      const cur = vendas.get(k) || [0, 0, 0, 0, 0, 0];
      vendas.set(k, [cur[0] + f, cur[1] + c, cur[2] + c2, cur[3] + f2, cur[4] + cp, cur[5] + ccp]);
    }
    for (const [l, d, pIdx, q, v] of p.prod || []) {
      const li = lojaI(l);
      if (li === undefined || idxDia[d] === undefined || !naJanela(d)) continue;
      const k = `${li}|${idxDia[d]}|${pid(String(p.produtos[pIdx]).trim().toUpperCase())}`;
      const cur = prod.get(k) || [0, 0];
      prod.set(k, [cur[0] + q, cur[1] + v]);
    }
    for (const [l, d, numero, valor, copos, fat = null, chq = 0, chv = 0] of p.comandas_copo || []) {
      const nomeLoja = typeof l === 'number' ? p.lojas[l] : l;
      const li = idxLoja[norm(nomeLoja)];
      if (li === undefined) ignoradas.add(nomeLoja);
      if (li === undefined || idxDia[d] === undefined || !naJanela(d)) continue;
      comandasCopo.set(`${li}|${idxDia[d]}|${numero}`, [Number(valor) || 0, Number(copos) || 0, fat == null ? null : Number(fat), Number(chq) || 0, Number(chv) || 0]);
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
      fonte: 'runner',
      lojas: lojasCfg.map(({ codigo, nome, cidade, uf, endereco, copos, lat, lng, pdv_externo, meta }) =>
        ({ codigo, nome, cidade, uf, endereco, copos, lat, lng, ...(pdv_externo ? { pdv_externo } : {}), ...(meta ? { meta } : {}) })),
      dias: listaDias,
      vendas: [...vendas.entries()]
        .filter(([, v]) => v[0] || v[1] || v[4])
        .map(([k, v]) => { const [li, di] = k.split('|').map(Number); return [li, di, r2(v[0]), v[1], v[2], r2(v[3]), v[4], v[5]]; })
        .sort(ordenar),
      comandas_copo: [...comandasCopo.entries()]
        .map(([k, v]) => { const [li, di, ...numero] = k.split('|'); return [Number(li), Number(di), numero.join('|'), r2(v[0]), r3(v[1]), v[2] == null ? null : r2(v[2]), r3(v[3] || 0), r2(v[4] || 0)]; })
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[3] - a[3]),
      produtos: nomesProd,
      prod: [...prod.entries()]
        .filter(([, v]) => v[0] > 0)
        .map(([k, v]) => { const [li, di, pi] = k.split('|').map(Number); return [li, di, pi, r3(v[0]), r2(v[1])]; })
        .sort(ordenar),
    },
    ignoradas: [...ignoradas],
  };
}

/**
 * As tabelas do Espetto/Mané (vendas, produtos, pagamentos) são recarregadas pelo Fabric várias vezes ao dia;
 * uma consulta feita no meio da recarga devolve lojas/dias faltando ou incompletos. Compara o resultado novo com
 * a versão publicada (base) nos dias já fechados (antes de hoje) e devolve as lojas/dias em que comandas, copos
 * entregues ou valor de produtos encolheram mais que `tolerancia`.
 */
function quedasSuspeitas(base, dados, hoje, tolerancia = 0.3) {
  if (!base || !base.vendas || !base.dias || !base.periodo || base.periodo.inicio !== dados.periodo.inicio) return [];
  const chave = (v) => `${v[0]}|${v[1]}`;
  const somaProd = (lista) => {
    const m = new Map();
    for (const x of lista || []) m.set(chave(x), (m.get(chave(x)) || 0) + (x[4] || 0));
    return m;
  };
  const novo = new Map(dados.vendas.map(v => [chave(v), v]));
  const prodBase = somaProd(base.prod);
  const prodNovo = somaProd(dados.prod);
  const caiu = (antes, agora) => antes > 0 && agora < antes * (1 - tolerancia);
  const chaves = new Set([...base.vendas.map(chave), ...prodBase.keys()]);
  const out = [];
  for (const k of chaves) {
    const [li, di] = k.split('|').map(Number);
    const dia = base.dias[di];
    if (!(dia < hoje)) continue;
    // Villa Lobos usa a query da Zig, que pode mudar de escopo/linhas sem a tabela estar em recarga.
    if (dados.lojas[li]?.codigo === 'ESP VILA LOBOS') continue;
    const b = base.vendas.find(v => v[0] === li && v[1] === di) || null;
    const n = novo.get(k);
    const motivos = [];
    if (b && caiu(b[3], n ? n[3] : 0)) motivos.push(`comandas ${b[3]}→${n ? n[3] : 0}`);
    if (b && caiu(b[6] || 0, n ? n[6] || 0 : 0)) motivos.push(`copos ${b[6]}→${n ? n[6] || 0 : 0}`);
    if (caiu(prodBase.get(k) || 0, prodNovo.get(k) || 0)) {
      motivos.push(`produtos R$ ${Math.round(prodBase.get(k))}→${Math.round(prodNovo.get(k) || 0)}`);
    }
    if (!motivos.length) continue;
    out.push({
      li, di, dia, motivo: motivos.join(', '), base: b,
      comandas: (base.comandas_copo || []).filter(c => c[0] === li && c[1] === di),
      prod: (base.prod || []).filter(x => x[0] === li && x[1] === di).map(x => [base.produtos[x[2]], x[3], x[4]]),
    });
  }
  return out.sort((a, b) => a.di - b.di || a.li - b.li);
}

/** Mantém a versão publicada (vendas, copos, comandas com copo e produtos) nas lojas/dias suspeitos. */
function preservarBase(dados, suspeitos) {
  if (!suspeitos.length) return 0;
  const keys = new Set(suspeitos.map(s => `${s.li}|${s.di}`));
  const fora = (x) => !keys.has(`${x[0]}|${x[1]}`);
  dados.vendas = dados.vendas.filter(fora);
  for (const s of suspeitos) {
    if (!s.base) continue;
    const linha = s.base.slice();
    while (linha.length < 8) linha.push(0);
    dados.vendas.push(linha);
  }
  if (dados.comandas_copo) {
    dados.comandas_copo = dados.comandas_copo.filter(fora);
    for (const s of suspeitos) dados.comandas_copo.push(...s.comandas);
    dados.comandas_copo.sort((a, b) => a[0] - b[0] || a[1] - b[1] || b[3] - a[3]);
  }
  dados.prod = dados.prod.filter(fora);
  const idx = new Map(dados.produtos.map((nome, i) => [nome, i]));
  for (const s of suspeitos) {
    for (const [nome, q, v] of s.prod) {
      if (!idx.has(nome)) { idx.set(nome, dados.produtos.length); dados.produtos.push(nome); }
      dados.prod.push([s.li, s.di, idx.get(nome), q, v]);
    }
  }
  const ordenar = (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] || 0) - (b[2] || 0);
  dados.vendas.sort(ordenar);
  dados.prod.sort(ordenar);
  return suspeitos.length;
}

module.exports = {
  PARTES, INICIO_ACAO, FIM_ACAO, norm, dias, blocos, hojeSP, agoraISO, carregarLojas,
  consultarPeriodo, consolidar, quedasSuspeitas, preservarBase,
};
