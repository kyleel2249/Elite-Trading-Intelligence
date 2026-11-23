/* ETI 2D multi-market chart. Canvas 2D only; real ETI market data, with explicit stale/unavailable states. */
(function () {
  'use strict';
  var cv = document.getElementById('market2d-chart');
  if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d');
  var el = function (id) { return document.getElementById(id); };
  var INTERVAL_MS = { '1m': 6e4, '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
  var LIMIT = 60, REFRESH_MS = 30000;
  var LABEL = { bybit: 'Bybit', alpaca: 'Alpaca', oanda: 'OANDA', twelvedata: 'Twelve Data' };
  var DEFAULT_SYMBOL = { bybit: 'BTCUSDT', alpaca: 'AAPL', oanda: 'EUR_USD', twelvedata: 'SAP:XETR' };
  var SYM_RE = {
    bybit: /^[A-Z0-9]{3,20}$/, alpaca: /^[A-Z0-9.\-]{1,12}$/, oanda: /^[A-Z0-9_]{3,20}$/,
    twelvedata: /^([A-Z0-9.\-]{1,12}(:[A-Z0-9]{3,6})?|[A-Z]{3}\/[A-Z]{3})$/
  };
  var CRYPTO = { bybit: 1 };

  var S = { candles: [], status: 'loading', ws: null, wsPing: 0, wsRetry: 0, category: 'spot', zoom: 1, offset: 0, drag: null, req: 0, timer: 0, prov: 'bybit', symReq: 0, symTimer: 0 };

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
    var prov = el('prov').value, cat = el('category') ? el('category').value : 'spot', q = (el('sym').value || '').trim().toUpperCase(), my = ++S.symReq;
    var url = '/api/market/symbols?provider=' + encodeURIComponent(prov) + '&q=' + encodeURIComponent(q) + '&limit=40' + (refresh ? '&refresh=true' : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (my !== S.symReq) return;
        var dl = el('symlist'); dl.textContent = '';
        (j.items || []).filter(function (it) { return prov !== 'bybit' || !it.market || it.market === cat; }).forEach(function (it) {
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

  function closeBybitStream() {
    if (S.wsPing) clearInterval(S.wsPing);
    if (S.wsRetry) clearTimeout(S.wsRetry);
    S.wsPing = 0; S.wsRetry = 0;
    if (S.ws) { try { S.ws.close(); } catch (_) {} }
    S.ws = null;
  }
  function applyLivePrice(price, qty) {
    if (!finite(price) || price <= 0 || !S.candles.length) return;
    var last = S.candles[S.candles.length - 1], now = Date.now(), span = INTERVAL_MS[S.iv] || 60000;
    if (now > last.ct) {
      var openAt = Math.floor(now / span) * span;
      last = { o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price,
               v: 0, ct: openAt + span - 1, q: 'live' };
      S.candles.push(last);
      if (S.candles.length > LIMIT) S.candles.shift();
    } else {
      last.h = Math.max(last.h, price); last.l = Math.min(last.l, price); last.c = price; last.q = 'live';
    }
    if (finite(qty) && qty > 0) last.v += qty;
    S.status = 'live';
    setBanner('ok', 'Bybit live ' + S.category + ' feed · ' + S.sym + ' · ' + new Date().toISOString().slice(11, 19) + ' UTC.');
    table(); render();
  }
  function connectBybitStream(symbol, category) {
    closeBybitStream();
    if (!window.WebSocket) return;
    var host = 'wss://stream.bybit.com/v5/public/' + (category || 'spot');
    var ws;
    try { ws = new WebSocket(host); } catch (_) { return; }
    S.ws = ws;
    ws.onopen = function () {
      ws.send(JSON.stringify({ op: 'subscribe', args: ['tickers.' + symbol, 'publicTrade.' + symbol] }));
      S.wsPing = setInterval(function () {
        if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify({ op: 'ping' }));
      }, 20000);
    };
    ws.onmessage = function (event) {
      var msg; try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || !msg.topic || !msg.data) return;
      var rows = Array.isArray(msg.data) ? msg.data : [msg.data];
      rows.forEach(function (row) {
        if (msg.topic.indexOf('tickers.') === 0) applyLivePrice(+row.lastPrice, 0);
        else if (msg.topic.indexOf('publicTrade.') === 0) applyLivePrice(+row.p, +row.v);
      });
    };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
    ws.onclose = function () {
      if (S.wsPing) clearInterval(S.wsPing);
      S.wsPing = 0;
      if (S.ws === ws) {
        S.ws = null;
        S.wsRetry = setTimeout(function () {
          if (S.prov === 'bybit' && S.sym === symbol && S.category === category) connectBybitStream(symbol, category);
        }, 3000);
      }
    };
  }

  function load() {
    var prov = el('prov').value;
    var sym = (el('sym').value || '').trim().toUpperCase();
    var iv = el('int').value;
    var category = el('category') ? el('category').value : 'spot';
    var okSym = (SYM_RE[prov] || SYM_RE.bybit).test(sym);
    if (!okSym || !INTERVAL_MS[iv]) {
      S.candles = []; S.status = 'invalid';
      setBanner('bad', 'Enter a valid symbol such as ' + DEFAULT_SYMBOL[prov] + '.');
      render(); return;
    }
    var token = ++S.req;
    var url = '/api/market/public-history?provider=' + encodeURIComponent(prov) + '&symbol=' + encodeURIComponent(sym) +
              '&interval=' + encodeURIComponent(iv) + '&limit=' + LIMIT + (prov === 'bybit' ? '&category=' + encodeURIComponent(category) : '');
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
        S.candles = c.out; S.sym = sym; S.iv = iv; S.bad = c.bad; S.prov = prov; S.category = category; S.offset = 0;
        if (prov === 'bybit') connectBybitStream(sym, category); else closeBybitStream();
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

/* ---------- 2D candlestick + volume renderer ---------- */
  function render() {
    var r=cv.getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2),W=Math.max(320,r.width),H=Math.max(260,r.height);
    if(cv.width!==Math.round(W*dpr)||cv.height!==Math.round(H*dpr)){cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);}
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);ctx.fillStyle='#0a1220';ctx.fillRect(0,0,W,H);
    var all=S.candles,count=Math.max(12,Math.min(all.length,Math.round(all.length/(S.zoom||1)))),end=Math.max(0,all.length-(S.offset||0)),start=Math.max(0,end-count),cs=all.slice(start,end),n=cs.length;
    if(!n){ctx.fillStyle='#9cb2cc';ctx.font='14px system-ui,sans-serif';ctx.textAlign='center';ctx.fillText(S.status==='loading'?'Loading…':'No verified market data to display',W/2,H/2);return;}
    var lo=Infinity,hi=-Infinity,vmax=0;cs.forEach(function(k){lo=Math.min(lo,k.l);hi=Math.max(hi,k.h);vmax=Math.max(vmax,k.v);});
    if(hi<=lo){hi=lo*1.01;lo*=.99;}var span=hi-lo,left=76,right=14,top=20,bottom=42,plotW=W-left-right,plotH=H-top-bottom,priceH=plotH*.78,volH=plotH*.16,baseY=top+priceH;
    function y(p){return top+(hi-p)/span*priceH;}
    ctx.font='10px system-ui,sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';
    for(var g=0;g<=5;g++){var p=lo+span*g/5,yy=y(p);ctx.strokeStyle='rgba(56,189,248,.14)';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(W-right,yy);ctx.stroke();ctx.fillStyle='#9cb2cc';ctx.fillText(fmt(p),left-7,yy);}
    var step=plotW/n,cw=Math.max(2,Math.min(13,step*.68));
    cs.forEach(function(k,i){var x=left+i*step+step/2,up=k.c>=k.o,col=up?'#22c55e':'#ef4444';ctx.strokeStyle=col;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,y(k.h));ctx.lineTo(x,y(k.l));ctx.stroke();ctx.fillStyle=col;ctx.fillRect(x-cw/2,y(Math.max(k.o,k.c)),cw,Math.max(1,y(Math.min(k.o,k.c))-y(Math.max(k.o,k.c))));var vh=k.v/(vmax||1)*volH;ctx.globalAlpha=.5;ctx.fillRect(x-cw/2,baseY+volH-vh,cw,vh);ctx.globalAlpha=1;});
    ctx.strokeStyle='rgba(56,189,248,.25)';ctx.beginPath();ctx.moveTo(left,baseY);ctx.lineTo(W-right,baseY);ctx.stroke();
    ctx.fillStyle='#9cb2cc';ctx.textAlign='center';ctx.textBaseline='top';
    for(var t=0;t<=4;t++){var ix=Math.min(n-1,Math.round(t*(n-1)/4));ctx.fillText(new Date(cs[ix].ct).toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit'}),left+(ix+.5)*step,baseY+volH+7);}
    ctx.textAlign='right';ctx.fillStyle=S.status==='stale'?'#ef4444':'#9cb2cc';ctx.fillText((S.status==='stale'?'STALE · ':'')+(S.sym||'')+' '+(S.iv||''),W-right,top);
  }

  S.zoom=1;S.offset=0;S.drag=null;
  el('zoom-in').onclick=function(){S.zoom=Math.min(5,S.zoom*1.25);render();};
  el('zoom-out').onclick=function(){S.zoom=Math.max(1,S.zoom/1.25);render();};
  el('fit-chart').onclick=function(){S.zoom=1;S.offset=0;render();};
  cv.addEventListener('wheel',function(e){if(!e.shiftKey)return;e.preventDefault();S.offset=Math.max(0,Math.min(S.candles.length-10,(S.offset||0)+(e.deltaY>0?5:-5)));render();},{passive:false});
  cv.addEventListener('pointerdown',function(e){S.drag={x:e.clientX,offset:S.offset||0};try{cv.setPointerCapture(e.pointerId);}catch(_){}});
  cv.addEventListener('pointermove',function(e){if(!S.drag)return;var step=cv.clientWidth/Math.max(1,Math.round(S.candles.length/(S.zoom||1)));S.offset=Math.max(0,Math.min(S.candles.length-10,S.drag.offset-Math.round((e.clientX-S.drag.x)/Math.max(1,step))));render();});
  var endDrag=function(){S.drag=null;};cv.addEventListener('pointerup',endDrag);cv.addEventListener('pointercancel',endDrag);

  /* ---------- sizing + refresh ---------- */
  function resize() {
    var r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(Math.max(r.width,320) * dpr); cv.height = Math.round(Math.max(r.height,260) * dpr); render();
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv); else window.addEventListener('resize', resize);

  function schedule() {
    clearInterval(S.timer);
    S.timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) load();
  });

  window.addEventListener('beforeunload', closeBybitStream);
  resize(); searchSymbols(false); load(); schedule();
})();
