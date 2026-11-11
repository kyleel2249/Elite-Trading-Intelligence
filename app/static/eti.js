/* ETI command-centre client. Renders only what the API returns; failures are shown, never replaced by sample data. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(v) { return v == null ? 'n/a' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function num(v, d) { return v == null ? 'n/a' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d == null ? 2 : d }); }
  function api(path) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 15000);
    return fetch(path, { signal: ctl.signal, headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(path + ' returned HTTP ' + r.status); return r.json(); }).finally(function () { clearTimeout(t); });
  }
  function fail(host, err) { host.replaceChildren(el('p', 'empty', 'Unavailable: ' + (err && err.message || err) + '. No substitute data is shown.')); }
  function kpi(label, value, cls, note) { var k = el('div', 'kpi'); k.appendChild(el('div', 'l', label)); k.appendChild(el('div', 'v ' + (cls || ''), value)); if (note) k.appendChild(el('div', 'n', note)); return k; }
  function table(cols, rows, emptyMsg) {
    if (!rows.length) return el('p', 'empty', emptyMsg);
    var t = el('table'), h = el('tr'); cols.forEach(function (c) { h.appendChild(el('th', '', c)); }); t.appendChild(h);
    rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (v) { var td = el('td'); if (v instanceof Node) td.appendChild(v); else td.textContent = v == null ? 'n/a' : String(v); tr.appendChild(td); }); t.appendChild(tr); });
    return t;
  }
  function drawCurve(points) {
    var c = $('curve'); if (!c) return; var g = c.getContext('2d'); c.width = c.clientWidth * (devicePixelRatio || 1); c.height = c.clientHeight * (devicePixelRatio || 1);
    g.clearRect(0, 0, c.width, c.height);
    if (!points || points.length < 2) { g.fillStyle = '#9aaac2'; g.font = (13 * (devicePixelRatio || 1)) + 'px sans-serif'; g.fillText('Not enough equity history to draw a curve yet.', 12, 28); return; }
    var ys = points.map(function (p) { return p.equity; }), lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), span = (hi - lo) || 1;
    g.strokeStyle = '#22d3ee'; g.lineWidth = 2 * (devicePixelRatio || 1); g.beginPath();
    points.forEach(function (p, i) { var x = i / (points.length - 1) * (c.width - 8) + 4, y = c.height - 8 - (p.equity - lo) / span * (c.height - 16); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke();
  }
  function loadTrading() {
    var rng = $('range').value, kp = $('kpis'), pf = $('perf');
    $('status').textContent = 'Loading…';
    api('/api/command/performance?range=' + encodeURIComponent(rng)).then(function (j) {
      var s = j.summary || {}, p = j.performance || {}, m = j.mode || {};
      $('mode').textContent = m.simulated ? 'SIMULATED paper account: not real funds' : 'Mode: ' + JSON.stringify(m);
      kp.replaceChildren(
        kpi('Equity', money(s.equity), '', 'start ' + money(s.starting_cash)),
        kpi('Total P&L', money(s.total_pnl), s.total_pnl > 0 ? 'pos' : s.total_pnl < 0 ? 'neg' : ''),
        kpi('Realized P&L', money(s.realized_pnl), s.realized_pnl > 0 ? 'pos' : s.realized_pnl < 0 ? 'neg' : ''),
        kpi('Unrealized P&L', money(s.unrealized_pnl)), kpi('Open orders', num(s.open_orders, 0)),
        kpi('Max drawdown', num(p.max_drawdown_pct) + '%'), kpi('Trading halted', s.halted ? 'YES' : 'No', s.halted ? 'neg' : ''));
      var rows = [['Closed trades', p.trades], ['Wins / losses (all shown)', p.wins + ' / ' + p.losses], ['Win rate', p.win_rate == null ? 'n/a' : num(p.win_rate * (p.win_rate <= 1 ? 100 : 1)) + '%'],
        ['Profit factor', p.profit_factor == null ? 'n/a (' + (p.profit_factor_note || '') + ')' : num(p.profit_factor)], ['Net realized P&L', money(p.net_realized_pnl)],
        ['Gross profit / loss', money(p.gross_profit) + ' / ' + money(p.gross_loss)], ['Fees paid', money(p.fees_paid)], ['Best / worst trade', JSON.stringify(p.best_trade) + ' / ' + JSON.stringify(p.worst_trade)],
        ['Sharpe / Sortino', p.sharpe == null ? (p.ratio_note || 'not computed') : num(p.sharpe) + ' / ' + num(p.sortino)]];
      pf.replaceChildren(table(['Metric', 'Value'], rows, 'No data'), el('p', 'note', p.basis || ''));
      drawCurve(p.equity_curve);
      var pos = s.positions || [];
      $('positions').replaceChildren(table(['Symbol', 'Qty', 'Avg cost', 'Market value'], pos.map(function (x) { return [x.symbol, num(x.quantity, 6), money(x.avg_cost || x.avg_price), money(x.market_value)]; }), 'No open positions.'));
      if ((s.marks_stale_for || []).length) $('status').textContent = 'Stale marks for: ' + s.marks_stale_for.join(', ') + ' (not shown as live)';
      else $('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }).catch(function (e) { fail(kp, e); fail(pf, e); $('status').textContent = 'Error'; });
  }
  function loadIntel() {
    api('/api/command/crawler').then(function (j) {
      var c = j.counts || {};
      $('kpis').replaceChildren(kpi('Agent state', String(j.state).toUpperCase()), kpi('Investor activities', num(c.investor_activities, 0)), kpi('Alerts', num(c.alerts_total, 0)), kpi('Predictions on record', num(c.predictions_total, 0)));
      $('agents').replaceChildren(table(['Agent', 'Responsibility', 'Health', 'Last run', 'Last error'],
        (j.agents || []).map(function (a) { var t = el('span', 'tag ' + (a.health === 'healthy' ? 'g' : a.last_error ? 'r' : 'y'), a.health); return [a.label, a.responsibility, t, a.last_run || 'never', a.last_error || '']; }), 'No agents reported.'));
      $('log').replaceChildren(table(['Time', 'Agent', 'Target', 'Result'], (j.activity_log || []).map(function (r) { return [r.ts || r.time, r.agent, r.target, r.result]; }), 'No recorded agent activity. Entries appear only for real runs.'));
    }).catch(function (e) { fail($('kpis'), e); fail($('agents'), e); fail($('log'), e); });
    api('/api/intelligence/traders').then(function (j) {
      var rows = (j.traders || j.results || j || []); if (!Array.isArray(rows)) rows = [];
      $('traders').replaceChildren(table(['Name', 'Role', 'Documented public mandate', 'Risk posture'], rows.slice(0, 40).map(function (t) { return [t.name, t.title, t.mandate, t.risk_posture]; }), 'No entries returned.'));
    }).catch(function (e) { fail($('traders'), e); });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    if (page === 'trading') { $('range').addEventListener('change', loadTrading); $('refresh').addEventListener('click', loadTrading); loadTrading(); setInterval(function () { if (!document.hidden) loadTrading(); }, 30000); addEventListener('resize', loadTrading); }
    if (page === 'intelligence') { $('refresh').addEventListener('click', loadIntel); loadIntel(); setInterval(function () { if (!document.hidden) loadIntel(); }, 60000); }
  });
})();
