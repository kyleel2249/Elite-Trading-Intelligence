/* ETI futures calculator UI. All maths runs on the server (/api/futures-calc/preview, Decimal arithmetic);
 * this page only collects inputs and displays the result. It never submits orders. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PRESETS = [1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 125, 150];
  var timer = 0, seq = 0;

  function val(id) { var v = $(id).value.trim(); return v === '' ? null : v; }
  function intVal(id) { var v = val(id); return v === null ? null : parseInt(v, 10); }

  function payload() {
    var tp = val('tp');
    var p = {
      direction: $('direction').value, contract_type: $('contract_type').value, margin_mode: $('margin_mode').value,
      capital: val('capital'), entry_price: val('entry_price'), leverage: intVal('leverage'),
      taker_fee_bps: val('fee') || '5', slippage_bps: val('slip') || '5',
      funding_rate_pct: val('fr') || '0', funding_intervals: val('fi') || '0',
      limits: {}
    };
    if (val('move_pct') !== null) p.move_pct = val('move_pct');
    if (val('stop_price') !== null) p.stop_price = val('stop_price');
    if (tp !== null) p.take_profit_prices = [tp];
    if (val('mmr') !== null) p.maintenance_margin_pct = val('mmr');
    if (val('bal') !== null) p.available_balance = val('bal');
    if (intVal('exmax') !== null) p.limits.exchange_max_leverage = intVal('exmax');
    return p;
  }

  function banner(bad, text) { var b = $('banner'); b.className = 'banner' + (bad ? ' bad' : ''); b.textContent = text; }
  function cls(v) { return typeof v === 'string' && v.charAt(0) === '-' ? 'neg' : 'pos'; }

  function kpi(label, value, note, klass) {
    var d = document.createElement('div'); d.className = 'kpi';
    var l = document.createElement('div'); l.className = 'l'; l.textContent = label;
    var v = document.createElement('div'); v.className = 'v' + (klass ? ' ' + klass : ''); v.textContent = value === null || value === undefined ? 'n/a' : value;
    d.appendChild(l); d.appendChild(v);
    if (note) { var n = document.createElement('div'); n.className = 'n'; n.textContent = note; d.appendChild(n); }
    return d;
  }

  function render(r) {
    var k = $('kpis'); k.textContent = '';
    var s = r.sizing, t = r.target, liq = r.liquidation;
    k.appendChild(kpi('Capital', s.capital + ' ' + r.instrument.settle_currency));
    k.appendChild(kpi('Initial margin', s.initial_margin, 'after quantity rounding'));
    k.appendChild(kpi('Notional', s.notional + ' ' + s.notional_currency, s.leverage + 'x'));
    k.appendChild(kpi('Quantity', s.quantity, 'contracts / units'));
    if (t) {
      k.appendChild(kpi('Gross P&L', t.gross_pnl, 'at ' + t.price, cls(t.gross_pnl)));
      k.appendChild(kpi('Net P&L', t.net_pnl, 'costs ' + t.total_costs, cls(t.net_pnl)));
      k.appendChild(kpi('Return on margin', t.return_on_margin_pct + '%', 'gross ' + t.gross_return_on_margin_pct + '%', cls(t.return_on_margin_pct)));
    }
    k.appendChild(kpi('Liquidation (estimate)', liq.price, liq.price ? liq.distance_pct_from_entry + '% from entry' : (liq.reason || liq.status), 'neg'));
    k.appendChild(kpi('Risk class', r.risk['class'].toUpperCase(), 'max ' + s.effective_max_leverage + 'x (' + s.effective_max_leverage_source + ')'));
    if (r.risk_reward) k.appendChild(kpi('Risk / reward', r.risk_reward.gross, 'net ' + (r.risk_reward.net_of_costs || 'n/a')));
    if (r.balance) k.appendChild(kpi('Balance after', r.balance.available_after, 'needs ' + r.balance.required_margin_plus_entry_fee));

    var c = $('checks'); c.textContent = '';
    function list(title, items, klass) {
      if (!items.length) return;
      var h = document.createElement('div'); h.className = 'tag ' + klass; h.textContent = title; c.appendChild(h);
      var ul = document.createElement('ul'); ul.className = 'v';
      items.forEach(function (i) { var li = document.createElement('li'); li.textContent = i.message; ul.appendChild(li); });
      c.appendChild(ul);
    }
    list('BLOCKING', r.violations, 'r');
    list('WARNINGS', r.risk.warnings, 'y');
    if (!r.violations.length && !r.risk.warnings.length) c.textContent = 'No rule violations or warnings.';

    var tb = $('rows'); tb.textContent = '';
    r.scenarios.forEach(function (x) {
      var tr = document.createElement('tr');
      var sign = x.side === 'favourable' ? '+' : '-';
      [sign + x.movement_pct + '%', x.price, x.gross_pnl, x.net_pnl, x.return_on_margin_pct + '%', x.liquidated ? 'LIQUIDATED (est.)' : x.side]
        .forEach(function (txt, i) {
          var td = document.createElement('td'); td.textContent = txt;
          if (i >= 2 && i <= 4) td.className = cls(String(txt));
          tr.appendChild(td);
        });
      tb.appendChild(tr);
    });
    banner(!r.valid, r.valid ? 'Calculation OK. This is a calculator; nothing was sent to an exchange.' : 'This configuration breaks one or more rules (see Rule check). It should not be submitted.');
  }

  function run() {
    var my = ++seq;
    fetch('/api/futures-calc/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (my !== seq) return;
        if (!o.ok) {
          var d = o.j && o.j.detail; $('kpis').textContent = ''; $('rows').textContent = ''; $('checks').textContent = '';
          banner(true, typeof d === 'string' ? d : 'Check your inputs: ' + (Array.isArray(d) && d[0] ? d[0].msg : 'invalid'));
          return;
        }
        render(o.j);
      })
      .catch(function () { if (my === seq) banner(true, 'Calculator unavailable (network or server error). No figures shown.'); });
  }
  function later() { clearTimeout(timer); timer = setTimeout(run, 200); }

  function setLev(n) {
    n = Math.max(1, Math.min(150, n | 0));
    $('leverage').value = n; $('levr').value = n; markChips(); later();
  }
  function markChips() {
    var n = intVal('leverage');
    Array.prototype.forEach.call($('chips').children, function (b) { b.className = (+b.dataset.n === n) ? 'btn on' : 'btn'; });
  }
  PRESETS.forEach(function (n) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.dataset.n = n; b.textContent = n + 'x';
    b.onclick = function () { setLev(n); }; $('chips').appendChild(b);
  });
  $('levr').addEventListener('input', function () { setLev(+$('levr').value); });
  $('leverage').addEventListener('input', function () { var n = intVal('leverage'); if (n) { $('levr').value = Math.max(1, Math.min(150, n)); markChips(); } later(); });
  ['direction', 'contract_type', 'margin_mode', 'capital', 'entry_price', 'move_pct', 'stop_price', 'tp', 'exmax', 'mmr', 'fee', 'slip', 'fr', 'fi', 'bal']
    .forEach(function (id) { $(id).addEventListener('input', later); $(id).addEventListener('change', later); });
  markChips(); run();
})();
