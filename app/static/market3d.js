/* ETI 3D market view.
 * Dependency-free canvas renderer with a manual 3D projection (works offline, no CDN, CSP-friendly).
 * Data comes only from the ETI API: candles via GET /api/market/public-history?provider=... (Binance, Bitget, Alpaca,
 * OANDA, Twelve Data); symbols are discovered with GET /api/market/symbols.
 * Nothing is generated or simulated: on any failure the view shows an "unavailable" state with the server's reason, and
 * stale data is labelled stale.
 */
(function () {
  'use strict';
  var cv = document.getElementById('m3d');
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var el = function (id) { return document.getElementById(id); };
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var INTERVAL_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
  var LIMIT = 60, REFRESH_MS = 30000;
  var DEFAULT_VIEW = { yaw: -0.6, pitch: 0.45, zoom: 1 };
  var LABEL = { binance: 'Binance', bitget: 'Bitget', alpaca: 'Alpaca', oanda: 'OANDA', twelvedata: 'Twelve Data' };
  var DEFAULT_SYMBOL = { binance: 'BTCUSDT', bitget: 'BTCUSDT', alpaca: 'AAPL', oanda: 'EUR_USD', twelvedata: 'SAP:XETR' };
  var SYM_RE = {
    binance: /^[A-Z0-9]{3,20}$/, bitget: /^[A-Z0-9]{3,20}$/, alpaca: /^[A-Z0-9.\-]{1,12}$/, oanda: /^[A-Z0-9_]{3,20}$/,
    twelvedata: /^([A-Z0-9.\-]{1,12}(:[A-Z0-9]{3,6})?|[A-Z]{3}\/[A-Z]{3})$/
  };
  var CRYPTO = { binance: 1, bitget: 1 };

  var S = { candles: [], status: 'loading', yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, zoom: 1,
            auto: false, drag: null, W: 300, H: 300, req: 0, timer: 0, raf: 0, prov: 'binance', symReq: 0, symTimer: 0 };

  function setBanner(kind, text) {
    var b = el('banner');
    b.className = 'banner' + (kind === 'ok' ? '' : ' bad');
    b.textContent = text;
  }
  function fmt(n) {
    var a = Math.abs(n);
    return n.toLocaleString(undefined, { maximumFractionDigits: a >= 100 ? 2 : a >= 1 ? 4 : 8 });
  }
  function finite(x) { return typeof x === 'number' && isFinite(x); }

  /* ---------- symbol discovery ---------- */
  function searchSymbols(refresh) {
    var prov = el('prov').value, q = (el('sym').value || '').trim().toUpperCase(), my = ++S.symReq;
    var url = '/api/market/symbols?provider=' + encodeURIComponent(prov) + '&q=' + encodeURIComponent(q) + '&limit=40' + (refresh ? '&refresh=true' : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (my !== S.symReq) return;
        var dl = el('symlist'); dl.textContent = '';
        (j.items || []).forEach(function (it) {
          var o = document.createElement('option'); o.value = it.symbol;
          var lab = it.name ? it.name : (it.base && it.quote ? it.base + '/' + it.quote : '');
          o.label = (it.is_new ? 'NEW · ' : '') + lab + (it.exchange && prov === 'twelvedata' ? ' (' + it.exchange + ')' : '');
          dl.appendChild(o);
        });
        var src = (j.sources || {})[prov] || {};
        var hint = el('symhint');
        if (src.status === 'not_configured' || src.status === 'unavailable') {
          hint.textContent = (src.message || 'Symbol list unavailable') + '. You can still type a symbol and press Load.';
        } else {
          hint.textContent = j.total + ' matching symbol' + (j.total === 1 ? '' : 's') + ' in ' + (src.count || 0) + ' listed' +
            (src.status === 'stale' ? ' (STALE list: ' + src.message + ')' : (src.message ? ' (' + src.message + ')' : '')) + '. Showing up to 40.';
        }
      })
      .catch(function () {
        if (my === S.symReq) el('symhint').textContent = 'Symbol search unavailable. You can still type a symbol and press Load.';
      });
  }
  function searchLater() { clearTimeout(S.symTimer); S.symTimer = setTimeout(function () { searchSymbols(false); }, 250); }

  /* ---------- data ---------- */
  function clean(rows) {
    var out = [], bad = 0;
    if (!Array.isArray(rows)) return { out: out, bad: 1 };
    rows.forEach(function (r) {
      var o = +r.open, h = +r.high, l = +r.low, c = +r.close, v = +r.volume;
      var ok = finite(o) && finite(h) && finite(l) && finite(c) && finite(v) && v >= 0 && l > 0 &&
               h >= Math.max(o, c) && l <= Math.min(o, c) && r.data_status !== 'invalid';
      if (!ok) { bad++; return; }
      out.push({ o: o, h: h, l: l, c: c, v: v, ct: +r.close_time, q: r.data_status || 'unknown' });
    });
    return { out: out, bad: bad };
  }

  function load() {
    var prov = el('prov').value;
    var sym = (el('sym').value || '').trim().toUpperCase();
    var iv = el('int').value;
    var okSym = (SYM_RE[prov] || SYM_RE.binance).test(sym);
    if (!okSym || !INTERVAL_MS[iv]) {
      S.candles = []; S.status = 'invalid';
      setBanner('bad', 'Enter a valid symbol such as ' + DEFAULT_SYMBOL[prov] + '.');
      render(); return;
    }
    var token = ++S.req;
    var url = '/api/market/public-history?provider=' + encodeURIComponent(prov) + '&symbol=' + encodeURIComponent(sym) +
              '&interval=' + encodeURIComponent(iv) + '&limit=' + LIMIT;
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.ok) return r.json();
        return r.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(typeof j.detail === 'string' ? j.detail : (r.status === 404 ? 'unknown symbol' : 'HTTP ' + r.status));
        });
      })
      .then(function (rows) {
        if (token !== S.req) return; // a newer request superseded this one
        var c = clean(rows);
        if (c.out.length < 5) throw new Error('too few valid candles (' + c.out.length + ')');
        S.candles = c.out; S.sym = sym; S.iv = iv; S.bad = c.bad; S.prov = prov;
        var last = c.out[c.out.length - 1];
        var lag = Date.now() - last.ct; // >0 means the newest candle already closed
        var stale = lag > INTERVAL_MS[iv] * 1.5;
        S.status = stale ? 'stale' : 'live';
        setBanner(stale ? 'bad' : 'ok',
          stale ? 'STALE: newest candle for ' + sym + ' closed ' + Math.round(lag / 60000) + ' min ago' + (CRYPTO[prov] ? '' : ' (the market may be closed)') + '. Do not treat as live.'
                : 'Showing ' + c.out.length + ' ' + iv + ' candles for ' + sym + ' (' + LABEL[prov] + ', via ETI). Updated ' + new Date().toISOString().slice(11, 19) + ' UTC.' +
                  (c.bad ? ' ' + c.bad + ' invalid candle(s) excluded.' : ''));
        table(); render();
      })
      .catch(function (e) {
        if (token !== S.req) return;
        S.candles = []; S.status = 'unavailable';
        setBanner('bad', 'Market data unavailable for ' + sym + ' (' + e.message + '). No chart is shown rather than showing unverified data.');
        table(); render();
      });
  }

  function table() {
    var tb = el('rows'); tb.textContent = '';
    var rows = S.candles.slice(-8).reverse();
    if (!rows.length) {
      var tr0 = document.createElement('tr'), td0 = document.createElement('td');
      td0.colSpan = 7; td0.className = 'empty'; td0.textContent = 'No data available';
      tr0.appendChild(td0); tb.appendChild(tr0); el('meta').textContent = ''; return;
    }
    rows.forEach(function (k) {
      var tr = document.createElement('tr');
      [new Date(k.ct).toISOString().replace('T', ' ').slice(0, 19), fmt(k.o), fmt(k.h), fmt(k.l), fmt(k.c), fmt(k.v), k.q]
        .forEach(function (t) { var td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    el('meta').textContent = S.sym + ' ' + S.iv + ' | ' + S.candles.length + ' candles';
  }

  /* ---------- projection ---------- */
  function proj(x, y, z, n) {
    var cy = Math.cos(S.yaw), sy = Math.sin(S.yaw), cp = Math.cos(S.pitch), sp = Math.sin(S.pitch);
    var x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    var y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    var D = n * 2.2, dist = D / S.zoom;
    var F = D * S.W / (n * 1.25);
    var d = Math.max(dist + z2, 0.1), s = F / d;
    return { x: S.W / 2 + x1 * s, y: S.H / 2 - y2 * s, z: z2 };
  }

  function shade(hex, f) {
    var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return 'rgb(' + Math.round(r * f) + ',' + Math.round(g * f) + ',' + Math.round(b * f) + ')';
  }

  // faces: [vertex indices, brightness]
  var FACES = [[[0, 1, 2, 3], 0.55], [[4, 5, 6, 7], 0.75], [[0, 1, 5, 4], 0.4], [[2, 3, 7, 6], 1.0], [[0, 3, 7, 4], 0.62], [[1, 2, 6, 5], 0.62]];

  function pushBox(items, cx, cy, cz, w, h, d, hex, n) {
    var x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    var V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
      .map(function (p) { return proj(p[0], p[1], p[2], n); });
    FACES.forEach(function (f) {
      var pts = f[0].map(function (i) { return V[i]; });
      var z = (pts[0].z + pts[1].z + pts[2].z + pts[3].z) / 4;
      items.push({ z: z, draw: function () {
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath(); ctx.fillStyle = shade(hex, f[1]); ctx.fill();
        ctx.strokeStyle = 'rgba(7,11,18,.55)'; ctx.lineWidth = 0.6; ctx.stroke();
      } });
    });
  }

  /* ---------- render ---------- */
  function render() {
    var W = S.W, H = S.H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a1220'; ctx.fillRect(0, 0, W, H);
    var cs = S.candles, n = cs.length;
    if (!n) {
      ctx.fillStyle = '#9aaac2'; ctx.font = '14px system-ui,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(S.status === 'loading' ? 'Loading…' : 'No verified market data to display', W / 2, H / 2);
      return;
    }
    var lo = Infinity, hi = -Infinity, vmax = 0;
    cs.forEach(function (k) { if (k.l < lo) lo = k.l; if (k.h > hi) hi = k.h; if (k.v > vmax) vmax = k.v; });
    var span = hi - lo || hi * 0.01 || 1;
    var YS = n * 0.5, VS = n * 0.16, floor = -YS / 2;
    var py = function (p) { return (p - lo) / span * YS - YS / 2; };
    var items = [];

    // floor outline + price grid on the left wall
    var fx = n / 2 + 0.5, fz0 = -1.2, fz1 = 4.2;
    var corners = [[-fx, floor, fz0], [fx, floor, fz0], [fx, floor, fz1], [-fx, floor, fz1]].map(function (p) { return proj(p[0], p[1], p[2], n); });
    ctx.strokeStyle = 'rgba(56,189,248,.25)'; ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (var i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = '#9aaac2'; ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'left';
    for (var g = 0; g <= 4; g++) {
      var price = lo + span * g / 4, a = proj(-fx, py(price), fz0, n), b = proj(-fx, py(price), fz1, n);
      ctx.strokeStyle = 'rgba(56,189,248,.12)'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillText(fmt(price), Math.max(4, Math.min(W - 70, a.x + 4)), a.y - 3);
    }

    cs.forEach(function (k, i) {
      var x = i - (n - 1) / 2, up = k.c >= k.o, hex = up ? '#22c55e' : '#ef4444';
      var top = py(Math.max(k.o, k.c)), bot = py(Math.min(k.o, k.c));
      var bh = Math.max(bot === top ? YS * 0.004 : top - bot, YS * 0.004);
      pushBox(items, x, (top + bot) / 2, 0, 0.7, bh, 0.7, hex, n);
      // wick as a thin line
      var w0 = proj(x, py(k.l), 0, n), w1 = proj(x, py(k.h), 0, n);
      items.push({ z: (w0.z + w1.z) / 2, draw: function () {
        ctx.strokeStyle = shade(hex, 0.9); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(w0.x, w0.y); ctx.lineTo(w1.x, w1.y); ctx.stroke();
      } });
      // volume bar in the front row
      var vh = Math.max(k.v / (vmax || 1) * VS, VS * 0.01);
      pushBox(items, x, floor + vh / 2, 3, 0.7, vh, 0.9, '#3b82f6', n);
    });

    items.sort(function (a, b) { return b.z - a.z; }); // far to near
    items.forEach(function (it) { it.draw(); });

    ctx.fillStyle = S.status === 'stale' ? '#ef4444' : '#9aaac2'; ctx.font = '11px system-ui,sans-serif'; ctx.textAlign = 'right';
    ctx.fillText((S.status === 'stale' ? 'STALE ' : '') + S.sym + ' ' + S.iv, W - 8, H - 8);
  }

  /* ---------- interaction ---------- */
  function clampPitch() { S.pitch = Math.max(-0.2, Math.min(1.3, S.pitch)); }
  function clampZoom() { S.zoom = Math.max(0.5, Math.min(3, S.zoom)); }
  function nudge(dy, dp, dz) { S.yaw += dy; S.pitch += dp; S.zoom *= dz; clampPitch(); clampZoom(); render(); }

  cv.addEventListener('pointerdown', function (e) {
    S.drag = { x: e.clientX, y: e.clientY };
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  });
  cv.addEventListener('pointermove', function (e) {
    if (!S.drag) return;
    S.yaw += (e.clientX - S.drag.x) * 0.01;
    S.pitch += (e.clientY - S.drag.y) * 0.008;
    S.drag = { x: e.clientX, y: e.clientY };
    clampPitch(); render();
  });
  var endDrag = function () { S.drag = null; };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return; // plain scroll keeps scrolling the page
    e.preventDefault(); nudge(0, 0, e.deltaY < 0 ? 1.08 : 0.92);
  }, { passive: false });
  cv.addEventListener('keydown', function (e) {
    var k = e.key, handled = true;
    if (k === 'ArrowLeft') nudge(-0.1, 0, 1);
    else if (k === 'ArrowRight') nudge(0.1, 0, 1);
    else if (k === 'ArrowUp') nudge(0, 0.08, 1);
    else if (k === 'ArrowDown') nudge(0, -0.08, 1);
    else if (k === '+' || k === '=') nudge(0, 0, 1.1);
    else if (k === '-') nudge(0, 0, 0.9);
    else handled = false;
    if (handled) e.preventDefault();
  });

  el('rl').onclick = function () { nudge(-0.15, 0, 1); };
  el('rr').onclick = function () { nudge(0.15, 0, 1); };
  el('tu').onclick = function () { nudge(0, 0.1, 1); };
  el('td').onclick = function () { nudge(0, -0.1, 1); };
  el('zi').onclick = function () { nudge(0, 0, 1.15); };
  el('zo').onclick = function () { nudge(0, 0, 0.87); };
  el('rst').onclick = function () { S.yaw = DEFAULT_VIEW.yaw; S.pitch = DEFAULT_VIEW.pitch; S.zoom = 1; render(); };
  el('go').onclick = load;
  el('reload').onclick = function () { searchSymbols(true); };
  el('sym').addEventListener('keydown', function (e) { if (e.key === 'Enter') { load(); } });
  el('sym').addEventListener('input', searchLater);
  el('sym').addEventListener('change', load);   // picking an item from the suggestion list loads it
  el('int').addEventListener('change', load);
  el('prov').addEventListener('change', function () {
    el('sym').value = DEFAULT_SYMBOL[el('prov').value];
    searchSymbols(false); load();
  });

  var autoBtn = el('auto');
  if (reduced) { autoBtn.disabled = true; autoBtn.title = 'Disabled: reduced-motion preference'; }
  autoBtn.onclick = function () {
    S.auto = !S.auto; autoBtn.setAttribute('aria-pressed', String(S.auto));
    if (S.auto) spin(); else cancelAnimationFrame(S.raf);
  };
  function spin() {
    if (!S.auto || document.hidden) return;
    S.yaw += 0.004; render(); S.raf = requestAnimationFrame(spin);
  }

  /* ---------- sizing + refresh ---------- */
  function resize() {
    var r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.W = Math.max(r.width, 200); S.H = Math.max(r.height, 200);
    cv.width = Math.round(S.W * dpr); cv.height = Math.round(S.H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); render();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);

  function schedule() {
    clearInterval(S.timer);
    S.timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { load(); if (S.auto) spin(); }
  });

  resize(); searchSymbols(false); load(); schedule();
})();
