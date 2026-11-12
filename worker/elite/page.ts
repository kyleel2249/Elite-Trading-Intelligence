/**
 * /elite: ETI Elite Trader Intelligence dashboard. Neon glass design from the supplied reference, wired to ETI's real endpoints.
 * Nothing on this page is a demo figure: every number comes from the Worker's APIs and shows "—" (with the reason) when a source is unavailable.
 * Paper/testnet only; the page can place no order. Rendered with textContent only (no HTML injection). No template interpolation in the script.
 */
import { withMotion } from "../ui/motion.ts";

const BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ETI Elite Trader Intelligence</title>
<style>
:root{--bg:#020817;--fg:#eaf5ff;--mut:#9eb7d0;--blue:#00b8ff;--cyan:#00e5ff;--ok:#00f59b;--bad:#ff365d;--warn:#ffc247;--line:#11658d}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px Inter,system-ui,Arial,sans-serif}
a{color:#36caff;text-decoration:none}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}.mut{color:var(--mut)}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 18px;background:rgba(2,9,24,.88);backdrop-filter:blur(14px);border-bottom:1px solid #0a4164}
.brand{font:800 22px Orbitron,Inter,sans-serif;letter-spacing:2px;color:#dff6ff;text-shadow:0 0 14px #08aaff}.brand small{display:block;font:600 8px Inter;letter-spacing:1.4px;color:#a8c5df;text-shadow:none}
.claim{flex:1;min-width:160px;color:var(--ok);font-weight:700;letter-spacing:.6px;text-shadow:0 0 16px #00a86b}
.pill{border:1px solid #145a55;background:#04231f;color:var(--ok);border-radius:20px;padding:6px 12px;font-size:11px;font-weight:700}.pill.off{border-color:#6b2a37;background:#2a1018;color:var(--bad)}
.seg{display:flex;border:1px solid #23517a;border-radius:20px;overflow:hidden}.seg button{background:#08172c;border:0;color:#a9c4df;padding:8px 14px;font:inherit;font-size:12px;cursor:pointer}.seg button.on{background:#073b65;color:#fff;box-shadow:inset 0 0 14px #008fff66}
.wrap{display:grid;grid-template-columns:210px minmax(0,1fr);gap:14px;max-width:1700px;margin:0 auto;padding:14px 18px 40px}
nav.side{position:sticky;top:70px;align-self:start;display:grid;gap:6px}nav.side a{display:block;padding:11px 12px;border:1px solid transparent;border-radius:11px;color:#c4d8ef;font-size:13px}
nav.side a:hover,nav.side a.cur{background:linear-gradient(100deg,#07528b99,#06223e99);border-color:#168ed2;color:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:12px}
.panel{border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(145deg,rgba(7,28,50,.9),rgba(3,15,31,.92));min-width:0}
.kpi .l{font-size:11px;color:#c5d8ec;font-weight:600}.kpi .v{font-size:24px;font-weight:800;margin-top:4px;letter-spacing:-.5px}.kpi .s{font-size:11px;color:var(--mut);margin-top:2px}
.g3{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr) minmax(0,.8fr);gap:12px;align-items:stretch}.g3b{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) minmax(0,.9fr);gap:12px;margin-top:12px}
h2{font-size:14px;margin:0 0 10px;font-weight:700;color:#edf7ff}h2 small{font-weight:400;color:var(--mut);margin-left:6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}select,button.b{background:#081d37;border:1px solid #23517a;color:#dbe9f7;border-radius:8px;padding:6px 10px;font:inherit;font-size:12px;cursor:pointer}button.b.on{background:#073b65;border-color:#23bfff}
canvas#ch{width:100%;height:260px;display:block}
.sig .t{font-size:17px;font-weight:900;text-shadow:0 0 14px currentColor;margin:4px 0 10px}.sig dl{display:grid;grid-template-columns:auto 1fr;gap:7px 10px;margin:0;font-size:12px}.sig dt{color:var(--mut)}.sig dd{margin:0;text-align:right;font-weight:600}
.meter{height:8px;background:#102f49;border-radius:9px;overflow:hidden;margin:8px 0}.meter i{display:block;height:100%;background:linear-gradient(90deg,#00aaff,#00f59b)}
ul.l{list-style:none;margin:0;padding:0;display:grid;gap:7px;font-size:12px}ul.l li{display:flex;gap:8px;align-items:baseline}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:7px 6px;border-bottom:1px solid #153047;white-space:nowrap}th{color:#91abc6}
.dock{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.dock a,.dock button{flex:1;min-width:130px;text-align:center;padding:16px 10px;border:1px solid #176da0;border-radius:13px;background:linear-gradient(135deg,#09284a,#07152b);color:#dbe9f7;font:inherit;font-size:12px;cursor:pointer}
.foot{margin-top:14px;color:#88a6c2;font-size:11px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
@media(max-width:1100px){.g3,.g3b{grid-template-columns:1fr 1fr}.g3>.panel:first-child{grid-column:1/-1}}
@media(max-width:760px){.wrap{grid-template-columns:1fr;padding:10px}nav.side{position:static;grid-auto-flow:column;overflow-x:auto}nav.side a{white-space:nowrap}.g3,.g3b{grid-template-columns:1fr}}
</style></head><body>
<header class="top"><div class="brand">ETI<small>ELITE TRADER INTELLIGENCE</small></div><div class="claim" id="claim">Profitable. Disciplined. Intelligent.</div>
<span class="pill" id="live">Checking…</span><span class="mut" id="clock"></span>
<div class="seg" role="tablist" aria-label="Mode"><button class="on" id="mT" role="tab" aria-selected="true">Pro Trader</button><button id="mI" role="tab" aria-selected="false">Intelligence</button></div></header>
<div class="wrap"><nav class="side" aria-label="Sections"><a class="cur" href="/elite">Dashboard</a><a href="/">Live Trading</a><a href="/journal">Trade Journal</a><a href="/daily">Daily Report</a><a href="/alpha">Global Alpha</a><a href="/command">Command Centre</a></nav>
<main id="trading"><p class="mut" id="msg" role="status">Loading…</p>
<div class="kpis" id="kpis"></div>
<div class="g3">
<section class="panel"><h2>Market Overview <small id="mprov"></small></h2><div class="row"><select id="sym" aria-label="Symbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select><span id="iv"></span><span class="mut" id="mlast"></span></div><canvas id="ch" role="img" aria-label="Price chart"></canvas></section>
<section class="panel sig"><h2>ETI Trade Signal <small>analysis only</small></h2><div class="t" id="sd">—</div><dl id="sl"></dl><div class="meter" aria-hidden="true"><i id="sc" style="width:0"></i></div><p class="mut" id="sn"></p></section>
<section class="panel"><h2>Trading Health</h2><ul class="l" id="hl"></ul></section>
</div>
<div class="g3b">
<section class="panel"><h2>Performance <small>closed trades, from the journal</small></h2><canvas id="eq" style="width:100%;height:150px;display:block" role="img" aria-label="Cumulative profit and loss"></canvas><ul class="l" id="pl"></ul></section>
<section class="panel"><h2>Recent Trades <small><a href="/journal">full journal</a></small></h2><div class="tw"><table><thead><tr><th>Asset</th><th>Status</th><th>Result</th><th>Net</th><th>Time</th></tr></thead><tbody id="rt"></tbody></table></div></section>
<section class="panel"><h2>ETI Journal Insights</h2><ul class="l" id="ji"></ul></section>
</div>
<div class="dock"><a href="/journal">Trade Journal</a><a href="/api/journal/export?format=csv">Export trades CSV</a><a href="/">Order ticket (paper)</a><a href="/api/algo/backtest">Backtest API</a></div>
</main>
<main id="intel" hidden><div class="kpis" id="ikpis"></div><div class="g3b"><section class="panel"><h2>Data-source health <small id="phint"></small></h2><ul class="l" id="prov"></ul></section>
<section class="panel"><h2>Intelligence tools</h2><ul class="l"><li><a href="/command">Command Centre</a><span class="mut">SEC filings, research, DEX and token security</span></li><li><a href="/alpha">Global Alpha</a><span class="mut">cross-market research layer</span></li><li><a href="/daily">Daily Report</a><span class="mut">stored daily intelligence report</span></li></ul></section>
<section class="panel"><h2>Execution safety</h2><ul class="l" id="exl"></ul></section></div></main>
</div>
<p class="foot" style="max-width:1700px;margin:0 auto;padding:0 18px 18px"><span>Paper/testnet only. Analytical record, not financial advice. Withdrawal permissions are never used.</span><span id="fresh"></span></p>
<script>
(function(){
function $(i){return document.getElementById(i)}
function el(t,x,c){var e=document.createElement(t);if(x!=null)e.textContent=String(x);if(c)e.className=c;return e}
function get(p){return fetch(p,{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok)throw new Error((d&&(d.message||d.error))||('HTTP '+r.status));return d})})}
function money(v){return v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2)}
function pct(v){return v==null?'—':(v*100).toFixed(1)+'%'}
function num(v,d){return v==null||!isFinite(v)?'—':Number(v).toFixed(d==null?2:d)}
function cls(v){return v==null?'':v>=0?'ok':'bad'}
var iv='15m',IV=['1m','5m','15m','1h','4h','1D'],stamp=0;
function kpi(root,l,v,s,c){var d=el('div',null,'panel kpi');d.appendChild(el('div',l,'l'));d.appendChild(el('div',v,'v '+(c||'')));if(s)d.appendChild(el('div',s,'s'));root.appendChild(d)}
function li(root,k,v,c){var x=el('li');x.appendChild(el('span',k,'mut'));x.appendChild(el('b',v,c||''));root.appendChild(x)}
function tick(){$('clock').textContent=new Date().toISOString().replace('T',' ').slice(0,19)+' UTC'}tick();setInterval(tick,1000);
// ---- journal-backed KPIs, performance, trades, insights
function journal(){
 return get('/api/journal/summary').then(function(d){
  var s=d.stats,p=s.performance,k=$('kpis');k.textContent='';
  kpi(k,'Net profit (closed)',money(p.closed?p.netPnl:null),p.closed+' closed trade(s)',p.closed?cls(p.netPnl):'');
  kpi(k,'Win rate',pct(p.winRate),p.closed?p.wins+' / '+p.closed+' trades':'no closed trades yet');
  kpi(k,'Profit factor',num(p.profitFactor),p.payoffRatio!=null?'payoff '+num(p.payoffRatio):'needs wins and losses');
  kpi(k,'Max drawdown',p.closed?'-$'+num(p.maxDrawdown):'—','on the closed-trade curve',p.closed?'bad':'');
  var pl=$('pl');pl.textContent='';li(pl,'Expectancy / trade',money(p.expectancy),cls(p.expectancy));li(pl,'Wins / losses',p.wins+' / '+p.losses);li(pl,'Fees',p.feesUnknownTrades?'some unknown':num(p.fees));
  if(s.dataQuality.sampleWarning){var w=el('li',s.dataQuality.sampleWarning,'warn');pl.appendChild(w)}
  var ji=$('ji');ji.textContent='';(d.insights||[]).slice(0,5).forEach(function(i){var x=el('li');x.appendChild(el('b',i.title+' ',i.severity==='action'?'warn':''));x.appendChild(el('span',i.detail,'mut'));ji.appendChild(x)});
  if(!(d.insights||[]).length)ji.appendChild(el('li','No insights yet.','mut'));
  var v=d.verification;var h=$('hl');h.textContent='';li(h,'Journal chain',(v.ok?'intact':'PROBLEM')+' ('+v.entries+' entries)',v.ok?'ok':'bad');
  li(h,'Orders refused by safeguards',s.orders.refused);li(h,'Broker rejected / unknown',s.orders.brokerRejected+' / '+s.orders.outcomeUnknown);li(h,'Prediction hit rate',s.predictions.evaluated?pct(s.predictions.hitRate)+' of '+s.predictions.evaluated:'none evaluated yet');
  $('msg').textContent='';stamp=Date.now();
  return get('/api/journal/trades?limit=200').then(function(t){
   var rows=t.trades,tb=$('rt');tb.textContent='';rows.slice(0,6).forEach(function(r){var tr=el('tr');[r.symbol||'',r.status,r.result||'',money(r.net),new Date(r.lastAt).toISOString().slice(5,16).replace('T',' ')].forEach(function(v,i){var td=el('td',v);if(i===3&&r.net!=null)td.className=cls(r.net);tr.appendChild(td)});tb.appendChild(tr)});
   if(!rows.length){var tr=el('tr');tr.appendChild(el('td','No trades recorded yet.','mut'));tb.appendChild(tr)}
   equity(rows.filter(function(r){return r.status==='closed'&&r.net!=null}).sort(function(a,b){return a.lastAt-b.lastAt}));
  });
 }).catch(function(e){$('msg').textContent='Journal unavailable: '+e.message;$('msg').className='warn'});
}
function equity(rows){
 var c=$('eq'),dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;var x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
 if(!rows.length){x.fillStyle='#9eb7d0';x.font='12px Inter,sans-serif';x.fillText('No closed trades yet. The curve appears after the first close.',8,h/2);return}
 var cum=0,pts=[0];rows.forEach(function(r){cum+=r.net;pts.push(cum)});var mn=Math.min.apply(null,pts),mx=Math.max.apply(null,pts);if(mx===mn){mx+=1;mn-=1}
 var X=function(i){return 6+i*(w-12)/Math.max(1,pts.length-1)},Y=function(v){return h-8-(v-mn)/(mx-mn)*(h-16)};
 x.strokeStyle='#17334b';x.beginPath();x.moveTo(0,Y(0));x.lineTo(w,Y(0));x.stroke();
 var g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,'rgba(0,245,155,.35)');g.addColorStop(1,'rgba(0,245,155,0)');
 x.beginPath();pts.forEach(function(v,i){i?x.lineTo(X(i),Y(v)):x.moveTo(X(i),Y(v))});x.strokeStyle='#00f59b';x.lineWidth=2;x.stroke();x.lineTo(X(pts.length-1),h);x.lineTo(X(0),h);x.closePath();x.fillStyle=g;x.fill();
}
// ---- market chart (real klines)
function market(){
 var s=$('sym').value;$('mlast').textContent='Loading…';
 return get('/api/market/klines?symbol='+encodeURIComponent(s)+'&interval='+iv+'&limit=120').then(function(d){
  var rows=d.data;if(!Array.isArray(rows)||!rows.length)throw new Error('no candles returned');
  $('mprov').textContent=d.provider?'source: '+d.provider:'';var last=rows[rows.length-1],first=rows[0];
  $('mlast').textContent='Last '+num(last[4],last[4]<10?4:2)+' ('+(((last[4]-first[4])/first[4])*100).toFixed(2)+'% over window) · candle '+new Date(last[0]).toISOString().slice(0,16).replace('T',' ')+' UTC';
  candles(rows);
 }).catch(function(e){$('mlast').textContent='Market data unavailable: '+e.message;candles([])});
}
function candles(rows){
 var c=$('ch'),dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*dpr;c.height=h*dpr;var x=c.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);if(!rows.length)return;
 var hi=-1e18,lo=1e18;rows.forEach(function(r){hi=Math.max(hi,r[2]);lo=Math.min(lo,r[3])});var Y=function(v){return 6+(hi-v)/(hi-lo||1)*(h-12)},cw=(w-50)/rows.length;
 x.strokeStyle='#17334b';x.fillStyle='#829bb6';x.font='10px Inter,sans-serif';for(var i=0;i<5;i++){var v=lo+(hi-lo)*i/4,y=Y(v);x.beginPath();x.moveTo(0,y);x.lineTo(w-44,y);x.stroke();x.fillText(v.toFixed(v<10?4:2),w-42,y+3)}
 rows.forEach(function(r,i){var xx=i*cw+cw/2,up=r[4]>=r[1];x.strokeStyle=x.fillStyle=up?'#00f59b':'#ff365d';x.beginPath();x.moveTo(xx,Y(r[2]));x.lineTo(xx,Y(r[3]));x.stroke();var t=Y(Math.max(r[1],r[4])),b=Y(Math.min(r[1],r[4]));x.fillRect(xx-cw*.35,t,cw*.7,Math.max(1,b-t))});
}
// ---- signal (analysis only; GET /api/omnisignal cannot place orders)
function signal(){
 $('sd').textContent='Analysing…';
 return get('/api/omnisignal?symbol='+encodeURIComponent($('sym').value)+'&strategy=intraday').then(function(d){
  var p=d.plan||d,dec=String(p.decision||d.decision||'UNAVAILABLE'),t=$('sd');t.textContent=dec==='BUY'?'BUY SETUP (analysis)':dec==='SELL'?'SELL SETUP (analysis, spot cannot short)':dec==='NO_TRADE'?'NO TRADE':dec.replace(/_/g,' ');t.className='t '+(dec==='BUY'?'ok':dec==='SELL'?'bad':'warn');
  var dl=$('sl');dl.textContent='';var rows=[['Asset',$('sym').value],['Entry zone',p.entryZone?num(p.entryZone[0])+' — '+num(p.entryZone[1]):'—'],['Stop-loss',p.stopLoss!=null?num(p.stopLoss):'—'],['Take-profit',(p.takeProfits&&p.takeProfits[0]&&p.takeProfits[0].price!=null)?num(p.takeProfits[0].price):'—'],['Evidence score',p.confidence!=null?num(p.confidence,0)+' / 100':'—']];
  rows.forEach(function(r){dl.appendChild(el('dt',r[0]));dl.appendChild(el('dd',r[1]))});$('sc').style.width=Math.max(0,Math.min(100,Number(p.confidence)||0))+'%';
  $('sn').textContent=(p.reasons&&p.reasons[0])?String(p.reasons[0]):(d.error||'')+' The score ranks setups; it is not a probability of profit.';
 }).catch(function(e){$('sd').textContent='Signal unavailable';$('sd').className='t warn';$('sl').textContent='';$('sn').textContent=e.message});
}
// ---- execution status + intelligence mode
function status(){
 return get('/api/execution/status').then(function(d){
  var kill=d.killSwitch!=null?d.killSwitch:d.kill_switch,l=$('live');l.textContent=kill?'KILL SWITCH ON':'PAPER / TESTNET';l.className='pill'+(kill?' off':'');
  var e=$('exl');e.textContent='';li(e,'Mode',String(d.mode||'paper_testnet_only'));li(e,'Kill switch',kill==null?'unknown':kill?'ACTIVE':'off',kill?'bad':'ok');li(e,'Live orders','disabled (HTTP 423)','ok');
 }).catch(function(){$('live').textContent='Status unavailable';$('live').className='pill off'});
}
function intel(){
 var k=$('ikpis');k.textContent='';
 return get('/api/providers/status').then(function(d){
  var items=Array.isArray(d)?d:(d.providers||d.data||d),list=$('prov');list.textContent='';var n=0,okn=0;
  (Array.isArray(items)?items:Object.keys(items||{}).map(function(k){var v=items[k];return typeof v==='object'?Object.assign({name:k},v):{name:k,ok:v}})).forEach(function(p){n++;var ok=p.ok!==false&&p.status!=='down'&&p.status!=='error'&&p.configured!==false;if(ok)okn++;li(list,p.name||p.id||'source',(p.status||(ok?'ok':'unavailable'))+(p.latencyMs?' · '+p.latencyMs+' ms':''),ok?'ok':'warn')});
  kpi(k,'Data sources',n?okn+' / '+n:'—','reporting healthy',okn===n&&n?'ok':'warn');$('phint').textContent='live from /api/providers/status';
 }).catch(function(e){kpi(k,'Data sources','—',e.message,'warn')});
}
// ---- wiring
var ivb=$('iv');IV.forEach(function(v){var b=el('button',v,'b'+(v===iv?' on':''));b.addEventListener('click',function(){iv=v;[].forEach.call(ivb.children,function(c){c.classList.toggle('on',c.textContent===v)});market()});ivb.appendChild(b)});
$('sym').addEventListener('change',function(){market();signal()});
function mode(t){$('trading').hidden=!t;$('intel').hidden=t;$('mT').classList.toggle('on',t);$('mI').classList.toggle('on',!t);$('mT').setAttribute('aria-selected',t);$('mI').setAttribute('aria-selected',!t);$('claim').textContent=t?'Profitable. Disciplined. Intelligent.':'Discover opportunities. Detect threats. Protect capital.';if(t)market();else intel()}
$('mT').addEventListener('click',function(){mode(true)});$('mI').addEventListener('click',function(){mode(false)});
window.addEventListener('resize',function(){market()});
status();journal();market();signal();
setInterval(function(){if(!document.hidden){status();journal();market()}},30000);
$('fresh').textContent='Auto-refresh every 30 s';
})();
</script></body></html>`;

export function elitePage(): string { return withMotion(BODY); }
