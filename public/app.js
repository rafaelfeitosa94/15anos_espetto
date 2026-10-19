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
    rankBy: 'cop',
    evo: 'fat',
    prod: 'q',
    prodAno: 'atual', // top 10: 'atual' (2026) ou 'aa' (mesmo período de 2025)
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

  // Atualizar: dispara o workflow no GitHub, que roda no servidor da rede (runner) e consulta o SQL Server.
  // O dashboard acompanha a execução e recarrega quando a nova versão dos dados estiver publicada.
  const espera = (ms) => new Promise(r => setTimeout(r, ms));
  let atualizando = false;

  async function refresh() {
    if (atualizando) { toast('Atualização já em andamento…'); return; }
    const btn = $('btnRefresh');
    atualizando = true;
    btn.disabled = true;
    $('refreshIco').classList.add('spin');
    const antes = DATA && DATA.atualizado_em;
    try {
      const r = await fetch('/api/atualizar', { method: 'POST', credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 401) { showLogin(); throw new Error('Sessão expirada'); }
      const j = await r.json().catch(() => ({}));
      const ex = j.execucao || {};
      if (!j.ok || ex.status === 'nao_configurado') {
        DATA = await loadData(); indexData(); render();
        setExecucao(ex.status === 'nao_configurado' ? null : ex);
        toast(ex.status === 'nao_configurado'
          ? 'Atualização sob demanda ainda não configurada: exibindo a última versão publicada'
          : 'Não foi possível acionar o servidor: ' + (ex.mensagem || 'erro'));
        return;
      }
      toast(j.disparado ? 'Atualização solicitada ao servidor. Leva de 2 a 4 minutos…' : 'Já existe uma atualização em andamento. Acompanhando…');
      setExecucao({ status: 'executando', fase: 'queued' });

      // 1) acompanha o workflow (até 15 min)
      let final = null;
      for (let i = 0; i < 60 && !final; i++) {
        await espera(15000);
        const s = await fetch('/api/atualizar', { credentials: 'same-origin', cache: 'no-store' }).then(x => x.json()).catch(() => null);
        if (!s || !s.execucao) continue;
        setExecucao(s.execucao);
        if (s.execucao.status === 'runner_offline') { final = s.execucao; break; }
        if (s.execucao.fase === 'completed' && (!j.disparado || new Date(s.execucao.criado_em) >= new Date(j.disparado_em) - 60000)) final = s.execucao;
      }
      if (!final || final.status !== 'ok') {
        toast(final && final.status === 'runner_offline'
          ? 'O servidor de atualização parece desligado: a execução está na fila'
          : 'A atualização não terminou com sucesso: veja o aviso no topo');
        return;
      }
      // 2) espera a Vercel publicar a nova versão dos dados (até 5 min)
      toast('Dados consultados! Publicando a nova versão…');
      for (let i = 0; i < 20; i++) {
        const novo = await loadData();
        if (!antes || novo.atualizado_em !== antes) {
          DATA = novo; indexData(); render();
          toast('Dados atualizados: ' + fmtStamp(DATA.atualizado_em));
          return;
        }
        await espera(15000);
      }
      toast('Consulta concluída, mas a publicação está demorando. Recarregue a página em instantes.');
    } catch (e) {
      toast(e.message);
    } finally {
      atualizando = false;
      btn.disabled = false;
      $('refreshIco').classList.remove('spin');
    }
  }

  /* ---------------- status do servidor de atualização (runner) ---------------- */
  const EX_MSG = {
    ok: 'Servidor OK',
    executando: 'Atualizando no servidor…',
    falhou: 'Última atualização falhou',
    runner_offline: 'Servidor offline (execução na fila)',
    erro: 'Não foi possível consultar o status',
    sem_execucao: 'Servidor: nenhuma execução ainda',
  };

  function setExecucao(ex) {
    const dot = $('gwDot');
    if (!ex) {
      dot.className = 'gw-dot idle';
      $('gwTxt').textContent = 'Atualização automática de hora em hora (11h40–23h40)';
      $('gwLink').classList.add('hidden');
      $('gwBanner').classList.add('hidden');
      return;
    }
    const st = ex.status;
    dot.className = 'gw-dot ' + (st === 'ok' ? 'ok' : st === 'executando' ? 'run' : st === 'sem_execucao' ? 'idle' : 'warn');
    const quando = ex.atualizado_em || ex.criado_em;
    $('gwTxt').textContent = (EX_MSG[st] || st) + (quando && st !== 'executando' ? ' · ' + fmtStamp(quando) : '');
    $('gwLink').classList.toggle('hidden', !ex.url);
    if (ex.url) { $('gwLink').href = ex.url; $('gwBannerBtn').href = ex.url; }
    const alerta = ['falhou', 'runner_offline'].includes(st);
    $('gwBox').classList.toggle('alerta', alerta);
    $('gwBanner').classList.toggle('hidden', !alerta);
    $('gwBannerBtn').classList.toggle('hidden', !ex.url);
    if (alerta) {
      $('gwBannerTxt').textContent = st === 'runner_offline'
        ? '⚠ O servidor de atualização (SRVTESTE) parece desligado ou sem internet: há uma execução na fila há mais de 10 minutos. Os dados exibidos podem estar desatualizados.'
        : `⚠ A última atualização automática falhou (${fmtStamp(quando)}). Os dados exibidos são da última atualização bem-sucedida.`;
    }
  }

  async function carregarExecucao() {
    try {
      const r = await fetch('/api/atualizar', { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      setExecucao(j.execucao && j.execucao.status !== 'nao_configurado' ? j.execucao : null);
    } catch (e) { /* silencioso */ }
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
    const perLoja = DATA.lojas.map(l => ({ l, fat: 0, com: 0, c250: 0, fat250: 0, cop: 0, ccop: 0 }));
    const perDay = dias.map(d => ({ d, fat: 0, com: 0, c250: 0, cop: 0 }));
    // vendas: [loja, dia, faturamento, comandas, comandas>limite, faturamento>limite,
    //          copos entregues (item COPO ESPETTO ANIVER 15), comandas com copo]
    for (const v of DATA.vendas) {
      const [li, di, fat, com, c250, f250, cop = 0, ccop = 0] = v;
      if (!inDay[di] || !state.lojas.has(li)) continue;
      const p = perLoja[li];
      p.fat += fat; p.com += com; p.c250 += c250; p.fat250 += f250; p.cop += cop; p.ccop += ccop;
      const q = perDay[di];
      q.fat += fat; q.com += com; q.c250 += c250; q.cop += cop;
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
      a.cop += p.cop; a.ccop += p.ccop;
      return a;
    }, { fat: 0, com: 0, c250: 0, fat250: 0, copos: 0, cop: 0, ccop: 0 });
    const days = perDay.filter((_, i) => inDay[i]);
    return { perLoja, days, prodMap, tot };
  }

  /* ---------------- ano anterior (mesmas datas de 2025) ---------------- */
  const DIAS_ANO = 365; // 15/10/2025 -> 15/10/2026 (sem 29/02 no intervalo)
  function aggregateAA() {
    const AA = DATA.ano_anterior;
    if (!AA) return null;
    // Indicadores: compara só até o último dia que já tem dados em 2026 (mesmo número de dias nos dois anos).
    // Gráfico de evolução: mostra 2025 no período inteiro do filtro, como referência do que vem pela frente.
    let ultimo = '';
    for (const v of DATA.vendas) { const d = DATA.dias[v[1]]; if (d > ultimo) ultimo = d; }
    let fimCmp = ultimo && ultimo < state.fim ? ultimo : state.fim;
    if (fimCmp < state.ini) fimCmp = state.ini;
    const ini = isoAdd(state.ini, -DIAS_ANO), fim = isoAdd(fimCmp, -DIAS_ANO), fimGraf = isoAdd(state.fim, -DIAS_ANO);
    const inDay = AA.dias.map(d => d >= ini && d <= fim);
    const inGraf = AA.dias.map(d => d >= ini && d <= fimGraf);
    // Lojas em so_faturamento: em parte (ou em todo) o período de 2025 só há o faturamento diário do sistema
    // antigo, sem comandas (linhas com comandas = 0). Essas lojas são comparadas com 2026 só nas mesmas datas:
    // faturamento nos dias com dado em 2025; comandas, ticket médio e > R$ 250 nos dias com comandas em 2025.
    const soFat = AA.so_faturamento || {};
    const perLoja = DATA.lojas.map(l => ({
      fat: 0, com: 0, c250: 0, fatTm: 0, tem: false, soFat: soFat[l.codigo] || null, dias: new Set(), diasCom: new Set(),
    }));
    const perDia = new Map(); // data equivalente em 2026 -> totais de 2025
    for (const [li, di, fat, com, c250] of AA.vendas) {
      if (!state.lojas.has(li)) continue;
      const p = perLoja[li];
      p.tem = true; // a loja já existia no ano anterior
      if (inGraf[di]) {
        const k = isoAdd(AA.dias[di], DIAS_ANO);
        const q = perDia.get(k) || { fat: 0, com: 0, c250: 0 };
        q.fat += fat; q.com += com; q.c250 += c250;
        perDia.set(k, q);
      }
      if (!inDay[di]) continue;
      p.fat += fat; p.com += com; p.c250 += c250;
      if (com) p.fatTm += fat; // ticket médio só com faturamento que tem comandas
      const d26 = isoAdd(AA.dias[di], DIAS_ANO);
      p.dias.add(d26);
      if (com) p.diasCom.add(d26);
    }
    // 2026 nas mesmas datas que essas lojas têm em 2025
    perLoja.forEach(p => { p.cmp = p.soFat ? { fat: 0, fatC: 0, com: 0, c250: 0 } : null; });
    for (const [li, di, fat, com, c250] of DATA.vendas) {
      const p = perLoja[li];
      if (!p.cmp) continue;
      const d = DATA.dias[di];
      if (p.dias.has(d)) p.cmp.fat += fat;
      if (p.diasCom.has(d)) { p.cmp.fatC += fat; p.cmp.com += com; p.cmp.c250 += c250; }
    }
    perLoja.forEach(p => { if (p.cmp) p.cmp.tm = p.cmp.com ? p.cmp.fatC / p.cmp.com : 0; });
    const prodMap = new Map();
    for (const [li, di, pi, qt, vl] of AA.prod) {
      if (!inDay[di] || !state.lojas.has(li)) continue;
      const cur = prodMap.get(pi) || { q: 0, v: 0 };
      cur.q += qt; cur.v += vl;
      prodMap.set(pi, cur);
    }
    const tot = perLoja.reduce((a, p) => { a.fat += p.fat; a.com += p.com; a.c250 += p.c250; a.fatTm += p.fatTm; return a; }, { fat: 0, com: 0, c250: 0, fatTm: 0 });
    tot.tm = tot.com ? tot.fatTm / tot.com : 0;
    perLoja.forEach(p => { p.tm = p.com ? p.fatTm / p.com : 0; });
    return { perLoja, perDia, prodMap, tot, ini, fim, parcial: fimCmp < state.fim };
  }

  // variação % entre o valor atual e o do ano anterior, em HTML
  function delta(atual, anterior) {
    if (!anterior) return '<span class="delta na" title="Sem dados no mesmo período de 2025">—</span>';
    const v = atual / anterior - 1;
    const cls = Math.abs(v) < 0.005 ? 'zero' : v > 0 ? 'up' : 'down';
    const seta = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '';
    return `<span class="delta ${cls}">${seta} ${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>`;
  }
  function linhaAA(atual, anterior, fmt, aa) {
    const ate = aa.parcial ? ` (${fmtDate(aa.ini)} a ${fmtDate(aa.fim)})` : '';
    return `${delta(atual, anterior)}<span>vs ${fmt(anterior)} em 2025${ate}</span>`;
  }

  // copos entregues (item lançado no PDV) até a data final do filtro, contando desde o início da ação
  // (o estoque é da ação toda)
  function coposUsados(lojaFilter) {
    const fimIdx = DATA.dias.findIndex(d => d > state.fim);
    const lim = fimIdx < 0 ? DATA.dias.length : fimIdx;
    const out = new Map();
    for (const v of DATA.vendas) {
      if (v[1] >= lim) continue;
      if (lojaFilter && !lojaFilter.has(v[0])) continue;
      out.set(v[0], (out.get(v[0]) || 0) + (v[6] || 0));
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
    agg.aa = aggregateAA();
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

  function renderKpis({ tot, days, perLoja, aa }) {
    const usados = perLoja.filter(p => state.lojas.has(p.l.i)).reduce((a, p) => a + p.usados, 0);
    const nDays = days.length || 1;
    $('kCopos').textContent = int(tot.cop);
    $('kCoposC').textContent = `em ${int(tot.ccop)} comanda${tot.ccop === 1 ? '' : 's'}`;
    $('kCoposS').textContent = tot.copos ? `Estoque: ${int(usados)} de ${int(tot.copos)} (${pct(usados / tot.copos)}) · saldo ${int(Math.max(0, tot.copos - usados))}` : '—';
    setBar($('kCoposBar'), tot.copos ? usados / tot.copos : 0);
    $('kC250').textContent = int(tot.c250);
    $('kC250s').textContent = tot.com ? `${pct(tot.c250 / tot.com)} das comandas · ${brlShort(tot.fat250)}` : '—';
    $('kFat').textContent = brlShort(tot.fat);
    $('kFat').title = brl(tot.fat);
    $('kFatS').textContent = `média ${brlShort(tot.fat / nDays)} / dia`;
    $('kCom').textContent = int(tot.com);
    $('kComS').textContent = `média ${int(tot.com / nDays)} / dia`;
    $('kTm').textContent = brl(tot.com ? tot.fat / tot.com : 0);
    const tm = tot.com ? tot.fat / tot.com : 0;
    $('kC250AA').innerHTML = aa ? linhaAA(tot.c250, aa.tot.c250, int, aa) : '';
    $('kFatAA').innerHTML = aa ? linhaAA(tot.fat, aa.tot.fat, brlShort, aa) : '';
    $('kComAA').innerHTML = aa ? linhaAA(tot.com, aa.tot.com, int, aa) : '';
    $('kTmAA').innerHTML = aa ? linhaAA(tm, aa.tot.tm, brl, aa) : '';
  }

  let focoRetornoCopos = null;
  function abrirDetalheCopos(lojaId = null, origem = null) {
    const lojas = new Map(DATA.lojas.map((l, i) => [i, l]));
    const dias = new Map(DATA.dias.map((d, i) => [i, d]));
    const lojasFiltro = lojaId === null ? state.lojas : new Set([lojaId]);
    const rows = (DATA.comandas_copo || []).filter(([li, di]) =>
      lojasFiltro.has(li) && dias.has(di) && dias.get(di) >= state.ini && dias.get(di) <= state.fim
    ).sort((a, b) => b[3] - a[3] || b[1] - a[1]);
    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    $('coposModalTitle').textContent = lojaId === null ? 'Comandas com copo' : `Comandas com copo · ${lojas.get(lojaId)?.nome || 'Loja'}`;
    $('coposModalSummary').textContent = `${int(rows.length)} comandas · ${state.ini.split('-').reverse().join('/')} a ${state.fim.split('-').reverse().join('/')} · ${lojaId === null ? `${state.lojas.size} loja(s)` : 'loja selecionada'}`;
    $('coposModalRows').innerHTML = rows.map(([li, di, numero, valor, copos, choppQtd = 0, choppValor = 0]) => {
      const day = dias.get(di) || '';
      const cls = valor >= 500 ? 'cup-value-red' : valor > 250 ? 'cup-value-orange' : '';
      const data = day ? `${day.slice(8,10)}/${day.slice(5,7)}/${day.slice(0,4)}` : '—';
      return `<tr><td>${data}</td><td>${escape(lojas.get(li)?.nome || lojas.get(li)?.codigo || '—')}</td><td>${escape(numero)}</td><td class="num">${int(copos)}</td><td class="num ${cls}"><b>${brl(valor)}</b></td><td class="num">${int(choppQtd)}</td><td class="num">${brl(choppValor)}</td></tr>`;
    }).join('');
    $('coposModalEmpty').classList.toggle('hidden', rows.length > 0);
    focoRetornoCopos = origem || $('kCoposDrill');
    $('coposModal').classList.remove('hidden');
    $('coposModalClose').focus();
  }

  function fecharDetalheCopos() {
    $('coposModal').classList.add('hidden');
    (focoRetornoCopos || $('kCoposDrill')).focus();
  }

  function renderRanking({ perLoja, aa }) {
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
        <td class="num">${semItem(p) || `<button type="button" class="rank-copos-button" aria-label="Ver comandas com copo de ${p.l.nome}">${int(p.cop)}</button>`}</td>
        <td class="num">${semItem(p) ? '—' : int(p.ccop)}</td>
        <td><div class="pct-cell"><div class="mini-bar"><div style="width:${Math.min(100, p.pct * 100)}%;background:${color}"></div></div><span>${int(p.usados)}/${int(p.l.copos)}</span></div></td>
        <td class="num">${int(p.c250)}</td>
        <td class="num">${brlShort(p.fat)}</td>
        <td class="num">${vsAA(p, aa)}</td>
        <td class="num">${int(p.com)}</td>
        <td class="num">${brl(p.tm)}</td>
        <td class="num">${saldoTxt(p)}</td>`;
      tr.querySelector('.loja').textContent = p.l.nome;
      tr.querySelector('.loja').title = `${p.l.nome} – ${p.l.cidade}`;
      tr.addEventListener('click', () => focusLoja(p.l.i, true));
      const coposBtn = tr.querySelector('.rank-copos-button');
      if (coposBtn) coposBtn.addEventListener('click', e => { e.stopPropagation(); abrirDetalheCopos(p.l.i, coposBtn); });
      body.appendChild(tr);
    });
    if (!rows.length) body.innerHTML = '<tr><td colspan="11" class="muted">Nenhuma loja selecionada</td></tr>';
  }

  // variação do faturamento da loja vs 2025 (coluna do ranking)
  function vsAA(p, aa) {
    if (!aa) return '';
    const r = aa.perLoja[p.l.i];
    if (!r.tem) return '<span class="delta na" title="Loja sem dados no mesmo período de 2025">nova</span>';
    if (!r.soFat) return delta(p.fat, r.fat);
    if (!r.fat) return '<span class="delta na" title="Sem dados da loja nessas datas em 2025">—</span>';
    return `<span title="${notaSoFat(r)}">${delta(r.cmp.fat, r.fat)}*</span>`;
  }
  function notaSoFat(r) {
    return `2025: de ${fmtDate(r.soFat.de)} a ${fmtDate(r.soFat.ate)} só há o faturamento (sistema antigo, sem comandas); ` +
      'a loja é comparada com 2026 nas mesmas datas';
  }

  function saldoTxt(p) {
    if (semItem(p)) return '—';
    const s = (p.l.copos || 0) - p.usados;
    if (s >= 0) return int(s);
    return `<span class="esgotado" title="Copos lançados além do estoque enviado à loja">esgotado (${int(-s)} a mais)</span>`;
  }

  // lojas com PDV próprio (o item do copo não chega ao banco): sem contagem de copos
  function semItem(p) {
    return p.l.pdv_externo ? '<span class="delta na" title="Loja com PDV próprio: o item do copo não chega ao banco">PDV próprio</span>' : '';
  }

  function chartDefaults() {
    Chart.defaults.font.family = '"Basic Sans", "Nunito Sans", system-ui, sans-serif';
    Chart.defaults.color = cssVar('--muted');
    Chart.defaults.borderColor = cssVar('--grid');
  }

  function renderEvo({ days, aa }) {
    chartDefaults();
    const key = state.evo;
    const labels = days.map(d => fmtDate(d.d));
    const vals = days.map(d => d[key]);
    const color = key === 'cop' || key === 'c250' ? cssVar('--accent') : key === 'fat' ? cssVar('--accent-2') : cssVar('--accent-3');
    const fmt = key === 'fat' ? brlShort : int;
    const cfg = {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: '2026', data: vals, backgroundColor: color, borderRadius: 4, maxBarThickness: 26, order: 2 }]
          .concat(aa && key !== 'cop' ? [{
            type: 'line', label: '2025 (mesmas datas)', order: 1,
            data: days.map(d => (aa.perDia.get(d.d) || {})[key] || 0),
            borderColor: cssVar('--accent-3'), backgroundColor: cssVar('--accent-3'),
            borderWidth: 2, borderDash: [5, 4], pointRadius: 2, tension: 0.3,
          }] : []),
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: !!aa && key !== 'cop', position: 'top', align: 'end', labels: { boxWidth: 12, boxHeight: 12, usePointStyle: true } },
          tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${key === 'fat' ? brl(c.raw) : int(c.raw)}` } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
          y: { beginAtZero: true, ticks: { callback: v => fmt(v) } },
        },
      },
    };
    if (charts.evo) charts.evo.destroy();
    charts.evo = new Chart($('chEvo'), cfg);
  }

  function renderProd({ prodMap, aa }) {
    chartDefaults();
    const key = state.prod;
    const usarAA = state.prodAno === 'aa' && aa;
    const fonte = usarAA ? aa.prodMap : prodMap;
    const nomes = usarAA ? DATA.ano_anterior.produtos : DATA.produtos;
    $('prodAnoSeg').classList.toggle('hidden', !DATA.ano_anterior);
    const top = [...fonte.entries()]
      .map(([pi, o]) => ({ nome: nomes[pi], q: o.q, v: o.v }))
      .sort((a, b) => b[key] - a[key]).slice(0, 10);
    const cfg = {
      type: 'bar',
      data: {
        labels: top.map(t => t.nome.length > 24 ? t.nome.slice(0, 23) + '…' : t.nome),
        datasets: [{
          data: top.map(t => t[key]),
          backgroundColor: top.map((_, i) => usarAA ? cssVar('--accent-3') : i < 3 ? cssVar('--accent') : cssVar('--accent-2')),
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
      // o OSM bloqueia (403) tiles pedidos sem Referer; envia só a origem do site
      referrerPolicy: 'strict-origin-when-cross-origin',
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

  function renderMap({ perLoja, tot, aa }) {
    initMap();
    markersLayer.clearLayers();
    const sel = perLoja.filter(p => state.lojas.has(p.l.i) && p.l.lat);
    const max = Math.max(1, ...sel.map(p => p.cop));
    sel.sort((a, b) => b.cop - a.cop).forEach(p => {
      const r = 7 + Math.sqrt(p.cop / max) * 22;
      const color = p.pct >= .9 ? cssVar('--bad') : p.pct >= .6 ? cssVar('--warn') : cssVar('--ok');
      const focused = state.focus === p.l.i;
      const m = L.circleMarker([p.l.lat, p.l.lng], {
        radius: r, color: focused ? cssVar('--text') : '#fff', weight: focused ? 3 : 1.5,
        fillColor: color, fillOpacity: .85,
      });
      m.bindTooltip(`<div class="tt"><b></b>
        <div><span>Copos entregues</span><span>${p.l.pdv_externo ? 'PDV próprio' : int(p.cop)}</span></div>
        <div><span>Comandas com copo</span><span>${p.l.pdv_externo ? '—' : int(p.ccop)}</span></div>
        <div><span>Comandas &gt; R$250</span><span>${int(p.c250)}</span></div>
        <div><span>Faturamento</span><span>${brlShort(p.fat)}</span></div>
        <div><span>Ticket médio</span><span>${brl(p.tm)}</span></div>
        <div><span>Total comandas</span><span>${int(p.com)}</span></div>
        <div><span>Estoque usado</span><span>${int(p.usados)} / ${int(p.l.copos)}</span></div></div>`,
        { direction: 'top', offset: [0, -r] });
      m.on('tooltipopen', e => { e.tooltip.getElement().querySelector('b').textContent = p.l.nome; });
      m.on('click', () => focusLoja(p.l.i, false));
      markersLayer.addLayer(m);
      if (r > 14 && p.cop > 0) {
        markersLayer.addLayer(L.marker([p.l.lat, p.l.lng], {
          interactive: false,
          icon: L.divIcon({ className: 'map-label', html: int(p.cop), iconSize: [40, 14], iconAnchor: [20, 7] }),
        }));
      }
    });
    renderInsights(perLoja, tot, aa);
  }

  function renderInsights(perLoja, tot, aa) {
    const f = state.focus !== null ? perLoja[state.focus] : null;
    const ref = !aa ? null : f ? (aa.perLoja[f.l.i].tem ? aa.perLoja[f.l.i] : null) : aa.tot;
    const cur = f || { c250: tot.c250, fat: tot.fat, com: tot.com, tm: tot.com ? tot.fat / tot.com : 0 };
    const mini = (a, b, fmt) => !aa ? '' : !ref ? '<span class="delta na">loja nova (sem 2025)</span>' : `${delta(a, b)} <span>2025: ${fmt(b)}</span>`;
    if (ref && ref.soFat) {
      // loja com parte de 2025 só no sistema antigo: compara com 2026 nas mesmas datas
      const nota = notaSoFat(ref);
      const sem = `<span class="delta na" title="${nota}">sem comandas em 2025</span>`;
      const obsCom = `comandas desde ${fmtDate([...ref.diasCom].sort()[0])}`; // dd/mm é o mesmo nos dois anos
      const m = (a, b, fmt, obs) => `<span title="${nota}">${delta(a, b)} <span>2025: ${fmt(b)} · ${obs}</span></span>`;
      $('iFatAA').innerHTML = ref.fat ? m(ref.cmp.fat, ref.fat, brlShort, 'mesmas datas') : sem;
      if (ref.com) {
        $('iComAA').innerHTML = m(ref.cmp.com, ref.com, int, obsCom);
        $('iC250AA').innerHTML = m(ref.cmp.c250, ref.c250, int, obsCom);
        $('iTmAA').innerHTML = m(ref.cmp.tm, ref.tm, brl, obsCom);
      } else {
        $('iC250AA').innerHTML = sem; $('iTmAA').innerHTML = sem; $('iComAA').innerHTML = sem;
      }
    } else {
      $('iC250AA').innerHTML = mini(cur.c250, ref && ref.c250, int);
      $('iFatAA').innerHTML = mini(cur.fat, ref && ref.fat, brlShort);
      $('iTmAA').innerHTML = mini(cur.tm, ref && ref.tm, brl);
      $('iComAA').innerHTML = mini(cur.com, ref && ref.com, int);
    }
    let usados, copos;
    const alvo = f || tot;
    $('iCop').textContent = f && f.l.pdv_externo ? 'PDV próprio' : int(alvo.cop);
    $('iCcop').textContent = f && f.l.pdv_externo ? '—' : int(alvo.ccop);
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
    $('kCoposDrill').addEventListener('click', e => abrirDetalheCopos(null, e.currentTarget));
    $('kCoposDrill').addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrirDetalheCopos(); }
    });
    $('coposModalClose').addEventListener('click', fecharDetalheCopos);
    $('coposModal').addEventListener('click', e => { if (e.target.dataset.close) fecharDetalheCopos(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('coposModal').classList.contains('hidden')) fecharDetalheCopos(); });
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
    $('prodAnoSeg').addEventListener('click', e => segClick(e, 'prodAno'));
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
    setExecucao(null);
    render();
    carregarExecucao();
    setInterval(carregarExecucao, 5 * 60 * 1000); // revisa o status do servidor a cada 5 min
    // re-renderiza quando as fontes da marca terminam de carregar (gráficos medem os rótulos)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
    if (map) setTimeout(() => map.invalidateSize(), 50);
  }

  wire();
  checkSession().then(ok => ok ? boot() : showLogin());
})();
