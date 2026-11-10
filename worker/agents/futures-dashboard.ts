/** Read-only Futures Control page. The bearer token is typed by the operator, held in memory only and never stored. There is deliberately no order-placement control. */
export const FUTURES_PAGE_HTML = `<!doctype html>
<html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>ETI Futures Control (testnet)</title>
<style>
:root{--bg:#0e1116;--card:#161b22;--fg:#e6edf3;--mut:#8b949e;--bd:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--acc:#58a6ff}
@media(prefers-color-scheme:light){:root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--mut:#656d76;--bd:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--acc:#0969da}}
*{box-sizing:border-box}body{margin:0 auto;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;padding:12px;max-width:1100px}
h1{font-size:20px;margin:4px 0}h2{font-size:15px;margin:18px 0 8px}.mut{color:var(--mut)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
input,button{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:8px;font:inherit;min-height:40px}button{cursor:pointer}button:hover{border-color:var(--acc)}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mut);gap:2px}.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px;overflow-x:auto}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid var(--bd);font-size:12px}.ok{color:var(--ok);border-color:var(--ok)}.critical,.bad{color:var(--bad);border-color:var(--bad)}.warning{color:var(--warn);border-color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{border-bottom:1px solid var(--bd);padding:4px;text-align:left;vertical-align:top;word-break:break-word}ul{margin:4px 0;padding-left:18px}
</style></head><body>
<h1>ETI Futures Control <span class='badge warning'>TESTNET ONLY</span></h1>
<div class='mut'>Read-only. Values come from the live gateway. "Run monitor now" may place a protective STOP_MARKET for a position ETI opened; it never opens or closes positions. The token stays in this page's memory only.</div>
<h2>Access</h2><div class='row'><label>Execution token<input id='tok' type='password' autocomplete='off' size='28'></label><button id='load'>Load everything</button><span id='when' class='mut'></span></div>
<div id='err' class='card' style='display:none;border-color:var(--bad)'></div>
<h2>Gateway status</h2><div id='status' class='card mut'>Not loaded.</div>
<h2>Open positions &amp; liquidation risk</h2><div id='pos' class='card mut'>Not loaded.</div>
<h2>Protective-stop monitor</h2><div class='row'><button id='run'>Run monitor now</button><span class='mut'>A Cron Trigger also runs it every minute when futures are enabled.</span></div><div id='mon' class='card mut'>Not loaded.</div>
<h2>Reconciliation</h2><div id='rec' class='card mut'>Not loaded.</div>
<h2>Agent plan preview</h2><div class='row'><label>Symbol<input id='sym' value='BTCUSDT' size='10'></label><label>Interval<input id='iv' value='1h' size='5'></label><button id='plan'>Preview plan</button></div><div id='plan_out' class='card mut'>Not loaded.</div>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined&&x!==null)e.textContent=String(x);return e}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function fmt(v){if(typeof v==='number')return Number.isInteger(v)?String(v):String(Number(v.toPrecision(6)));return v===null||v===undefined?'-':String(v)}
function table(head,rows){var t=el('table'),h=el('tr');head.forEach(function(x){h.appendChild(el('th',null,x))});t.appendChild(h);rows.forEach(function(r){var tr=el('tr');r.forEach(function(c){var td=el('td');if(c&&c.nodeType){td.appendChild(c)}else{td.textContent=fmt(c)}tr.appendChild(td)});t.appendChild(tr)});return t}
function badge(t,c){return el('span','badge '+(c||''),t)}
function hdr(){return {authorization:'Bearer '+$('tok').value.trim()}}
function api(u,o){o=o||{};o.headers=Object.assign({},hdr(),o.headers||{});return fetch(u,o).then(function(r){return r.json().catch(function(){return {}}).then(function(j){j._status=r.status;return j})})}
function err(t){var e=$('err');e.style.display='block';e.textContent=t}
function show(id,node){var n=$(id);clear(n);n.className='card';n.appendChild(node)}
function authFail(j){if(j._status===401){err('Unauthorized: check the execution token.');return true}return false}
function status(){return fetch('/api/futures/status').then(function(r){return r.json()}).then(function(j){var rows=Object.keys(j).map(function(k){var v=j[k];return [k,typeof v==='boolean'?badge(String(v),v?'ok':'warning'):v]});show('status',table(['Setting','Value'],rows))})}
function positions(){return api('/api/futures/positions').then(function(j){if(authFail(j))return;if(j.error){err('Positions: '+j.error);return}if(!j.positions.length){show('pos',el('div','mut','No open futures positions.'));return}
show('pos',table(['Symbol','Dir','Size','Entry','Mark','Liq','Dist %','Lev','Margin','uPnL','Risk'],j.positions.map(function(p){return [p.symbol,p.direction,p.positionAmt,p.entryPrice,p.markPrice,p.liquidationPrice,p.liquidationDistancePct===null?null:Number(p.liquidationDistancePct.toFixed(1)),p.leverage,p.marginType,p.unrealizedPnl,badge(p.liquidationRisk,p.liquidationRisk==='critical'?'critical':p.liquidationRisk==='warning'?'warning':'ok')]})))})}
function renderMon(m){var n=el('div');n.appendChild(el('div','mut','Last run: '+m.at+(m.ran?'':' (did not run: '+(m.reason||'unknown')+')')));
if(m.alerts&&m.alerts.length){n.appendChild(table(['Level','Symbol','Code','Detail'],m.alerts.map(function(a){return [badge(a.level,a.level),a.symbol,a.code,a.detail]})))}else{n.appendChild(el('div','mut','No alerts.'))}
if(m.actions&&m.actions.length){n.appendChild(el('b',null,'Actions taken'));n.appendChild(table(['Symbol','Action','Stop','OK','Detail'],m.actions.map(function(a){return [a.symbol,a.action,a.stopPrice,a.ok?'yes':'NO',a.detail||'']})))}return n}
function monitor(){return api('/api/futures/monitor').then(function(j){if(authFail(j))return;if(j.error&&j._status!==404){err('Monitor: '+j.error);return}if(j._status===404){show('mon',el('div','mut','The monitor has not run yet.'));return}show('mon',renderMon(j))})}
function reconcile(){return api('/api/futures/reconcile').then(function(j){if(authFail(j))return;if(j.error){err('Reconcile: '+j.error);return}var n=el('div');n.appendChild(el('div',null,'Open orders: '+(j.openOrders===null?'unavailable':j.openOrders.length)));
n.appendChild(el('div',j.unauditedPositions&&j.unauditedPositions.length?'warning badge':'mut','Positions not opened through ETI: '+(j.unauditedPositions===null?'audit log unavailable':j.unauditedPositions.length?j.unauditedPositions.join(', '):'none')));show('rec',n)})}
function loadAll(){$('err').style.display='none';$('when').textContent='loaded '+new Date().toISOString();return status().then(positions).then(monitor).then(reconcile).catch(function(e){err('Request failed: '+e)})}
function runMon(){return api('/api/futures/monitor/run',{method:'POST'}).then(function(j){if(authFail(j))return;if(j.error){err('Monitor: '+j.error);return}show('mon',renderMon(j));return positions()}).catch(function(e){err('Request failed: '+e)})}
function plan(){var s=$('sym').value.trim().toUpperCase(),i=$('iv').value.trim();return api('/api/agents/futures/analyze?symbol='+encodeURIComponent(s)+'&interval='+encodeURIComponent(i)).then(function(j){if(authFail(j))return;if(j.error){err('Plan: '+j.error+(j.detail?' '+JSON.stringify(j.detail):''));return}var p=j.futuresPlan,n=el('div');
n.appendChild(el('div',null,'Action: '+p.action+(p.reduceOnly?' (reduce-only)':'')+' | eligible: '+p.eligible));
if(p.blockers.length){var u=el('ul');p.blockers.forEach(function(b){u.appendChild(el('li',null,b))});n.appendChild(el('b',null,'Blockers'));n.appendChild(u)}
if(p.warnings.length){var w=el('ul','mut');p.warnings.forEach(function(b){w.appendChild(el('li',null,b))});n.appendChild(w)}
if(p.costs){n.appendChild(el('div','mut','Estimated costs: fees $'+fmt(p.costs.feesUsd)+', slippage $'+fmt(p.costs.slippageUsd)+', funding $'+fmt(p.costs.fundingUsd)+' (assumptions, not account rates)'))}
if(p.liquidation){n.appendChild(el('div','mut','Liquidation est. '+fmt(p.liquidation.estimated)+' | exchange '+fmt(p.liquidation.exchangeReported)+' | stop '+fmt(p.liquidation.stop)))}
n.appendChild(el('div','mut','Commander: '+j.analysis.decision.action+' - '+j.analysis.decision.rationale[0]));show('plan_out',n)}).catch(function(e){err('Request failed: '+e)})}
$('load').onclick=loadAll;$('run').onclick=runMon;$('plan').onclick=plan;status();
})();
</script></body></html>`;
