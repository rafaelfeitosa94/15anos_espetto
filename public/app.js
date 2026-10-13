/* Ação Copo 15 Anos – dashboard */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtBRL0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const fmtInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const fmtPct = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 });
  const brl = (v) => fmtBRL.format(v || 0);
  const brlShort = (v) => {
    v = v || 0;
    if (Math.abs(v) >= 1e6) return 'R$ ' + (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' mi';
    if (Math.abs(v) >= 1e4) return 'R$ ' + (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mil';
    return fmtBRL0.format(v);
  };
  const int = (v) => fmtInt.format(v || 0);
  const pct = (v) => fmtPct.format(isFinite(v) ? v : 0);
  const fmtDate = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  let DATA = null;
  const state = {
    ini: null, fim: null,
    lojas: new Set(),
    rankBy: 'c250',
    evo: 'fat',
    prod: 'q',
    focus: null, // loja id em destaque no mapa
  };
  let charts = {};
  let map, markersLayer, tileLayer;

  /* ---------------- toast ---------------- */
  let toastT;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }

  /* ---------------- theme ---------------- */
  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('c15_theme', next);
    applyThemeToWidgets();
  }
  function applyThemeToWidgets() {
    if (tileLayer) setTiles();
    if (DATA) render();
  }

  /* ---------------- auth ---------------- */
  async function checkSession() {
    try {
      const r = await fetch('/api/login', { credentials: 'same-origin' });
      const j = await r.json();
      return !!j.ok;
    } catch (e) { return false; }
  }
  function showLogin() {
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
    setTimeout(() => $('lgUser').focus(), 50);
  }
  async function doLogin(ev) {
    ev.preventDefault();
    $('lgErr').textContent = '';
    $('lgBtn').disabled = true;
    try {
      const r = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: $('lgUser').value.trim(), pass: $('lgPass').value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || 'Usuário ou senha inválidos');
      $('lgPass').value = '';
      await boot();
    } catch (e) {
      $('lgErr').textContent = e.message;
    } finally {
      $('lgBtn').disabled = false;
    }
  }
  async function logout() {
    await fetch('/api/login', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    DATA = null;
    showLogin();
  }

  /* ---------------- data ---------------- */
  async function loadData() {
    const r = await fetch('/api/data?t=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { showLogin(); throw new Error('Sessão expirada'); }
    if (!r.ok) throw new Error('Falha ao carregar os dados');
    return r.json();
  }

  // Atualizar: consulta ao vivo pelo gateway (/api/atualizar); se o gateway não estiver
  // configurado, recarrega o último snapshot publicado (/api/data).
  async function refresh() {
    const btn = $('btnRefresh');
    btn.disabled = true;
    $('refreshIco').classList.add('spin');
    toast('Consultando o banco pelo gateway… pode levar até 1 minuto');
    try {
      const r = await fetch('/api/atualizar', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { showLogin(); throw new Error('Sessão expirada'); }
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.dados) {
        DATA = j.dados;
        indexData();
        setGateway(j.gateway);
        render();
        toast('Dados atualizados em tempo real: ' + fmtStamp(DATA.atualizado_em));
      } else {
        const st = (j.gateway && j.gateway.status) || 'erro';
        DATA = await loadData();
        indexData();
        if (st !== 'nao_configurado') setGateway(j.gateway);
        render();
        toast(st === 'nao_configurado'
          ? 'Gateway ainda não configurado: exibindo a última atualização publicada (' + fmtStamp(DATA.atualizado_em) + ')'
          : 'Não foi possível consultar o gateway: exibindo a última atualização publicada');
      }
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      $('refreshIco').classList.remove('spin');
    }
  }

  /* ---------------- gateway ---------------- */
  const GW_MSG = {
    ok: 'Gateway conectado',
    reautenticar: 'Reautenticação necessária',
    gateway_offline: 'Gateway offline',
    timeout: 'Gateway sem resposta (tempo limite)',
    erro: 'Falha na última consulta',
    nao_configurado: 'Gateway não configurado',
  };
  let gwState = null;

  function setGateway(g) {
    if (g) gwState = g;
    const st = gwState && gwState.status;
    const dot = $('gwDot');
    dot.className = 'gw-dot ' + (st === 'ok' ? 'ok' : !st || st === 'nao_configurado' ? 'idle' : 'warn');
    $('gwTxt').textContent = (GW_MSG[st] || 'Gateway: sem consulta ainda') +
      (gwState && gwState.em ? ' · ' + fmtStamp(gwState.em) : '');
    const alerta = st && !['ok', 'nao_configurado'].includes(st);
    $('gwBox').classList.toggle('alerta', !!alerta);
    $('gwBanner').classList.toggle('hidden', !alerta);
    if (alerta) {
      $('gwBannerTxt').textContent = st === 'reautenticar'
        ? '⚠ A conexão com o gateway precisa ser reativada (validação em 2 etapas). Os dados exibidos podem estar desatualizados.'
        : `⚠ ${GW_MSG[st] || 'Falha no gateway'}. Os dados exibidos são da última atualização bem-sucedida. Se persistir, reative a conexão.`;
    }
    $('gwModalStatus').textContent = 'Status atual: ' + (GW_MSG[st] || 'sem consulta ainda') +
      (gwState && gwState.mensagem ? ' (' + gwState.mensagem.slice(0, 140) + ')' : '');
  }

  function abrirGateway() { setGateway(); $('gwModal').classList.remove('hidden'); }
  function fecharGateway() { $('gwModal').classList.add('hidden'); }

  async function testarGateway() {
    const b = $('gwTestar');
    b.disabled = true;
    b.textContent = 'Testando…';
    try {
      const r = await fetch('/api/atualizar?teste=1', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { fecharGateway(); showLogin(); return; }
      const j = await r.json();
      setGateway(j.gateway);
      toast(j.ok ? 'Conexão com o gateway OK ✔' : 'Conexão ainda com problema: ' + (GW_MSG[j.gateway.status] || j.gateway.status));
      if (j.ok) fecharGateway();
    } catch (e) {
      toast('Falha ao testar: ' + e.message);
    } finally {
      b.disabled = false;
      b.textContent = 'Testar conexão';
    }
  }

  function fmtStamp(s) {
    if (!s) return '—';
    const d = new Date(s);
    return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // índices auxiliares
  function indexData() {
    DATA.lojaById = {};
    DATA.lojas.forEach((l, i) => { l.i = i; DATA.lojaById[i] = l; });
  }

  /* ---------------- filtros ---------------- */
  function clampDate(d) {
    if (d < DATA.periodo.inicio) return DATA.periodo.inicio;
    if (d > DATA.periodo.fim) return DATA.periodo.fim;
    return d;
  }
  function isoAdd(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function todayISO() {
    const d = new Date();
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function lastDataDay() {
    const t = todayISO();
    return t < DATA.periodo.fim ? isoAdd(t, -1) : DATA.periodo.fim;
  }

  function setupFilters() {
    const { inicio, fim } = DATA.periodo;
    ['fIni', 'fFim'].forEach(id => { $(id).min = inicio; $(id).max = fim; });
    if (!state.ini) { state.ini = inicio; state.fim = fim; }
    $('fIni').value = state.ini;
    $('fFim').value = state.fim;

    if (!state.lojas.size) DATA.lojas.forEach(l => state.lojas.add(l.i));
    renderLojaList();
  }

  function renderLojaList() {
    const q = $('lojaSearch').value.trim().toLowerCase();
    const list = $('lojaList');
    const sorted = [...DATA.lojas].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    list.innerHTML = '';
    sorted.forEach(l => {
      if (q && !(l.nome + ' ' + l.cidade).toLowerCase().includes(q)) return;
      const lab = document.createElement('label');
      lab.className = 'loja-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.lojas.has(l.i);
      cb.addEventListener('change', () => {
        cb.checked ? state.lojas.add(l.i) : state.lojas.delete(l.i);
        if (state.focus !== null && !state.lojas.has(state.focus)) state.focus = null;
        render();
      });
      const nm = document.createElement('span');
      nm.textContent = l.nome;
      const uf = document.createElement('span');
      uf.className = 'uf';
      uf.textContent = l.uf;
      lab.append(cb, nm, uf);
      list.appendChild(lab);
    });
    $('lojaCount').textContent = `(${state.lojas.size}/${DATA.lojas.length})`;
  }

  function quickDate(q) {
    const { inicio, fim } = DATA.periodo;
    const last = clampDate(lastDataDay());
    if (q === 'all') { state.ini = inicio; state.fim = fim; }
    else if (q === 'yesterday') { state.ini = last; state.fim = last; }
    else if (q === '7') { state.ini = clampDate(isoAdd(last, -6)); state.fim = last; }
    else if (q === 'week') {
      const d = new Date(last + 'T12:00:00');
      const dow = (d.getDay() + 6) % 7; // segunda = 0
      state.ini = clampDate(isoAdd(last, -dow)); state.fim = last;
    }
    $('fIni').value = state.ini;
    $('fFim').value = state.fim;
    render();
  }

  /* ---------------- agregação ---------------- */
  function aggregate() {
    const dias = DATA.dias;
    const inDay = dias.map(d => d >= state.ini && d <= state.fim);
    const perLoja = DATA.lojas.map(l => ({ l, fat: 0, com: 0, c250: 0, fat250: 0 }));
    const perDay = dias.map(d => ({ d, fat: 0, com: 0, c250: 0 }));
    // vendas: [loja, dia, faturamento, comandas, comandas>limite, faturamento>limite]
    for (const v of DATA.vendas) {
      const [li, di, fat, com, c250, f250] = v;
      if (!inDay[di] || !state.lojas.has(li)) continue;
      const p = perLoja[li];
      p.fat += fat; p.com += com; p.c250 += c250; p.fat250 += f250;
      const q = perDay[di];
      q.fat += fat; q.com += com; q.c250 += c250;
    }
    // produtos: [loja, dia, produto, qtd, valor]
    const prodMap = new Map();
    for (const p of DATA.prod) {
      const [li, di, pi, qt, vl] = p;
      if (!inDay[di] || !state.lojas.has(li)) continue;
      const cur = prodMap.get(pi) || { q: 0, v: 0 };
      cur.q += qt; cur.v += vl;
      prodMap.set(pi, cur);
    }
    const tot = perLoja.reduce((a, p) => {
      if (!state.lojas.has(p.l.i)) return a;
      a.fat += p.fat; a.com += p.com; a.c250 += p.c250; a.fat250 += p.fat250; a.copos += p.l.copos || 0;
      return a;
    }, { fat: 0, com: 0, c250: 0, fat250: 0, copos: 0 });
    const days = perDay.filter((_, i) => inDay[i]);
    return { perLoja, days, prodMap, tot };
  }

  // copos usados até a data final do filtro, contando desde o início da ação (estoque é da ação toda)
  function coposUsados(lojaFilter) {
    const fimIdx = DATA.dias.findIndex(d => d > state.fim);
    const lim = fimIdx < 0 ? DATA.dias.length : fimIdx;
    const out = new Map();
    for (const v of DATA.vendas) {
      if (v[1] >= lim) continue;
      if (lojaFilter && !lojaFilter.has(v[0])) continue;
      out.set(v[0], (out.get(v[0]) || 0) + v[4]);
    }
    return out;
  }

  /* ---------------- render ---------------- */
  function render() {
    if (!DATA) return;
    $('lojaCount').textContent = `(${state.lojas.size}/${DATA.lojas.length})`;
    $('lastUpd').textContent = 'Atualizado em ' + fmtStamp(DATA.atualizado_em);
    $('limiteTxt').textContent = 'R$ ' + DATA.limite.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    renderProgress();
    const agg = aggregate();
    const usados = coposUsados(state.lojas);
    agg.perLoja.forEach(p => {
      p.usados = usados.get(p.l.i) || 0;
      p.pct = p.l.copos ? p.usados / p.l.copos : 0;
      p.tm = p.com ? p.fat / p.com : 0;
    });
    renderBanner();
    renderKpis(agg);
    renderRanking(agg);
    renderEvo(agg);
    renderProd(agg);
    renderMap(agg);
  }

  function renderProgress() {
    const { inicio, fim } = DATA.periodo;
    const total = DATA.dias.length;
    const t = todayISO();
    let done = 0;
    if (t > fim) done = total;
    else if (t >= inicio) done = DATA.dias.indexOf(t) + 1;
    $('progBar').style.width = (done / total * 100) + '%';
    $('progLbl').textContent = t < inicio
      ? `Começa em ${fmtDate(inicio)} · ${Math.round((new Date(inicio) - new Date(t)) / 864e5)} dia(s)`
      : t > fim ? `Ação encerrada · ${total} dias` : `Dia ${done} de ${total}`;
  }

  function renderBanner() {
    const b = $('emptyBanner');
    if (!DATA.vendas.length) {
      b.textContent = `A ação começa em ${fmtDate(DATA.periodo.inicio)}. Os indicadores serão preenchidos a partir da primeira atualização após essa data.`;
      b.classList.remove('hidden');
    } else if (DATA.aviso) {
      b.textContent = DATA.aviso;
      b.classList.remove('hidden');
    } else {
      b.classList.add('hidden');
    }
  }

  function setBar(el, ratio) {
    el.style.width = Math.min(100, ratio * 100) + '%';
    el.style.background = ratio >= .9 ? cssVar('--bad') : ratio >= .6 ? cssVar('--warn') : cssVar('--ok');
  }

  function renderKpis({ tot, days, perLoja }) {
    const usados = perLoja.filter(p => state.lojas.has(p.l.i)).reduce((a, p) => a + p.usados, 0);
    const nDays = days.length || 1;
    $('kC250').textContent = int(tot.c250);
    $('kC250s').textContent = tot.com ? `${pct(tot.c250 / tot.com)} das comandas · ${brlShort(tot.fat250)}` : '—';
    $('kCopos').textContent = int(usados);
    $('kCoposS').textContent = tot.copos ? `de ${int(tot.copos)} · ${pct(usados / tot.copos)} do estoque · saldo ${int(Math.max(0, tot.copos - usados))}` : '—';
    setBar($('kCoposBar'), tot.copos ? usados / tot.copos : 0);
    $('kFat').textContent = brlShort(tot.fat);
    $('kFat').title = brl(tot.fat);
    $('kFatS').textContent = `média ${brlShort(tot.fat / nDays)} / dia`;
    $('kCom').textContent = int(tot.com);
    $('kComS').textContent = `média ${int(tot.com / nDays)} / dia`;
    $('kTm').textContent = brl(tot.com ? tot.fat / tot.com : 0);
  }

  function renderRanking({ perLoja }) {
    const key = state.rankBy;
    const rows = perLoja.filter(p => state.lojas.has(p.l.i))
      .map(p => ({ ...p, sort: key === 'pct' ? p.pct : key === 'tm' ? p.tm : p[key] }))
      .sort((a, b) => b.sort - a.sort || b.fat - a.fat);
    const body = $('rankBody');
    body.innerHTML = '';
    rows.forEach((p, i) => {
      const tr = document.createElement('tr');
      if (state.focus === p.l.i) tr.className = 'sel';
      const color = p.pct >= .9 ? cssVar('--bad') : p.pct >= .6 ? cssVar('--warn') : cssVar('--ok');
      tr.innerHTML = `
        <td class="pos ${i < 3 ? 'top' : ''}">${i + 1}º</td>
        <td class="loja"></td>
        <td class="num"><b>${int(p.c250)}</b></td>
        <td><div class="pct-cell"><div class="mini-bar"><div style="width:${Math.min(100, p.pct * 100)}%;background:${color}"></div></div><span>${int(p.usados)}/${int(p.l.copos)}</span></div></td>
        <td class="num">${brlShort(p.fat)}</td>
        <td class="num">${int(p.com)}</td>
        <td class="num">${brl(p.tm)}</td>
        <td class="num">${saldoTxt(p)}</td>`;
      tr.querySelector('.loja').textContent = p.l.nome;
      tr.querySelector('.loja').title = `${p.l.nome} – ${p.l.cidade}`;
      tr.addEventListener('click', () => focusLoja(p.l.i, true));
      body.appendChild(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="8" class="muted">Nenhuma loja selecionada</td></tr>';
  }

  function saldoTxt(p) {
    const s = (p.l.copos || 0) - p.usados;
    if (s >= 0) return int(s);
    return `<span class="esgotado" title="Comandas acima do limite além do estoque de copos">esgotado (${int(-s)} a mais)</span>`;
  }

  function chartDefaults() {
    Chart.defaults.font.family = '"Basic Sans", "Nunito Sans", system-ui, sans-serif';
    Chart.defaults.color = cssVar('--muted');
    Chart.defaults.borderColor = cssVar('--grid');
  }

  function renderEvo({ days }) {
    chartDefaults();
    const key = state.evo;
    const labels = days.map(d => fmtDate(d.d));
    const vals = days.map(d => d[key]);
    const color = key === 'c250' ? cssVar('--accent') : key === 'fat' ? cssVar('--accent-2') : cssVar('--accent-3');
    const fmt = key === 'fat' ? brlShort : int;
    const cfg = {
      type: 'bar',
      data: { labels, datasets: [{ data: vals, backgroundColor: color, borderRadius: 4, maxBarThickness: 26 }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + (key === 'fat' ? brl(c.raw) : int(c.raw)) } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
          y: { beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    };
    if (charts.evo) charts.evo.destroy();
    charts.evo = new Chart($('chEvo'), cfg);
  }

  function renderProd({ prodMap }) {
    chartDefaults();
    const key = state.prod;
    const top = [...prodMap.entries()]
      .map(([pi, o]) => ({ nome: DATA.produtos[pi], q: o.q, v: o.v }))
      .sort((a, b) => b[key] - a[key]).slice(0, 10);
    const cfg = {
      type: 'bar',
      data: {
        labels: top.map(t => t.nome.length > 24 ? t.nome.slice(0, 23) + '…' : t.nome),
        datasets: [{
          data: top.map(t => t[key]),
          backgroundColor: top.map((_, i) => i < 3 ? cssVar('--accent') : cssVar('--accent-2')),
          borderRadius: 4, maxBarThickness: 24,
        }],
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        layout: { padding: { left: 4 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: c => top[c[0].dataIndex].nome,
            label: c => { const t = top[c.dataIndex]; return [` Quantidade: ${int(t.q)}`, ` Valor: ${brl(t.v)}`]; },
          } },
        },
        scales: {
          x: { beginAtZero: true, ticks: { callback: v => key === 'v' ? brlShort(v) : int(v) } },
          y: { grid: { display: false }, ticks: { color: cssVar('--text') } },
        },
      },
    };
    if (charts.prod) charts.prod.destroy();
    charts.prod = new Chart($('chProd'), cfg);
  }

  /* ---------------- mapa ---------------- */
  function setTiles() {
    // tema escuro do mapa é aplicado via CSS (.map-dark) sobre os tiles do OpenStreetMap
    $('map').classList.toggle('map-dark', isDark());
    if (tileLayer) return;
    tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }

  function initMap() {
    if (map) return;
    map = L.map('map', { zoomControl: true, scrollWheelZoom: false });
    setTiles();
    markersLayer = L.layerGroup().addTo(map);
    const pts = DATA.lojas.filter(l => l.lat).map(l => [l.lat, l.lng]);
    if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
    else map.setView([-22.9, -43.2], 6);
  }

  function renderMap({ perLoja, tot }) {
    initMap();
    markersLayer.clearLayers();
    const sel = perLoja.filter(p => state.lojas.has(p.l.i) && p.l.lat);
    const max = Math.max(1, ...sel.map(p => p.c250));
    sel.sort((a, b) => b.c250 - a.c250).forEach(p => {
      const r = 7 + Math.sqrt(p.c250 / max) * 22;
      const color = p.pct >= .9 ? cssVar('--bad') : p.pct >= .6 ? cssVar('--warn') : cssVar('--ok');
      const focused = state.focus === p.l.i;
      const m = L.circleMarker([p.l.lat, p.l.lng], {
        radius: r, color: focused ? cssVar('--text') : '#fff', weight: focused ? 3 : 1.5,
        fillColor: color, fillOpacity: .85,
      });
      m.bindTooltip(`<div class="tt"><b></b>
        <div><span>Comandas &gt; R$250</span><span>${int(p.c250)}</span></div>
        <div><span>Faturamento</span><span>${brlShort(p.fat)}</span></div>
        <div><span>Ticket médio</span><span>${brl(p.tm)}</span></div>
        <div><span>Total comandas</span><span>${int(p.com)}</span></div>
        <div><span>Copos</span><span>${int(p.usados)} / ${int(p.l.copos)}</span></div></div>`,
        { direction: 'top', offset: [0, -r] });
      m.on('tooltipopen', e => { e.tooltip.getElement().querySelector('b').textContent = p.l.nome; });
      m.on('click', () => focusLoja(p.l.i, false));
      markersLayer.addLayer(m);
      if (r > 14 && p.c250 > 0) {
        markersLayer.addLayer(L.marker([p.l.lat, p.l.lng], {
          interactive: false,
          icon: L.divIcon({ className: 'map-label', html: int(p.c250), iconSize: [40, 14], iconAnchor: [20, 7] }),
        }));
      }
    });
    renderInsights(perLoja, tot);
  }

  function renderInsights(perLoja, tot) {
    const f = state.focus !== null ? perLoja[state.focus] : null;
    let usados, copos;
    if (f) {
      $('insScope').textContent = 'Loja selecionada';
      $('insTitle').textContent = f.l.nome;
      $('insCity').textContent = `${f.l.cidade}${f.l.endereco ? ' · ' + f.l.endereco : ''}`;
      $('iC250').textContent = int(f.c250);
      $('iFat').textContent = brlShort(f.fat);
      $('iTm').textContent = brl(f.tm);
      $('iCom').textContent = int(f.com);
      usados = f.usados; copos = f.l.copos;
      $('insReset').classList.remove('hidden');
    } else {
      $('insScope').textContent = 'Visão geral';
      $('insTitle').textContent = state.lojas.size === DATA.lojas.length ? 'Todas as lojas' : `${state.lojas.size} lojas selecionadas`;
      $('insCity').textContent = `${fmtDate(state.ini)} a ${fmtDate(state.fim)}`;
      $('iC250').textContent = int(tot.c250);
      $('iFat').textContent = brlShort(tot.fat);
      $('iTm').textContent = brl(tot.com ? tot.fat / tot.com : 0);
      $('iCom').textContent = int(tot.com);
      usados = perLoja.filter(p => state.lojas.has(p.l.i)).reduce((a, p) => a + p.usados, 0);
      copos = tot.copos;
      $('insReset').classList.add('hidden');
    }
    $('iCopos').textContent = `${int(usados)} / ${int(copos)} (${pct(copos ? usados / copos : 0)})`;
    setBar($('iCoposBar'), copos ? usados / copos : 0);
  }

  function focusLoja(i, scroll) {
    state.focus = state.focus === i ? null : i;
    render();
    const l = DATA.lojaById[i];
    if (state.focus !== null && l.lat) map.flyTo([l.lat, l.lng], Math.max(map.getZoom(), 11), { duration: .6 });
    if (scroll) $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    $('loginForm').addEventListener('submit', doLogin);
    $('btnLogout').addEventListener('click', logout);
    $('btnTheme').addEventListener('click', toggleTheme);
    $('btnRefresh').addEventListener('click', refresh);
    $('btnGateway').addEventListener('click', abrirGateway);
    $('gwBannerBtn').addEventListener('click', abrirGateway);
    $('gwClose').addEventListener('click', fecharGateway);
    $('gwModal').addEventListener('click', e => { if (e.target.id === 'gwModal') fecharGateway(); });
    $('gwTestar').addEventListener('click', testarGateway);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharGateway(); });
    $('sbOpen').addEventListener('click', () => $('app').classList.add('sb-on'));
    $('sbClose').addEventListener('click', () => $('app').classList.remove('sb-on'));
    $('sbBackdrop').addEventListener('click', () => $('app').classList.remove('sb-on'));
    $('fIni').addEventListener('change', e => {
      state.ini = clampDate(e.target.value || DATA.periodo.inicio);
      if (state.ini > state.fim) state.fim = state.ini;
      $('fIni').value = state.ini; $('fFim').value = state.fim;
      render();
    });
    $('fFim').addEventListener('change', e => {
      state.fim = clampDate(e.target.value || DATA.periodo.fim);
      if (state.fim < state.ini) state.ini = state.fim;
      $('fIni').value = state.ini; $('fFim').value = state.fim;
      render();
    });
    $('quickDates').addEventListener('click', e => { const q = e.target.dataset.q; if (q) quickDate(q); });
    $('lojaSearch').addEventListener('input', renderLojaList);
    $('lojaAll').addEventListener('click', () => { DATA.lojas.forEach(l => state.lojas.add(l.i)); renderLojaList(); render(); });
    $('lojaNone').addEventListener('click', () => { state.lojas.clear(); state.focus = null; renderLojaList(); render(); });
    $('rankBy').addEventListener('change', e => { state.rankBy = e.target.value; render(); });
    $('evoSeg').addEventListener('click', e => segClick(e, 'evo'));
    $('prodSeg').addEventListener('click', e => segClick(e, 'prod'));
    $('insReset').addEventListener('click', () => { state.focus = null; render(); });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!document.documentElement.getAttribute('data-theme')) applyThemeToWidgets();
    });
  }
  function segClick(e, key) {
    const v = e.target.dataset.v;
    if (!v) return;
    state[key] = v;
    e.currentTarget.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    render();
  }

  async function boot() {
    try {
      DATA = await loadData();
    } catch (e) {
      if (e.message !== 'Sessão expirada') toast(e.message);
      return;
    }
    indexData();
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    setupFilters();
    setGateway(DATA.gateway || null);
    render();
    if (location.hash === '#gateway') abrirGateway(); // link direto para a validação
    // re-renderiza quando as fontes da marca terminam de carregar (gráficos medem os rótulos)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
    if (map) setTimeout(() => map.invalidateSize(), 50);
  }

  wire();
  checkSession().then(ok => ok ? boot() : showLogin());
})();
