/**
 * ETI Pro dashboard (/pro): the neon "Elite Trading Intelligence" design, built only on real ETI endpoints.
 * Every number comes from a response the page just fetched (market candles, signal engine, readiness engine, daily report,
 * execution status). When a source fails the panel says so; no placeholder figures, balances, win rates or P/L are ever shown.
 * Account figures (balance, P/L, trades, journal) need the authenticated paper-account token and stay in the Command Centre.
 * NOTE: this HTML lives in a template literal. Keep the embedded script free of backticks, dollar-brace sequences and backslashes.
 */
const CSS = `
:root{color-scheme:dark;--bg:#020817;--b1:#00b8ff;--c1:#00e5ff;--ok:#00f59b;--bad:#ff365d;--warn:#ffc247;--txt:#eaf5ff;--mut:#91a9c4;--line:#11658d}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{background:radial-gradient(ellipse at 48% 0%,#09254a 0,#041329 38%,var(--bg) 78%);color:var(--txt);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}
a{color:var(--c1);text-decoration:none}button,select{font:inherit;color:var(--txt)}button{cursor:pointer}:focus-visible{outline:2px solid var(--c1);outline-offset:2px}
.top{position:fixed;inset:0 0 auto 0;height:64px;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px 0 240px;background:rgba(2,9,24,.88);backdrop-filter:blur(16px);border-bottom:1px solid #0a4164}
.claim{font-family:Orbitron,Inter,sans-serif;font-weight:800;letter-spacing:.8px;color:var(--ok);text-shadow:0 0 16px #00a86b;font-size:15px}
.pill{display:inline-flex;gap:7px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:4px 11px;font-size:12px;background:#06182d}.dot{width:9px;height:9px;border-radius:50%;background:var(--mut);display:inline-block}.dot.ok{background:var(--ok);box-shadow:0 0 10px var(--ok)}.dot.warn{background:var(--warn);box-shadow:0 0 10px var(--warn)}.dot.bad{background:var(--bad);box-shadow:0 0 10px var(--bad)}
.side{position:fixed;top:64px;bottom:0;left:0;width:220px;padding:16px 12px;background:linear-gradient(180deg,#04142b,#020a19);border-right:1px solid #07517b;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;padding:0 6px 16px;border-bottom:1px solid #12334e;margin-bottom:12px}.brand b{font-family:Orbitron,Inter,sans-serif;font-size:26px;letter-spacing:2px;color:#dff6ff;text-shadow:0 0 14px #08aaff}.brand small{display:block;font-size:8px;letter-spacing:1.4px;color:#a8c5df}
.side a{display:block;padding:10px 11px;margin:3px 0;border-radius:10px;color:#c4d8ef;border:1px solid transparent;font-size:13px}.side a:hover,.side a.on{background:linear-gradient(100deg,#07528b99,#06223e99);border-color:#168ed2;color:#fff}
.side h4{margin:14px 8px 4px;font-size:10px;letter-spacing:1.5px;color:var(--mut);text-transform:uppercase}
main{margin-left:220px;padding:80px 20px 40px;max-width:1700px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(12,minmax(0,1fr))}.c3{grid-column:span 3}.c4{grid-column:span 4}.c5{grid-column:span 5}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
.card{min-width:0;border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(145deg,rgba(7,28,50,.96),rgba(3,15,31,.97));box-shadow:inset 0 0 25px #0879a51b,0 0 18px #007db51b}
.card h3{margin:0 0 10px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px}.card h3 small{font-weight:400;color:var(--mut);font-size:11px}
.kpi small{display:block;color:var(--mut);font-size:11px}.kpi b{font-size:24px;letter-spacing:-.5px}
.up{color:var(--ok)}.dn{color:var(--bad)}.mut{color:var(--mut)}.warn{color:var(--warn)}
.seg{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.seg button,select{background:#081d37;border:1px solid #102f50;border-radius:8px;padding:6px 11px;font-size:12px}.seg button.on{background:#073b65;border-color:#23bfff;box-shadow:0 0 12px #008fff55}
.chart{height:300px;position:relative}canvas{width:100%;height:100%;display:block}
.err{color:var(--warn);border:1px dashed rgba(255,194,71,.6);border-radius:10px;padding:10px}.empty{color:var(--mut);border:1px dashed #1b4a6a;border-radius:10px;padding:10px}
.decision{font-size:30px;font-weight:800;letter-spacing:1px}.foot{margin-top:8px;font-size:11px;color:var(--mut)}
table{width:100%;border-collapse:collapse}th,td{padding:7px 5px;border-bottom:1px solid #153047;text-align:left;vertical-align:top;font-size:12px}th{color:var(--mut)}.scroll{overflow-x:auto}.scroll table{min-width:640px}
ul{margin:0;padding-left:18px}li{margin:3px 0;overflow-wrap:anywhere}
.btn{display:inline-block;background:linear-gradient(110deg,#00d88a,#00a96b);color:#00291e;border:1px solid #3dffb5;border-radius:10px;padding:8px 14px;font-weight:800;font-size:12px}
footer{margin-top:14px;border-top:1px solid #143a55;padding-top:10px;color:var(--mut);font-size:11px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media(max-width:1100px){.c3{grid-column:span 6}.c4,.c5,.c7,.c8{grid-column:span 12}}
@media(max-width:760px){.top{padding-left:12px}.claim{display:none}.side{position:static;width:auto;display:flex;gap:6px;overflow-x:auto;padding:8px;border-right:0;margin-top:64px}.side .brand,.side h4{display:none}.side a{white-space:nowrap}main{margin-left:0;padding-top:12px}.c3{grid-column:span 12}.chart{height:240px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const BODY = `
<header class="top"><div class="claim">Profitable. Disciplined. Intelligent.</div>
 <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="pill"><i class="dot" id="dm"></i><span id="tm">Market feed: checking</span></span><span class="pill"><i class="dot" id="de"></i><span id="te">Execution: checking</span></span><span class="pill" id="clock">--</span></div></header>
<nav class="side" aria-label="Primary">
 <div class="brand"><b>ETI</b><div><small>ELITE TRADING</small><small>INTELLIGENCE</small></div></div>
 <a class="on" href="/pro">Dashboard</a><a href="#p-signal">Trading Signal</a><a href="#p-ready">Market Readiness</a><a href="#p-daily">Daily Report</a><a href="#p-sys">System &amp; Execution</a>
 <h4>Other ETI pages</h4><a href="/command">Command Centre</a><a href="/daily">Daily Report (full)</a><a href="/alpha">Global Alpha</a><a href="/agents">AI Agents</a>
</nav>
<main>
 <div class="grid">
  <div class="card c3 kpi"><small id="k1l">Last price</small><b id="k1">--</b><div class="foot" id="k1s"></div></div>
  <div class="card c3 kpi"><small>24h change</small><b id="k2">--</b><div class="foot" id="k2s"></div></div>
  <div class="card c3 kpi"><small>ETI signal</small><b id="k3">--</b><div class="foot" id="k3s"></div></div>
  <div class="card c3 kpi"><small>Market readiness</small><b id="k4">--</b><div class="foot" id="k4s"></div></div>
  <section class="card c8"><h3>Market Overview <small id="mmeta"></small></h3><div class="seg"><select id="sym" aria-label="Instrument"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select><span id="tfs" class="seg"></span></div><div id="bm"><div class="chart"><canvas id="cv" aria-label="Candlestick chart"></canvas></div></div><div class="foot" id="fm"></div></section>
  <section class="card c4" id="p-signal"><h3>ETI Trade Signal</h3><div id="bs" class="mut">Loading…</div><div class="foot" id="fs"></div></section>
  <section class="card c5" id="p-ready"><h3>Market Readiness Engine</h3><div id="br" class="mut">Loading…</div><div class="foot" id="fr"></div></section>
  <section class="card c7" id="p-daily"><h3>ETI Daily Intelligence <small><a href="/daily">Open full report</a></small></h3><div id="bd" class="mut">Loading…</div><div class="foot" id="fd"></div></section>
  <section class="card c8" id="p-sys"><h3>System &amp; Execution <small>live checks</small></h3><div id="by" class="mut">Loading…</div></section>
  <section class="card c4"><h3>Paper account, trades, journal</h3><div class="empty">Balances, P/L, win rate and trade history need the authenticated paper-account token, so they are not shown here and no sample figures are used. Open the Command Centre to load them.</div><p><a class="btn" href="/command#trading">Open Command Centre</a></p></section>
 </div>
 <footer><span id="wd">Withdrawal permissions: checking</span><span>ETI Pro view · every figure is fetched live; research only, not investment advice</span></footer>
</main>
`;

const JS = `
var $=function(id){return document.getElementById(id)};
var S={symbol:'BTCUSDT',interval:'1h'};var TFS=['5m','15m','1h','4h','1d'];var INT={'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400};var CANDLES=null;
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function fmt(n,d){var x=Number(n);if(!isFinite(x))return '--';return x.toLocaleString(undefined,{maximumFractionDigits:d==null?4:d});}
function utc(){return new Date().toISOString().slice(0,19).replace('T',' ')+' UTC';}
function dot(id,c){$(id).className='dot '+c;}
function fail(id,msg){$(id).className='err';$(id).innerHTML='Unavailable: '+esc(msg);}
async function api(path){
 var t0=performance.now(),c=new AbortController(),tm=setTimeout(function(){c.abort();},30000);
 try{var r=await fetch(path,{cache:'no-store',signal:c.signal}),txt=await r.text(),j=null;try{j=JSON.parse(txt);}catch(e){}
  if(!r.ok)throw new Error(j&&(j.error||j.message||j.detail)?String(j.error||j.message||j.detail):'HTTP '+r.status);
  if(j===null)throw new Error('response was not JSON');return {data:j,ms:Math.round(performance.now()-t0),provider:r.headers.get('x-eti-provider')};}
 catch(e){if(e.name==='AbortError')throw new Error('timed out');throw e;}finally{clearTimeout(tm);}
}
function drawChart(c){
 var cv=$('cv');if(!cv||!c||!c.length)return;var dpr=window.devicePixelRatio||1,r=cv.getBoundingClientRect();cv.width=r.width*dpr;cv.height=r.height*dpr;var x=cv.getContext('2d');x.scale(dpr,dpr);var w=r.width,h=r.height;x.clearRect(0,0,w,h);
 var vh=h*0.18,ph=h-vh-14,hi=-Infinity,lo=Infinity,vm=0;c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3]);vm=Math.max(vm,k[5]);});var pad=(hi-lo)*0.08||1;hi+=pad;lo-=pad;
 var py=function(v){return 8+(hi-v)/(hi-lo)*ph;},bw=w/c.length;
 x.strokeStyle='rgba(23,51,75,.9)';x.lineWidth=1;for(var i=0;i<5;i++){var y=8+i*ph/4;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}
 c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#00f59b':'#ff365d',xx=i*bw+bw/2;x.strokeStyle=col;x.fillStyle=col;x.beginPath();x.moveTo(xx,py(k[2]));x.lineTo(xx,py(k[3]));x.stroke();var t=py(Math.max(k[1],k[4])),b=py(Math.min(k[1],k[4]));x.fillRect(xx-Math.max(1,bw*0.32),t,Math.max(2,bw*0.64),Math.max(1,b-t));x.globalAlpha=0.4;if(vm>0)x.fillRect(xx-Math.max(1,bw*0.32),h-(k[5]/vm)*vh,Math.max(2,bw*0.64),(k[5]/vm)*vh);x.globalAlpha=1;});
 function ema(a,p){var o=[],k=2/(p+1);a.forEach(function(v,i){o.push(i?v*k+o[i-1]*(1-k):v);});return o;}
 var cl=c.map(function(k){return k[4];});[[ema(cl,20),'#00e5ff'],[ema(cl,50),'#ffc247']].forEach(function(p){x.strokeStyle=p[1];x.lineWidth=1.5;x.beginPath();p[0].forEach(function(v,i){var xx=i*bw+bw/2;if(i)x.lineTo(xx,py(v));else x.moveTo(xx,py(v));});x.stroke();});
 x.fillStyle='#91a9c4';x.font='11px sans-serif';x.fillText(fmt(hi),4,12);x.fillText(fmt(lo),4,ph+6);x.fillStyle='#00e5ff';x.fillText('EMA20',w-110,12);x.fillStyle='#ffc247';x.fillText('EMA50',w-58,12);
}
async function loadMarket(){
 var q='symbol='+encodeURIComponent(S.symbol);var k;
 try{k=await api('/api/market/klines?'+q+'&interval='+encodeURIComponent(S.interval)+'&limit=120');}catch(e){dot('dm','bad');$('tm').textContent='Market feed: UNAVAILABLE';$('k1').textContent='--';$('k2').textContent='--';$('fm').textContent='Failed '+utc()+': '+e.message;return;}
 var rows=k.data;if(!Array.isArray(rows)||!rows.length){dot('dm','bad');$('tm').textContent='Market feed: no candles';return;}
 var c=rows.map(function(v){return v.map(Number);});CANDLES=c;drawChart(c);
 var last=c[c.length-1],age=Math.max(0,Math.round((Date.now()-last[0])/1000)),lim=(INT[S.interval]||3600)*3,stale=age>lim;
 $('k1l').textContent='Last price · '+S.symbol;$('k1').textContent=fmt(last[4]);$('k1s').textContent='Latest candle opened '+Math.round(age/60)+' min ago'+(stale?' · STALE':'');
 dot('dm',stale?'warn':'ok');$('tm').textContent=(stale?'Market feed: STALE':'Market feed: fresh')+(k.provider?' · '+k.provider:'');
 $('mmeta').textContent=k.provider?'via '+k.provider:'';$('fm').textContent='Updated '+utc()+' · '+k.ms+' ms'+(stale?' · Do not trade on stale data.':'');
 try{var t=await api('/api/market/ticker?'+q+'&provider='+encodeURIComponent(k.provider||''));var chg=Number(t.data.priceChangePercent);
  if(isFinite(chg)){$('k2').textContent=(chg>=0?'+':'')+chg.toFixed(2)+'%';$('k2').className=chg>=0?'up':'dn';$('k2s').textContent='24h, from the exchange ticker';}else{$('k2').textContent='--';$('k2s').textContent='Ticker did not report a 24h change';}}
 catch(e){$('k2').textContent='--';$('k2s').textContent='Ticker unavailable: '+e.message;}
}
async function loadSignal(){
 try{var r=await api('/api/signals?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval));var d=r.data,tr=d.tradeable===true,col=d.label==='BUY'?'up':'dn';
  $('k3').textContent=tr?d.label:'NO TRADE';$('k3').className=tr?col:'mut';$('k3s').textContent=S.symbol+' '+S.interval+' · '+d.conviction+' conviction';
  var h='<div class="decision '+(tr?col:'mut')+'">'+(tr?esc(d.label):'NO TRADE')+'</div>';
  if(!tr)h+='<div class="empty" style="margin:8px 0">The quality gate stands aside. Directional lean: <b class="'+col+'">'+esc(d.label)+'</b> at '+esc(d.conviction)+' conviction. Levels are reference only.</div>';
  h+='<table><tr><td>'+(tr?'Entry':'Reference entry')+'</td><td>'+fmt(d.entry)+'</td></tr><tr><td>Stop loss</td><td>'+fmt(d.stopLoss)+'</td></tr>'+(d.targets||[]).map(function(t){return '<tr><td>Take-profit '+esc(t.target)+' ('+esc(t.rewardRisk)+'R)</td><td>'+fmt(t.price)+'</td></tr>';}).join('')+'</table>';
  var v=d.historicalValidation||{};h+='<div class="foot">Confluence score '+esc(d.score)+' (heuristic, not a probability). Replay win rate: '+(v.winRate==null?'withheld (n='+esc(v.sampleCount)+', under 20)':esc(v.winRate)+'% (n='+esc(v.sampleCount)+')')+'. Excludes fees and slippage.</div>';
  $('bs').className='';$('bs').innerHTML=h;$('fs').textContent='Updated '+utc()+' · '+r.ms+' ms';}
 catch(e){$('k3').textContent='--';$('k3s').textContent='Signal unavailable';fail('bs',e.message);}
}
async function loadReady(){
 try{var r=await api('/api/readiness?market=crypto&symbol='+encodeURIComponent(S.symbol)+'&strategy=intraday&scope=now');var o=r.data.overall||{};
  $('k4').textContent=o.statusLabel||'--';$('k4s').textContent=(o.evaluated!=null?o.evaluated+' of 12 factors evaluated':'');
  var h='<div class="decision">'+esc(o.statusLabel||'unknown')+'</div><div class="mut" style="margin:6px 0">'+esc(o.recommendation||'')+'</div><ul>'+(o.reasons||[]).slice(0,6).map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';
  if(o.notEvaluated&&o.notEvaluated.length)h+='<div class="foot">Not evaluated: '+esc(o.notEvaluated.join('; '))+'</div>';
  $('br').className='';$('br').innerHTML=h;$('fr').textContent='Updated '+utc()+' · '+r.ms+' ms · a favourable rating is never an entry signal';}
 catch(e){$('k4').textContent='--';$('k4s').textContent='Readiness unavailable';fail('br',e.message);}
}
async function loadDaily(){
 try{var r=await api('/api/daily-report');var d=r.data;
  var h='<div class="decision">'+esc(d.finalVerdict.label)+'</div><div class="mut" style="margin:6px 0">'+esc(d.finalVerdict.summary)+'</div><div class="scroll"><table><tr><th>Asset</th><th>Direction</th><th>Setup</th><th>ETI verdict</th></tr>'+d.opportunities.map(function(o){var c=o.direction==='BUY'?'up':o.direction==='SELL'?'dn':'mut';return '<tr><td>'+esc(o.asset)+'</td><td class="'+c+'"><b>'+esc(o.direction)+'</b></td><td>'+esc(o.setup)+'</td><td>'+esc(o.verdict)+'</td></tr>';}).join('')+'</table></div>';
  $('bd').className='';$('bd').innerHTML=h;$('fd').textContent=d.dateTimeUtc+(d.cache?(d.cache.hit?' · cached '+d.cache.ageSeconds+' s':' · freshly generated'):'')+' · '+d.dataQuality.assets.filter(function(a){return a.status==='evaluated';}).length+' of '+d.dataQuality.assets.length+' assets fully evaluated';}
 catch(e){fail('bd',e.message);}
}
function row(name,state,detail){return '<tr><td><i class="dot '+state+'"></i></td><td>'+esc(name)+'</td><td class="mut">'+esc(detail)+'</td></tr>';}
async function loadSys(){
 var rs=await Promise.allSettled([api('/api/system/health'),api('/api/execution/status'),api('/api/readiness/status'),api('/api/daily-report/status')]);var h='<table>';
 var a=rs[0];h+=a.status==='fulfilled'?row('Cloudflare Worker','ok','status '+a.value.data.status+' · '+a.value.ms+' ms'):row('Cloudflare Worker','bad',a.reason.message);
 a=rs[1];
 if(a.status==='fulfilled'){var d=a.value.data;h+=row('Execution gateway',d.kill_switch?'bad':'ok','mode '+d.mode+' · live trading '+(d.live_trading_enabled?'ON':'off')+(d.kill_switch?' · KILL SWITCH ACTIVE':''));
  if(d.withdrawal_permissions===false){dot('de','ok');$('te').textContent='Execution: paper/testnet'+(d.live_trading_enabled?' · LIVE SWITCH ON':' · live disabled');$('wd').textContent='Withdrawal permissions: disabled';}
  else{dot('de','bad');$('te').textContent='Execution: withdrawals NOT confirmed disabled';$('wd').textContent='Withdrawal permissions: not confirmed disabled';}
  if(d.live_trading_enabled)dot('de','warn');}
 else{h+=row('Execution gateway','bad',a.reason.message);dot('de','bad');$('te').textContent='Execution status unavailable';$('wd').textContent='Withdrawal permissions: unverified';}
 a=rs[2];if(a.status==='fulfilled'){var m=a.value.data.markets||{};var ec=a.value.data.economicCalendar||{};
  [['Crypto price data',m.crypto],['Forex price data',m.forex],['Equities price data',m.equities]].forEach(function(p){var t=p[1]&&p[1].priceData;h+=row(p[0],String(t).indexOf('connected')===0?'ok':'warn',t);});
  h+=row('Economic calendar',ec.status==='loaded'?'ok':'warn',(ec.status||'unknown')+' · '+(ec.events==null?0:ec.events)+' events');}else h+=row('Readiness engine','bad',a.reason.message);
 a=rs[3];if(a.status==='fulfilled'){var s=a.value.data;h+=row('Daily report storage',s.schedule&&s.schedule.kv?'ok':'warn',s.inputs&&s.inputs.storage);}else h+=row('Daily report engine','bad',a.reason.message);
 h+='</table><div class="foot">Each row reflects a request made just now ('+esc(utc())+'). Amber means not configured or unverified; red means the check failed.</div>';
 $('by').className='';$('by').innerHTML=h;
}
function tfs(){$('tfs').innerHTML=TFS.map(function(t){return '<button data-tf="'+t+'" class="'+(t===S.interval?'on':'')+'">'+t+'</button>';}).join('');$('tfs').querySelectorAll('button').forEach(function(b){b.onclick=function(){S.interval=b.getAttribute('data-tf');tfs();loadMarket();loadSignal();};});}
$('sym').onchange=function(){S.symbol=$('sym').value;loadMarket();loadSignal();loadReady();};
window.addEventListener('resize',function(){if(CANDLES)drawChart(CANDLES);});
setInterval(function(){$('clock').textContent=utc();},1000);$('clock').textContent=utc();
setInterval(function(){if(document.visibilityState==='visible')loadMarket();},30000);
tfs();loadMarket();loadSignal();loadReady();loadDaily();loadSys();
`;

export function proPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#020817"><title>ETI Pro: Elite Trading Intelligence</title><link rel="preconnect" href="https://fonts.googleapis.com"><style>${CSS}</style></head><body>${BODY}<script>${JS}</script></body></html>`;
}
