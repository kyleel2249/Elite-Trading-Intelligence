/* ETI shared client library: safe DOM building, API client, dialogs, gauges, charts-lite, emergency controls. */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      n.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return n;
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }

  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const fmt = {
    usd: (x, d = 2) => fin(x) ? (x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '\u2014',
    signed: (x, d = 2) => fin(x) ? (x > 0 ? '+' : x < 0 ? '-' : '') + '$' + Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '\u2014',
    pct: (x, d = 1) => fin(x) ? x.toFixed(d) + '%' : '\u2014',
    num: (x, d = 2) => fin(x) ? x.toLocaleString(undefined, { maximumFractionDigits: d }) : '\u2014',
    dur: (s) => { if (!fin(s)) return '\u2014'; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.round(s)}s`; },
    time: (iso) => { const d = new Date(iso); return iso && !isNaN(d) ? d.toISOString().slice(0, 19).replace('T', ' ') + 'Z' : '\u2014'; },
    cls: (x) => (fin(x) ? (x > 0 ? 'pos' : x < 0 ? 'neg' : '') : 'muted'),
  };

  // ---- API client -------------------------------------------------------------------------------------------
  const KEY = 'eti_api_key';
  const apiKey = { get: () => localStorage.getItem(KEY) || '', set: (v) => (v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY)) };
  async function api(path, opts = {}) {
    const { method = 'GET', body, timeout = 45000 } = opts;
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (apiKey.get()) headers['X-API-Key'] = apiKey.get();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
      if (!r.ok) {
        let msg = r.status + ' ' + r.statusText;
        if (data && typeof data === 'object') msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
        else if (data) msg = String(data);
        if (r.status === 401 || r.status === 403) msg += ' (an API key may be required: set it with the key button)';
        const e = new Error(msg); e.status = r.status; e.data = data; throw e;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') { const t = new Error('Request timed out'); t.status = 0; throw t; }
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ---- feedback ---------------------------------------------------------------------------------------------
  function toast(msg, kind = '') {
    const box = $('#toasts'); if (!box) return;
    const t = el('div', { class: 'toast ' + kind, role: kind === 'bad' ? 'alert' : 'status', text: msg });
    box.append(t); setTimeout(() => t.remove(), 6500);
  }
  function modal(title, content, actions = [{ label: 'Close', value: 'close' }]) {
    const dlg = $('#dlg');
    return new Promise((resolve) => {
      dlg.replaceChildren(
        el('h2', { text: title }), el('div', {}, content),
        el('div', { class: 'dlg-actions' }, actions.map((a) => el('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: () => dlg.close(a.value ?? a.label) }, a.label)))
      );
      dlg.returnValue = '';
      dlg.onclose = () => resolve(dlg.returnValue);
      dlg.showModal();
    });
  }
  function confirmTyped(title, body, phrase) {
    const dlg = $('#dlg');
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', autocomplete: 'off', 'aria-label': 'Type ' + phrase + ' to confirm' });
      const go = el('button', { class: 'btn danger', type: 'button', disabled: true, onclick: () => dlg.close('yes') }, 'Confirm');
      input.addEventListener('input', () => { go.disabled = input.value.trim() !== phrase; });
      dlg.replaceChildren(el('h2', { text: title }), el('div', {}, body),
        el('label', {}, 'Type ', el('b', { text: phrase }), ' to confirm', input),
        el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close('no') }, 'Cancel'), go));
      dlg.returnValue = '';
      dlg.onclose = () => resolve(dlg.returnValue === 'yes');
      dlg.showModal(); input.focus();
    });
  }
  function prompt(title, label, value = '') {
    const dlg = $('#dlg');
    return new Promise((resolve) => {
      const input = el('input', { type: 'text', value, 'aria-label': label });
      const form = el('form', { onsubmit: (e) => { e.preventDefault(); dlg.close('ok'); } }, el('label', {}, label, input));
      dlg.replaceChildren(el('h2', { text: title }), form,
        el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', type: 'button', onclick: () => dlg.close('no') }, 'Cancel'),
          el('button', { class: 'btn primary', type: 'button', onclick: () => dlg.close('ok') }, 'OK')));
      dlg.returnValue = '';
      dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
      dlg.showModal(); input.focus(); input.select();
    });
  }
  async function busy(btn, fn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try { return await fn(); } catch (e) { toast(e.message || String(e), 'bad'); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }

  // ---- generic renderers (text only: never innerHTML) -------------------------------------------------------
  const isScalar = (v) => v == null || ['string', 'number', 'boolean'].includes(typeof v);
  function flat(obj, prefix = '', depth = 0, out = {}) {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? prefix + '.' + k : k;
      if (isScalar(v)) out[key] = v;
      else if (Array.isArray(v)) out[key] = v.every(isScalar) && v.length <= 6 ? v.join(', ') : `[${v.length} items]`;
      else if (depth < 1) flat(v, key, depth + 1, out);
      else out[key] = '{\u2026}';
    }
    return out;
  }
  function kv(obj) {
    const f = flat(obj); const dl = el('dl', { class: 'kv' });
    for (const [k, v] of Object.entries(f)) dl.append(el('dt', { text: k }), el('dd', { text: v == null ? '\u2014' : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : String(v) }));
    return Object.keys(f).length ? dl : unavailable('Nothing returned.');
  }
  function table(cols, rows, empty = 'Nothing to show yet.') {
    if (!rows || !rows.length) return el('div', { class: 'empty', text: empty });
    const t = el('table', {}, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c.label })))),
      el('tbody', {}, rows.map((r) => el('tr', {}, cols.map((c) => {
        const raw = typeof c.k === 'function' ? c.k(r) : r[c.k];
        const td = el('td', { class: c.wrap ? 'wrap' : '' });
        const val = c.fmt ? c.fmt(raw, r) : (raw == null ? '\u2014' : String(raw));
        td.append(val && val.nodeType ? val : document.createTextNode(val));
        const cl = c.cls ? c.cls(raw, r) : ''; if (cl) td.className += ' ' + cl;
        return td;
      })))));
    return el('div', { class: 'scroll' }, t);
  }
  function autoTable(rows, maxCols = 8) {
    const items = (rows || []).filter((r) => r && typeof r === 'object').map((r) => flat(r));
    if (!items.length) return el('div', { class: 'empty', text: 'Nothing to show yet.' });
    const cols = []; for (const it of items) for (const k of Object.keys(it)) if (!cols.includes(k) && cols.length < maxCols) cols.push(k);
    return table(cols.map((k) => ({ k: (r) => r[k], label: k.replace(/_/g, ' '), fmt: (v) => (typeof v === 'number' ? String(Math.round(v * 1e4) / 1e4) : v == null ? '\u2014' : String(v)) })), items);
  }
  function unavailable(msg, title) { return el('div', { class: 'unavail' }, title ? el('b', { text: title + ': ' }) : null, msg); }

  function gauge(value, { max = 100, color = '#00e676', label = '' } = {}) {
    const r = 52, len = Math.PI * r, p = fin(value) ? Math.max(0, Math.min(1, value / max)) : 0;
    const d = 'M18 78 A52 52 0 0 1 122 78';
    return svg('svg', { viewBox: '0 0 140 96', class: 'gauge', role: 'img', 'aria-label': `${label || 'gauge'}: ${fin(value) ? Math.round(value) : 'not evaluated'}` },
      svg('path', { d, fill: 'none', stroke: 'rgba(156,178,204,.25)', 'stroke-width': 12, 'stroke-linecap': 'round' }),
      svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': `${p * len} ${len}` }),
      svg('text', { x: 70, y: 64, 'text-anchor': 'middle', fill: '#f4f8ff', 'font-size': 26, 'font-weight': 700 }, fin(value) ? Math.round(value) : '\u2014'),
      svg('text', { x: 70, y: 84, 'text-anchor': 'middle', fill: '#9cb2cc', 'font-size': 10 }, label));
  }
  function area(values, { color = '#00e676', w = 600, h = 160, label = 'series' } = {}) {
    const v = (values || []).filter(fin);
    if (v.length < 2) return el('div', { class: 'empty', text: 'Not enough closed trades to draw a curve yet.' });
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, pad = 6;
    const pts = v.map((y, i) => [pad + (i / (v.length - 1)) * (w - 2 * pad), h - pad - ((y - lo) / span) * (h - 2 * pad)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const id = 'g' + Math.random().toString(36).slice(2, 8);
    return svg('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', height: h, role: 'img', 'aria-label': `${label}: from ${fmt.num(v[0])} to ${fmt.num(v[v.length - 1])}` },
      svg('defs', {}, svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': .45 }), svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }))),
      svg('path', { d: line + ` L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`, fill: `url(#${id})` }),
      svg('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2 }),
      svg('text', { x: 4, y: 12, fill: '#9cb2cc', 'font-size': 10 }, fmt.num(hi)), svg('text', { x: 4, y: h - 2, fill: '#9cb2cc', 'font-size': 10 }, fmt.num(lo)));
  }
  function poll(fn, ms) {
    let timer = null;
    const run = async () => { if (document.hidden) return; try { await fn(); } catch (e) { /* surfaced by fn */ } };
    run(); timer = setInterval(run, ms);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
    return () => clearInterval(timer);
  }
  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  const enc = encodeURIComponent;

  // ---- shared safety controls (available from both command centres) ------------------------------------------
  async function haltAll(reason) {
    const report = [];
    try {
      const accts = await api('/api/execution/accounts');
      if (!accts.length) report.push(['execution accounts', 'none registered, nothing to halt', 'info']);
      for (const a of accts) {
        try { await api(`/api/execution/accounts/${enc(a.account_id)}/halt?reason=${enc(reason)}`, { method: 'POST' }); report.push(['execution:' + a.account_id, 'halted (API confirmed)', 'ok']); }
        catch (e) { report.push(['execution:' + a.account_id, 'FAILED: ' + e.message, 'fail']); }
      }
    } catch (e) { report.push(['execution accounts', (e.status === 503 || e.status === 404 ? 'engine not available: ' : 'FAILED: ') + e.message, e.status === 503 || e.status === 404 ? 'info' : 'fail']); }
    return report;
  }
  function reportView(report) {
    return table([{ k: 0, label: 'Target' }, { k: 1, label: 'Outcome', wrap: true }, { k: 2, label: 'Result', fmt: (v) => el('span', { class: 'badge ' + (v === 'ok' ? 'good' : v === 'fail' ? 'bad' : ''), text: v }) }], report);
  }
  async function emergency() {
    const ok = await confirmTyped('EMERGENCY STOP', el('div', {}, el('p', { text: 'This will:' }),
      el('ul', {}, el('li', { text: 'halt every registered execution account (blocks new orders there)' }), el('li', { text: 'cancel all open INTERNAL PAPER orders' })),
      el('p', { class: 'muted', text: 'Open positions are not closed by this button (use CLOSE ALL POSITIONS). Each result below is what the server actually confirmed.' })), 'EMERGENCY STOP');
    if (!ok) return;
    const report = await haltAll('emergency stop from ETI command centre');
    try { const r = await api('/api/paper/orders/cancel-all?account_id=default', { method: 'POST' }); report.push(['paper orders', `cancelled ${r.canceled} open order(s)`, 'ok']); }
    catch (e) { report.push(['paper orders', 'FAILED: ' + e.message, 'fail']); }
    report.push(['paper kill switch', 'environment-controlled (KILL_SWITCH); not changed from the browser', 'info']);
    await modal('Emergency stop: actual outcome', reportView(report));
  }

  // ---- page shell -----------------------------------------------------------------------------------------
  function keyDialog() {
    const input = el('input', { type: 'password', value: apiKey.get(), autocomplete: 'off', 'aria-label': 'ETI API key' });
    modal('API key', el('div', {}, el('p', { class: 'muted', text: 'Stored only in this browser. Needed for actions that change state when the server enforces API_KEY. Exchange secrets are never entered here.' }), el('label', {}, 'X-API-Key', input)),
      [{ label: 'Clear', value: 'clear' }, { label: 'Save', value: 'save', kind: 'primary' }, { label: 'Cancel', value: 'cancel' }]).then((v) => {
      if (v === 'save') { apiKey.set(input.value.trim()); toast('API key saved in this browser', 'good'); } else if (v === 'clear') { apiKey.set(''); toast('API key cleared'); }
    });
  }
  function markActive() {
    const here = location.pathname + location.hash;
    $$('.nav-a').forEach((a) => {
      const h = a.getAttribute('href');
      a.classList.toggle('active', h === here || (!location.hash && h === location.pathname));
      if (h === here || (!location.hash && h === location.pathname)) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function init() {
    const shell = $('#shell');
    if (localStorage.getItem('eti_nav') === 'collapsed') shell.classList.add('collapsed');
    $('#collapse')?.addEventListener('click', () => { shell.classList.toggle('collapsed'); localStorage.setItem('eti_nav', shell.classList.contains('collapsed') ? 'collapsed' : 'open'); });
    $('#menu')?.addEventListener('click', () => { shell.classList.toggle('open'); $('#menu').setAttribute('aria-expanded', shell.classList.contains('open')); });
    $$('.nav-a').forEach((a) => a.addEventListener('click', () => shell.classList.remove('open')));
    window.addEventListener('hashchange', markActive); markActive();
    $('#btn-key')?.addEventListener('click', keyDialog);
    $('#btn-emergency')?.addEventListener('click', () => busy($('#btn-emergency'), emergency));
    const clock = $('#clock'); const tick = () => { if (clock) clock.textContent = new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'; };
    tick(); setInterval(tick, 1000);
    poll(async () => {
      const chip = $('#chip-sys'); if (!chip) return;
      try { const h = await api('/api/system/health', { timeout: 8000 }); chip.replaceChildren(el('span', { class: 'dot ok' }), 'API online v' + h.version); chip.dataset.live = String(!!h.live_trading_enabled); const cl = $('#chip-live'); if (cl) cl.replaceChildren(el('span', { class: 'dot ' + (h.live_trading_enabled ? 'warn' : '') }), h.live_trading_enabled ? 'Live flag: ENABLED' : 'Live trading: DISABLED'); }
      catch (e) { chip.replaceChildren(el('span', { class: 'dot bad' }), 'API unreachable'); }
    }, 30000);
  }

  window.ETI = { $, $$, el, svg, fmt, api, apiKey, toast, modal, confirmTyped, prompt, busy, kv, table, autoTable, unavailable, gauge, area, poll, download, enc, flat, haltAll, reportView, emergency, init };
  document.addEventListener('DOMContentLoaded', init);
})();
