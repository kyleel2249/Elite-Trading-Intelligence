/**
 * ETI Pro dashboard (/pro): the neon "Elite Trading Intelligence" design, built only on real ETI endpoints.
 * Every number comes from a response the page just fetched (exchange candles, signal engine, SMC engine, agent council, readiness engine,
 * daily report, execution status, read-only Bybit account snapshot). When a source fails the panel says so; no placeholder figures,
 * balances, win rates or P/L are ever shown.
 * Exchange selection mirrors /terminal: Bybit goes through the Worker (venue/market/category), Bitget uses the browser-direct
 * connector (/bitget-client.js) because Bitget restricts Cloudflare egress. The chart, ETIAlgo signal, SMC and FVG all use the same
 * venue, market, symbol and timeframe, and a response from another provider is flagged instead of being shown as the selected venue.
 * Nothing on this page can place, amend or cancel an order. Private account data needs the ETI execution token typed by the operator.
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
main{margin-left:max(220px,calc((100vw - 1920px)/2 + 220px));margin-right:0;padding:80px 24px 40px;width:min(1700px,calc(100vw - 220px));max-width:1700px;box-sizing:border-box}.side{left:max(0px,calc((100vw - 1920px)/2))}
.grid{display:grid;gap:12px;grid-template-columns:repeat(12,minmax(0,1fr))}.c3{grid-column:span 3}.c4{grid-column:span 4}.c5{grid-column:span 5}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
.card{min-width:0;border:1px solid var(--line);border-radius:16px;padding:14px;background:linear-gradient(145deg,rgba(7,28,50,.96),rgba(3,15,31,.97));box-shadow:inset 0 0 25px #0879a51b,0 0 18px #007db51b}
.card h3{margin:0 0 10px;font-size:14px;display:flex;justify-content:space-between;align-items:center;gap:8px}.card h3 small{font-weight:400;color:var(--mut);font-size:11px}
.kpi small{display:block;color:var(--mut);font-size:11px}.kpi b{font-size:24px;letter-spacing:-.5px}
.up{color:var(--ok)}.dn{color:var(--bad)}.mut{color:var(--mut)}.warn{color:var(--warn)}
.seg{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}.seg button,select{background:#081d37;border:1px solid #102f50;border-radius:8px;padding:6px 11px;font-size:12px}.seg button.on{background:#073b65;border-color:#23bfff;box-shadow:0 0 12px #008fff55}
.tok{background:#081d37;border:1px solid #102f50;border-radius:8px;padding:6px 11px;font:inherit;font-size:12px;color:var(--txt);min-width:240px}
.badge{display:inline-block;border:1px solid var(--line);border-radius:6px;padding:1px 8px;font-size:11px}
.chart{height:680px;min-height:560px;position:relative;width:100%;overflow:hidden;border:1px solid #123b5b;border-radius:12px;background:#000000}.pro-advanced-chart{background:#000000;border-color:#123b5b;padding:0;overflow:hidden}.pro-advanced-chart>*{margin-left:14px;margin-right:14px}.pro-advanced-chart>:first-child{margin-top:14px}.pro-advanced-chart>#bm{margin:0}.pro-advanced-chart #bm>:not(.chart){margin-left:14px;margin-right:14px}.pro-advanced-chart>:last-child{margin-bottom:14px}.pro-advanced-chart .chart{border:0;border-radius:0}canvas{width:100%;height:100%;min-height:100%;display:block}
.err{color:var(--warn);border:1px dashed rgba(255,194,71,.6);border-radius:10px;padding:10px}.empty{color:var(--mut);border:1px dashed #1b4a6a;border-radius:10px;padding:10px}
.decision{font-size:30px;font-weight:800;letter-spacing:1px}.foot{margin-top:8px;font-size:11px;color:var(--mut)}
table{width:100%;border-collapse:collapse}th,td{padding:7px 5px;border-bottom:1px solid #153047;text-align:left;vertical-align:top;font-size:12px}th{color:var(--mut)}.scroll{overflow-x:auto}.scroll table{min-width:640px}
ul{margin:0;padding-left:18px}li{margin:3px 0;overflow-wrap:anywhere}
.btn{display:inline-block;background:linear-gradient(110deg,#00d88a,#00a96b);color:#00291e;border:1px solid #3dffb5;border-radius:10px;padding:8px 14px;font-weight:800;font-size:12px}
footer{margin-top:14px;border-top:1px solid #143a55;padding-top:10px;color:var(--mut);font-size:11px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media(max-width:1100px){.c3{grid-column:span 6}.c4,.c5,.c7,.c8{grid-column:span 12}.chart{height:620px;min-height:520px}}
@media(max-width:760px){.top{padding-left:12px}.claim{display:none}.side{position:static;width:auto;display:flex;gap:6px;overflow-x:auto;padding:8px;border-right:0;margin-top:64px}.side .brand,.side h4{display:none}.side a{white-space:nowrap}main{margin-left:0;margin-right:0;padding:12px 16px 32px;width:100%;max-width:none}.c3{grid-column:span 12}.chart{height:460px;min-height:400px}.tok{min-width:0;width:100%}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const BODY = `
<header class="top"><div class="claim">Profitable. Disciplined. Intelligent.</div>
 <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="pill" id="tv">Venue: BYBIT · futures</span><span class="pill"><i class="dot" id="dm"></i><span id="tm">Market feed: checking</span></span><span class="pill"><i class="dot" id="de"></i><span id="te">Execution: checking</span></span><span class="pill" id="clock">--</span></div></header>
<nav class="side" aria-label="Primary">
 <div class="brand"><b>ETI</b><div><small>ELITE TRADING</small><small>INTELLIGENCE</small></div></div>
 <a class="on" href="/pro">Dashboard</a><a href="#p-signal">Trading Signal</a><a href="#p-struct">Structure &amp; FVG</a><a href="#p-agents">AI Agents</a><a href="#p-ready">Market Readiness</a><a href="#p-daily">Daily Report</a><a href="#p-sys">System &amp; Execution</a><a href="#p-acct">Exchange Accounts</a>
 <h4>Other ETI pages</h4><a href="/">Full ETI Dashboard</a><a href="/terminal">Trading Terminal</a><a href="/command">Command Centre</a><a href="/daily">Daily Report (full)</a><a href="/alpha">Global Alpha</a><a href="/agents">AI Agents (full)</a>
</nav>
<main>
 <div class="grid">
  <div class="card c3 kpi"><small id="k1l">Last price</small><b id="k1">--</b><div class="foot" id="k1s"></div></div>
  <div class="card c3 kpi"><small>24h change</small><b id="k2">--</b><div class="foot" id="k2s"></div></div>
  <div class="card c3 kpi"><small>ETI signal</small><b id="k3">--</b><div class="foot" id="k3s"></div></div>
  <div class="card c3 kpi"><small>Market readiness</small><b id="k4">--</b><div class="foot" id="k4s"></div></div>
  <section class="card c12 pro-advanced-chart"><h3>Advanced Price Chart <small id="mmeta"></small></h3><div class="seg"><select id="ven" aria-label="Exchange"><option value="bybit">Bybit</option><option value="bitget">Bitget</option></select><select id="mkt" aria-label="Market"><option value="futures">Perpetual futures</option><option value="spot">Spot</option></select><select id="sym" aria-label="Instrument"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select><span id="tfs" class="seg"></span></div><div id="bm"><div class="chart"><canvas id="cv" aria-label="Expanded candlestick chart with GainzAlgo V2, GainzAlgo V2 Alpha and ETIAlgo V3 Alpha entry, stop-loss and take-profit levels"></canvas></div></div><div class="seg" style="margin-top:10px"><input id="gainzToken" class="tok" type="password" autocomplete="off" placeholder="Gainz read-only / ETI execution token (not stored)" aria-label="Gainz signal access token"><button id="refreshEngineLevels" type="button">Refresh signal levels</button></div><div id="engineLevels" class="scroll empty" style="margin-top:8px">Loading signal engine levels…</div><div class="foot" id="fm"></div></section>
  <section class="card c4" id="p-signal"><h3>ETI Trade Signal</h3><div id="bs" class="mut">Loading…</div><div class="foot" id="fs"></div></section>
  <section class="card c7" id="p-struct"><h3>Structure, Liquidity &amp; FVG <small>ETI SMC engine</small></h3><div id="bst" class="mut">Loading…</div><div id="bfv" class="mut" style="margin-top:8px"></div><div class="foot" id="fst"></div></section>
  <section class="card c5" id="p-agents"><h3>AI Agent Council <small>read-only analysis</small></h3><div id="ba" class="mut">Loading…</div><div class="foot" id="fa"></div><div class="foot" id="frc"></div></section>
  <section class="card c5" id="p-ready"><h3>Market Readiness Engine</h3><div id="br" class="mut">Loading…</div><div class="foot" id="fr"></div></section>
  <section class="card c7" id="p-daily"><h3>ETI Daily Intelligence <small><a href="/daily">Open full report</a></small></h3><div id="bd" class="mut">Loading…</div><div class="foot" id="fd"></div></section>
  <section class="card c8" id="p-sys"><h3>System &amp; Execution <small>live checks</small></h3><div id="by" class="mut">Loading…</div></section>
  <section class="card c4"><h3>Paper account, trades, journal</h3><div class="empty">Paper balances, P/L, win rate and trade history need the authenticated paper-account token, so they are not shown here and no sample figures are used. Open the Command Centre to load them.</div><p><a class="btn" href="/command#trading">Open Command Centre</a></p></section>
  <section class="card c12" id="p-acct"><h3>Exchange accounts <small>read-only · needs the ETI execution token</small></h3><div class="seg"><input id="tok" class="tok" type="password" autocomplete="off" placeholder="ETI execution token" aria-label="ETI execution token"><button id="btnacct" type="button">Load Bybit snapshot</button></div><div id="bacct" class="empty">Not loaded. The snapshot comes from the Worker's read-only Bybit route. The token is sent only to this Worker, is never stored, and the field is cleared after each request.</div><div class="empty" style="margin-top:8px">Bitget private account: ETI has no Bitget account route yet, so no Bitget balances or positions are shown and none are simulated. Bybit open orders and fills are not exposed by a read-only ETI route yet either.</div></section>
 </div>
 <footer><span id="wd">Withdrawal permissions: checking</span><span>ETI Pro view · every figure is fetched live and attributed to its exchange; no order can be placed here; research only, not investment advice</span></footer>
</main>
`;

const JS = `
var $=function(id){return document.getElementById(id)};
var S={venue:'bybit',market:'futures',symbol:'BTCUSDT',interval:'1h'};var TFS=['5m','15m','1h','4h','1d'];var INT={'5m':300,'15m':900,'1h':3600,'4h':14400,'1d':86400};var CANDLES=null,BG=null,LV=[],ENGINE_LEVELS={},FVGZ=[],SEQ=0,SIG=null,AGENT=null;
function enc(v){return encodeURIComponent(v);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function txt(v){return typeof v==='string'?v:JSON.stringify(v);}
function fmt(n,d){var x=Number(n);if(!isFinite(x))return '--';return x.toLocaleString(undefined,{maximumFractionDigits:d==null?4:d});}
function nv(v,d){return v==null?'--':fmt(v,d);}function priceFmt(v){var n=Number(v);return v==null||!isFinite(n)||n<=0?'--':n.toLocaleString(undefined,{useGrouping:true,maximumFractionDigits:20});}function levelsFor(name,items,color){return (items||[]).map(function(v){return [name,v.label,Number(v.price),color];}).filter(function(v){return isFinite(v[2])&&v[2]>0;});}function rebuildLevels(){LV=[];Object.keys(ENGINE_LEVELS).forEach(function(k){LV=LV.concat(ENGINE_LEVELS[k]||[]);});if(CANDLES)drawChart(CANDLES);}
function utc(){return new Date().toISOString().slice(0,19).replace('T',' ')+' UTC';}
function dot(id,c){$(id).className='dot '+c;}
function fail(id,msg){$(id).className='err';$(id).innerHTML='Unavailable: '+esc(msg);}
function skey(){return S.venue+'|'+S.market+'|'+S.symbol+'|'+S.interval;}
function bgCat(){return S.market==='spot'?'SPOT':'USDT-FUTURES';}
function mq(limit){return 'venue=bybit&market='+S.market+'&category='+(S.market==='spot'?'spot':'linear')+'&symbol='+enc(S.symbol)+'&interval='+enc(S.interval)+'&limit='+limit;}
function paint(){$('tv').textContent='Venue: '+S.venue.toUpperCase()+' · '+S.market;}
async function api(path,init){
 var t0=performance.now(),c=new AbortController(),tm=setTimeout(function(){c.abort();},30000);
 try{var o=Object.assign({cache:'no-store',signal:c.signal},init||{});var r=await fetch(path,o),txt0=await r.text(),j=null;try{j=JSON.parse(txt0);}catch(e){}
  if(!r.ok)throw new Error(j&&(j.error||j.message||j.detail)?String(j.error||j.message||j.detail):'HTTP '+r.status);
  if(j===null)throw new Error('response was not JSON');return {data:j,ms:Math.round(performance.now()-t0),provider:r.headers.get('x-eti-provider')};}
 catch(e){if(e.name==='AbortError')throw new Error('timed out');throw e;}finally{clearTimeout(tm);}
}
async function fetchBitget(){
 if(!window.ETIBitget)throw new Error('Bitget browser connector did not load');
 var t0=performance.now(),d=await window.ETIBitget.marketData({symbol:S.symbol,interval:S.interval,limit:300,market:S.market,category:bgCat()});
 return {candles:d.candles,ticker:d.ticker||null,failures:d.failures||{},ms:Math.round(performance.now()-t0)};
}
function fvgZones(c){var z=[];for(var i=2;i<c.length;i++){var a=c[i-2],k=c[i],lo,hi,dir;
 if(k[3]>a[2]){dir='bull';lo=a[2];hi=k[3];}else if(k[2]<a[3]){dir='bear';lo=k[2];hi=a[3];}else continue;
 var filled=false;for(var j=i+1;j<c.length;j++){if(dir==='bull'?c[j][3]<=lo:c[j][2]>=hi){filled=true;break;}}
 z.push({i:i,dir:dir,lo:lo,hi:hi,filled:filled,t:k[0]});}return z;}
function renderFvg(){var el=$('bfv');if(!CANDLES){el.textContent='';return;}
 var z=(FVGZ||[]).filter(function(q){return !q.filled;}).slice(-4).reverse();
 el.className=z.length?'':'mut';
 el.innerHTML='<b>Open fair value gaps</b> <span class="mut">('+(FVGZ||[]).length+' three-candle gaps on '+CANDLES.length+' displayed bars)</span>'+(z.length?'<ul>'+z.map(function(q){return '<li class="'+(q.dir==='bull'?'up':'dn')+'">'+(q.dir==='bull'?'Bullish':'Bearish')+' gap '+fmt(q.lo)+' – '+fmt(q.hi)+' <span class="mut">· '+Math.round((Date.now()-q.t)/60000)+' min ago</span></li>';}).join('')+'</ul>':'<div class="mut">No unfilled gaps on the displayed bars.</div>');}
function drawChart(c){
 var cv=$('cv');if(!cv||!c||!c.length)return;var dpr=window.devicePixelRatio||1,r=cv.getBoundingClientRect();if(!r.width||!r.height)return;cv.width=Math.floor(r.width*dpr);cv.height=Math.floor(r.height*dpr);var x=cv.getContext('2d');x.setTransform(dpr,0,0,dpr,0,0);var w=r.width,h=r.height;x.clearRect(0,0,w,h);
 var axisW=Math.min(290,Math.max(170,w*0.39)),plotW=Math.max(100,w-axisW),vh=h*0.18,ph=h-vh-18,hi=-Infinity,lo=Infinity,vm=0;c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3]);vm=Math.max(vm,k[5]);});
 var candleSpan=Math.max(hi-lo,Math.abs(hi)*0.000001,1e-12),active=(LV||[]).filter(function(l){return isFinite(l[2])&&l[2]>0&&l[2]>=lo-candleSpan*2.5&&l[2]<=hi+candleSpan*2.5;});active.forEach(function(l){hi=Math.max(hi,l[2]);lo=Math.min(lo,l[2]);});
 var pad=(hi-lo)*0.09||Math.max(Math.abs(hi)*0.0001,1e-8);hi+=pad;lo-=pad;
 var py=function(v){return 8+(hi-v)/(hi-lo)*ph;},bw=plotW/c.length;
 x.fillStyle='#000000';x.fillRect(plotW,0,w-plotW,h);x.strokeStyle='rgba(23,51,75,.9)';x.lineWidth=1;
 for(var i=0;i<5;i++){var y=8+i*ph/4;x.beginPath();x.moveTo(0,y);x.lineTo(plotW,y);x.stroke();x.fillStyle='#91a9c4';x.font='10px sans-serif';x.textAlign='left';x.fillText(priceFmt(hi-(hi-lo)*i/4),plotW+7,y-3);}
 x.strokeStyle='#24425f';x.beginPath();x.moveTo(plotW,0);x.lineTo(plotW,h);x.stroke();
 (FVGZ||[]).filter(function(z){return !z.filled;}).slice(-6).forEach(function(z){x.globalAlpha=0.14;x.fillStyle=z.dir==='bull'?'#00f59b':'#ff365d';var y1=py(z.hi),y2=py(z.lo);x.fillRect(z.i*bw,y1,plotW-z.i*bw,Math.max(1,y2-y1));x.globalAlpha=1;});
 c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#00f59b':'#ff365d',xx=i*bw+bw/2;x.strokeStyle=col;x.fillStyle=col;x.beginPath();x.moveTo(xx,py(k[2]));x.lineTo(xx,py(k[3]));x.stroke();var t=py(Math.max(k[1],k[4])),b=py(Math.min(k[1],k[4]));x.fillRect(xx-Math.max(1,bw*0.32),t,Math.max(2,bw*0.64),Math.max(1,b-t));x.globalAlpha=0.4;if(vm>0)x.fillRect(xx-Math.max(1,bw*0.32),h-(k[5]/vm)*vh,Math.max(2,bw*0.64),(k[5]/vm)*vh);x.globalAlpha=1;});
 function ema(a,p){var o=[],k=2/(p+1);a.forEach(function(v,i){o.push(i?v*k+o[i-1]*(1-k):v);});return o;}
 var cl=c.map(function(k){return k[4];});[[ema(cl,20),'#00e5ff'],[ema(cl,50),'#ffc247']].forEach(function(p){x.strokeStyle=p[1];x.lineWidth=1.5;x.beginPath();p[0].forEach(function(v,i){var xx=i*bw+bw/2;if(i)x.lineTo(xx,py(v));else x.moveTo(xx,py(v));});x.stroke();});
 var all=(LV||[]).filter(function(l){return isFinite(l[2])&&l[2]>0;}).slice().sort(function(a,b){return py(a[2])-py(b[2]);});
 all.forEach(function(l){var rawY=py(l[2]),yy=Math.max(7,Math.min(ph+8,rawY));x.strokeStyle=l[3];x.lineWidth=1.2;x.setLineDash([5,4]);x.beginPath();x.moveTo(0,yy);x.lineTo(plotW,yy);x.stroke();x.setLineDash([]);});
 var rowGap=Math.max(24,Math.min(34,(ph+10)/Math.max(1,all.length))),placed=all.map(function(l){return {l:l,y:Math.max(15,Math.min(ph-3,py(l[2])))};});
 for(var j=0;j<placed.length;j++){if(j&&placed[j].y<placed[j-1].y+rowGap)placed[j].y=placed[j-1].y+rowGap;}
 if(placed.length&&placed[placed.length-1].y>ph-3){placed[placed.length-1].y=ph-3;for(var z=placed.length-2;z>=0;z--)placed[z].y=Math.min(placed[z].y,placed[z+1].y-rowGap);}
 x.textAlign='left';placed.forEach(function(p){var l=p.l,yy=Math.max(14,Math.min(ph-3,p.y)),price=priceFmt(l[2]),label=l[0]+' '+l[1];x.fillStyle='#000000';x.fillRect(plotW+4,yy-11,axisW-8,22);x.fillStyle=l[3];x.font='bold 8px sans-serif';x.fillText(label,plotW+8,yy-2,axisW-16);x.font='10px ui-monospace,monospace';x.fillText(price,plotW+8,yy+8,axisW-16);});
 x.fillStyle='#91a9c4';x.font='10px sans-serif';x.textAlign='left';x.fillText('EMA20',8,ph+15);x.fillStyle='#ffc247';x.fillText('EMA50',62,ph+15);x.fillStyle='#91a9c4';x.fillText('Volume',plotW-48,h-5);
}
async function loadMarket(){
 var my=SEQ,rows,prov,ms,tick=null,tickErr=null,fails={};
 try{
  if(S.venue==='bitget'){var d=await fetchBitget();if(my!==SEQ)return false;BG={key:skey(),candles:d.candles};rows=d.candles.slice(-120);prov='bitget-browser';ms=d.ms;tick=d.ticker;fails=d.failures;}
  else{BG=null;var k=await api('/api/market/klines?'+mq(120));if(my!==SEQ)return false;rows=k.data;prov=k.provider||'bybit';ms=k.ms;}
 }catch(e){if(my!==SEQ)return false;CANDLES=null;FVGZ=[];dot('dm','bad');$('tm').textContent='Market feed: UNAVAILABLE ('+S.venue+')';$('k1').textContent='--';$('k2').textContent='--';$('fm').textContent='Failed '+utc()+' · '+S.venue.toUpperCase()+' '+S.market+': '+e.message;return false;}
 if(!Array.isArray(rows)||!rows.length){dot('dm','bad');$('tm').textContent='Market feed: no candles';return false;}
 var c=rows.map(function(v){return v.map(Number);});CANDLES=c;FVGZ=fvgZones(c);drawChart(c);renderFvg();
 var last=c[c.length-1],age=Math.max(0,Math.round((Date.now()-last[0])/1000)),lim=(INT[S.interval]||3600)*3,stale=age>lim;
 var mism=S.venue==='bybit'&&prov&&String(prov).toLowerCase().indexOf('bybit')<0;
 $('k1l').textContent='Last price · '+S.venue.toUpperCase()+' '+S.symbol;$('k1').textContent=fmt(last[4]);$('k1s').textContent='Latest candle opened '+Math.round(age/60)+' min ago'+(stale?' · STALE':'');
 dot('dm',mism||stale?'warn':'ok');$('tm').textContent=(mism?'Market feed: WRONG VENUE':stale?'Market feed: STALE':'Market feed: fresh')+' · '+prov;
 $('mmeta').textContent=S.venue.toUpperCase()+' '+S.market+' · via '+prov;
 var fk=Object.keys(fails||{});
 $('fm').textContent='Updated '+utc()+' · '+ms+' ms'+(stale?' · Do not trade on stale data.':'')+(mism?' · Served by '+prov+', not Bybit: do not trade on this feed.':'')+(fk.length?' · partial: '+fk.join(', ')+' unavailable':'');
 if(S.venue==='bybit'){try{var t=await api('/api/market/ticker?'+mq(120));if(my!==SEQ)return false;tick=t.data;}catch(e){tickErr=e.message;}}
 else if(fails&&fails.ticker){tick=null;tickErr=fails.ticker;}
 if(my!==SEQ)return false;
 var chg=tick?Number(tick.priceChangePercent):NaN;
 if(isFinite(chg)){$('k2').textContent=(chg>=0?'+':'')+chg.toFixed(2)+'%';$('k2').className=chg>=0?'up':'dn';$('k2s').textContent='24h, from the '+S.venue+' ticker';}else{$('k2').textContent='--';$('k2').className='';$('k2s').textContent=tickErr?'Ticker unavailable: '+tickErr:'Ticker did not report a 24h change';}
 return true;
}
function recon(){var el=$('frc');if(!SIG||!AGENT){el.textContent='';el.className='foot';return;}
 var s=SIG.tradeable&&(SIG.label==='BUY'||SIG.label==='SELL')?SIG.label:'stands aside',a=AGENT.action==='BUY'||AGENT.action==='SELL'?AGENT.action:'stands aside';
 var msg=s==='stands aside'&&a==='stands aside'?'consistent (both stand aside)':s===a?'aligned':(s==='stands aside'||a==='stands aside')?'only one engine is directional: treat as no consensus':'CONFLICT: opposite directions, do not trade';
 el.className='foot'+(msg.indexOf('CONFLICT')===0?' dn':'');el.textContent='ETIAlgo '+s+' · Agent council '+a+' · '+msg;}
async function loadSignal(){
 var my=SEQ;
 try{var r;
  if(S.venue==='bitget'){if(!BG||BG.key!==skey())throw new Error('Bitget candles for this selection are not loaded');r=await api('/api/signals',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({symbol:S.symbol,interval:S.interval,window:300,provider:'bitget-browser',market:S.market,candles:BG.candles})});}
  else r=await api('/api/signals?symbol='+enc(S.symbol)+'&interval='+enc(S.interval)+'&window=300&provider=bybit&market='+S.market);
  if(my!==SEQ)return;
  var d=r.data,lab=d.label||d.action||'WAIT',tr=d.tradeable===true,col=lab==='BUY'?'up':lab==='SELL'?'dn':'mut';
  SIG={label:lab,tradeable:tr};
  $('k3').textContent=tr?lab:'NO TRADE';$('k3').className=tr?col:'mut';$('k3s').textContent=S.venue.toUpperCase()+' '+S.symbol+' '+S.interval+' · '+d.conviction+' conviction';
  var h='<div class="decision '+(tr?col:'mut')+'">'+(tr?esc(lab):'NO TRADE')+'</div>';
  if(!tr)h+='<div class="empty" style="margin:8px 0">The quality gate stands aside. Directional lean: <b class="'+col+'">'+esc(lab)+'</b> at '+esc(d.conviction)+' conviction. Levels are reference only.</div>';
  h+='<table><tr><td>'+(tr?'Entry':'Reference entry')+'</td><td>'+priceFmt(d.entry)+'</td></tr><tr><td>Stop loss</td><td>'+priceFmt(d.stopLoss)+'</td></tr>'+(d.targets||[]).map(function(t){return '<tr><td>Take-profit '+esc(t.target)+' ('+esc(t.rewardRisk)+'R)</td><td>'+priceFmt(t.price)+'</td></tr>';}).join('')+'</table>';
  var v=d.historicalValidation||{};h+='<div class="foot">Confluence score '+esc(d.score)+' (heuristic, not a probability). Replay win rate: '+(v.winRate==null?'withheld (n='+esc(v.sampleCount)+', under 20)':esc(v.winRate)+'% (n='+esc(v.sampleCount)+')')+'. Excludes fees and slippage.</div>';
  $('bs').className='';$('bs').innerHTML=h;$('fs').textContent='Updated '+utc()+' · '+r.ms+' ms · computed on '+S.venue.toUpperCase()+' '+S.market+' '+S.interval+' candles';
  var lv=[{label:tr?'ENTRY':'REF ENTRY',price:d.entry},{label:'STOP',price:d.stopLoss}];(d.targets||[]).forEach(function(t){lv.push({label:'TP'+t.target,price:t.price});});
  ENGINE_LEVELS.etiAlgo=levelsFor('ETIAlgo',lv,'#00e5ff');rebuildLevels();}
 catch(e){if(my!==SEQ)return;SIG=null;ENGINE_LEVELS.etiAlgo=[];rebuildLevels();$('k3').textContent='--';$('k3').className='';$('k3s').textContent='Signal unavailable';fail('bs',e.message);}
 recon();
}
function strategyForInterval(){return S.interval==='1m'||S.interval==='5m'?'scalp':S.interval==='4h'?'swing':S.interval==='1d'||S.interval==='1w'?'position':'intraday';}
function renderEngineLevels(rows){var el=$('engineLevels'),html='<table><tr><th>Engine</th><th>Level</th><th>Full price</th></tr>';if(!rows.length)html+='<tr><td colspan="3">No current engine levels are available for this symbol, venue and market.</td></tr>';rows.forEach(function(r){html+='<tr><td>'+esc(r.engine)+'</td><td>'+esc(r.label)+'</td><td style="font-variant-numeric:tabular-nums;white-space:normal;overflow-wrap:anywhere">'+esc(priceFmt(r.price))+'</td></tr>';});el.className='scroll';el.innerHTML=html+'</table><div class="foot">Prices are full precision from each engine response. Chart labels use a dedicated right-side price column.</div>';}
async function loadEngineLevels(){
 var my=SEQ,rows=[],v3=null,gainzToken=$('gainzToken').value.trim(),strategy=strategyForInterval();
 ENGINE_LEVELS.v3Alpha=[];ENGINE_LEVELS.gainzV2=[];ENGINE_LEVELS.gainzV2Alpha=[];
 try{
  var omni;
  if(S.venue==='bitget'){
   if(!window.ETIBitget||!window.ETIBitget.loadSignalInputs)throw new Error('Bitget multi-timeframe feed is unavailable');
   var md=await window.ETIBitget.loadSignalInputs({symbol:S.symbol,strategy:strategy,market:S.market,category:bgCat()});
   omni=await api('/api/omnisignal',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({symbol:S.symbol,strategy:strategy,engines:'swift,gainz',venue:'bitget',market:S.market,category:bgCat(),marketData:md})});
  }else{
   omni=await api('/api/omnisignal?symbol='+enc(S.symbol)+'&strategy='+enc(strategy)+'&engines=swift,gainz&venue=bybit&market='+enc(S.market));
  }
  if(my!==SEQ)return;
  v3=omni.data.v3Alpha||null;
  if(v3&&v3.status==='SIGNAL'&&v3.entryZone&&v3.stopLoss!=null&&v3.takeProfits){
   var vv=[{label:'ENTRY LOW',price:v3.entryZone[0]},{label:'ENTRY HIGH',price:v3.entryZone[1]},{label:'STOP',price:v3.stopLoss}];
   (v3.takeProfits||[]).forEach(function(t){vv.push({label:t.label,price:t.price});});
   ENGINE_LEVELS.v3Alpha=levelsFor('ETIAlgo V3 Alpha',vv,'#00e5ff');
   vv.forEach(function(q){rows.push({engine:'ETIAlgo V3 Alpha',label:q.label,price:q.price});});
  }
 }catch(e){if(my===SEQ)rows.push({engine:'ETIAlgo V3 Alpha',label:'Unavailable',price:null,detail:e.message});}
 if(gainzToken){
  try{
   var gr=await api('/api/gainz/signals?symbol='+enc(S.symbol)+'&limit=100',{headers:{authorization:'Bearer '+gainzToken}});
   if(my!==SEQ)return;
   var signals=(gr.data.signals||[]).filter(function(s){return String(s.exchange_name||'').toLowerCase()===S.venue&&String(s.market||'').toLowerCase()===S.market&&s.state==='validated';});
   ['gainz_v2','gainz_v2_alpha'].forEach(function(engine){
    var match=signals.filter(function(s){return s.engine===engine;}).sort(function(a,b){return Number(b.received_at)-Number(a.received_at);})[0];
    if(!match)return;
    var name=engine==='gainz_v2'?'GainzAlgo V2':'GainzAlgo V2 Alpha',color=engine==='gainz_v2'?'#ffc247':'#b98cff';
    var vv=[{label:'ENTRY',price:match.entry},{label:'STOP',price:match.stop_loss},{label:'TP1',price:match.tp1},{label:'TP2',price:match.tp2},{label:'TP3',price:match.tp3}].filter(function(q){return q.price!=null&&Number(q.price)>0;});
    ENGINE_LEVELS[engine]=levelsFor(name,vv,color);vv.forEach(function(q){rows.push({engine:name,label:q.label,price:q.price});});
   });
  }catch(e){if(my===SEQ)rows.push({engine:'GainzAlgo',label:'Unavailable / token rejected',price:null,detail:e.message});}
 }else rows.push({engine:'GainzAlgo V2 / V2 Alpha',label:'Enter the read-only token above to load protected signal history',price:null});
 if(my!==SEQ)return;
 rebuildLevels();renderEngineLevels(rows.filter(function(r){return r.price!=null;}));
 if(rows.some(function(r){return r.price==null;})){$('engineLevels').innerHTML+='<div class="foot">'+rows.filter(function(r){return r.price==null;}).map(function(r){return esc(r.engine+': '+r.label+(r.detail?' · '+r.detail:''));}).join('<br>')+'</div>';}
}
async function loadReady(){
 var my=SEQ;
 try{var r=await api('/api/readiness?market=crypto&symbol='+encodeURIComponent(S.symbol)+'&strategy=intraday&scope=now');if(my!==SEQ)return;var o=r.data.overall||{};
  $('k4').textContent=o.statusLabel||'--';$('k4s').textContent=(o.evaluated!=null?o.evaluated+' of 12 factors evaluated':'');
  var h='<div class="decision">'+esc(o.statusLabel||'unknown')+'</div><div class="mut" style="margin:6px 0">'+esc(o.recommendation||'')+'</div><ul>'+(o.reasons||[]).slice(0,6).map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';
  if(o.notEvaluated&&o.notEvaluated.length)h+='<div class="foot">Not evaluated: '+esc(o.notEvaluated.join('; '))+'</div>';
  $('br').className='';$('br').innerHTML=h;$('fr').textContent='Updated '+utc()+' · '+r.ms+' ms · a favourable rating is never an entry signal';}
 catch(e){if(my!==SEQ)return;$('k4').textContent='--';$('k4s').textContent='Readiness unavailable';fail('br',e.message);}
}
async function loadStruct(){
 var my=SEQ,tfl=['15m','1h','4h','1d'],prov=S.venue==='bitget'?'bitget':'bybit';
 var rs=await Promise.allSettled(tfl.map(async function(tf){
  var q='symbol='+enc(S.symbol)+'&timeframe='+enc(tf)+'&provider='+prov+'&market='+S.market;
  if(S.venue==='bitget'){if(!window.ETIBitget)throw new Error('Bitget connector not loaded');var rows=await window.ETIBitget.candles({symbol:S.symbol,interval:tf,limit:300,market:S.market,category:bgCat()});return (await api('/api/analysis/smc?'+q,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({candles:rows})})).data;}
  return (await api('/api/analysis/smc?'+q)).data;}));
 if(my!==SEQ)return;
 var cur=null,h='<div class="scroll"><table><tr><th>TF</th><th>Structure</th><th>Stance</th><th>Last event</th><th>Zones</th></tr>';
 rs.forEach(function(r,i){var tf=tfl[i];
  if(r.status!=='fulfilled'){h+='<tr><td>'+tf+'</td><td colspan="4" class="warn">unavailable: '+esc(r.reason&&r.reason.message)+'</td></tr>';return;}
  var a=r.value||{},st=a.structure||{},ev=(st.events||[]).slice(-1)[0],obs=(a.orderBlocks||[]).filter(function(o){return !o.invalidated&&!o.mitigated;});
  if(tf===S.interval||(cur===null&&tf==='1h'))cur=a;
  h+='<tr><td>'+tf+'</td><td>'+esc(st.trend||a.status||'--')+'</td><td>'+esc(st.stance||a.reason||'--')+'</td><td>'+esc(ev?(ev.type||ev.event||'event'):'none')+'</td><td>'+obs.length+' OB · '+(a.liquidityPools||[]).length+' pools</td></tr>';});
 h+='</table></div>';
 if(cur){var ob=(cur.orderBlocks||[]).filter(function(o){return !o.invalidated&&!o.mitigated;}).slice(-4),sw=(cur.liquiditySweeps||[]).slice(-3);
  if(ob.length)h+='<ul>'+ob.map(function(o){return '<li class="'+(o.kind==='bullish'?'up':'dn')+'">'+esc(String(o.kind).toUpperCase())+' order block '+fmt(o.low)+' – '+fmt(o.high)+(o.hasFVG?' <span class="mut">· FVG confluence</span>':'')+'</li>';}).join('')+'</ul>';
  if(sw.length)h+='<ul>'+sw.map(function(s){return '<li>'+esc(String(s.side).replace('_',' '))+' sweep at '+fmt(s.level)+' <span class="mut">· '+(s.reclaimed?'reclaimed':'not reclaimed')+'</span></li>';}).join('')+'</ul>';}
 $('bst').className='';$('bst').innerHTML=h;$('fst').textContent=prov.toUpperCase()+' · '+S.market+' · '+S.symbol+' · '+utc()+' · closed-candle structure; zones are analytical approximations, not proof of institutional orders.';
}
async function loadAgents(){
 var my=SEQ;
 if(S.venue!=='bybit'){AGENT=null;$('ba').className='empty';$('ba').textContent='The agent council reads market data through Worker-side providers. Bitget candles are only reachable from the browser, so the council is not run for Bitget and no Bybit result is shown as Bitget analysis. Switch to Bybit to run it.';$('fa').textContent='';recon();return;}
 try{var r=await api('/api/agents/analyze?symbol='+enc(S.symbol)+'&interval='+enc(S.interval)+'&provider=bybit');if(my!==SEQ)return;
  var d=r.data,dc=d.decision||{};AGENT=dc;
  var act=dc.action||'--',col=act==='BUY'?'up':act==='SELL'?'dn':'mut';
  var st=(d.reports||[]).filter(function(x){return x.status==='ok'&&(x.stance==='bullish'||x.stance==='bearish')&&x.agent!=='commander';});
  var h='<div class="decision '+col+'">'+esc(act)+'</div><div class="mut" style="margin:6px 0">Confidence '+esc(dc.confidence)+(dc.vetoedBy?' · VETOED by '+esc(dc.vetoedBy):'')+' · execution eligible: '+(dc.executionEligible?'yes':'no')+'</div>';
  var why=Array.isArray(dc.rationale)?dc.rationale.slice(0,4):[];
  if(why.length)h+='<ul>'+why.map(function(q){return '<li>'+esc(txt(q))+'</li>';}).join('')+'</ul>';
  h+='<div class="foot">Stances: '+(st.length?st.map(function(q){return esc(q.agent)+' '+esc(q.stance);}).join(' · '):'none directional')+'</div>';
  $('ba').className='';$('ba').innerHTML=h;
  var dq=d.dataQuality||{},wrong=dq.provider&&String(dq.provider).toLowerCase().indexOf('bybit')<0;
  $('fa').textContent=utc()+' · '+r.ms+' ms · data: '+(dq.provider||'unknown')+(wrong?' · WARNING: served by another provider, not Bybit':'')+' · read-only: no order can be placed from this panel';}
 catch(e){if(my!==SEQ)return;AGENT=null;fail('ba',e.message);$('fa').textContent='';}
 recon();
}
function acctHtml(d){
 if(d.configured===false)return '<div class="err">Bybit credentials are not configured on the Worker ('+esc(d.error||'credentials_missing')+'). Nothing is shown.</div>';
 var cls=d.status==='connected'?'up':d.status==='partial'?'warn':'dn',pos=Array.isArray(d.positions)?d.positions:[],h='';
 h+='<div class="seg"><span class="badge '+cls+'">'+esc(d.status)+'</span><span class="badge">'+esc(d.environment)+'</span><span class="badge">read-only snapshot</span></div>';
 h+='<div class="grid" style="margin-bottom:8px"><div class="kpi c4"><small>Equity (USD)</small><b>'+nv(d.equityUsd,2)+'</b></div><div class="kpi c4"><small>Available (USD)</small><b>'+nv(d.availableUsd,2)+'</b></div><div class="kpi c4"><small>Open positions</small><b>'+pos.length+'</b></div></div>';
 h+=pos.length?'<div class="scroll"><table><tr><th>Symbol</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Unrealised P/L</th><th>Leverage</th><th>Liquidation</th><th>Margin</th></tr>'+pos.map(function(p){var c=Number(p.unrealizedPnl)>=0?'up':'dn';return '<tr><td>'+(p.symbol===S.symbol?'<b>'+esc(p.symbol)+'</b>':esc(p.symbol))+' <span class="mut">'+esc(p.category)+'</span></td><td>'+esc(p.side)+'</td><td>'+nv(p.size)+'</td><td>'+nv(p.avgPrice)+'</td><td>'+nv(p.markPrice)+'</td><td class="'+c+'">'+nv(p.unrealizedPnl,2)+'</td><td>'+nv(p.leverage)+'x</td><td>'+nv(p.liquidationPrice)+'</td><td>'+esc(p.marginMode)+'</td></tr>';}).join('')+'</table></div>':'<div class="mut">No open derivatives positions reported.</div>';
 var as=(d.assets||[]).slice().sort(function(a,b){return (Number(b.usdValue)||0)-(Number(a.usdValue)||0);}).slice(0,8);
 if(as.length)h+='<div class="scroll"><table><tr><th>Asset</th><th>Wallet balance</th><th>Locked</th><th>USD value</th></tr>'+as.map(function(a){return '<tr><td>'+esc(a.coin)+'</td><td>'+nv(a.walletBalance,6)+'</td><td>'+nv(a.locked,6)+'</td><td>'+nv(a.usdValue,2)+'</td></tr>';}).join('')+'</table></div>';
 if((d.warnings||[]).length)h+='<ul class="warn">'+d.warnings.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';
 var checked=Date.parse(d.checkedAt);h+='<div class="foot">Snapshot '+(Number.isFinite(checked)?esc(new Date(checked).toISOString().slice(0,19).replace('T',' '))+' UTC':'timestamp unavailable')+' · orders, transfers and withdrawals are not available from this route</div>';
 return h;
}
async function loadAccount(){
 var tk=$('tok').value.trim(),o=$('bacct');
 if(!tk){o.className='err';o.textContent='Enter the ETI execution token to load the read-only Bybit snapshot.';return;}
 o.className='mut';o.textContent='Loading…';
 try{var r=await api('/api/bybit/account',{headers:{authorization:'Bearer '+tk}});$('tok').value='';o.className='';o.innerHTML=acctHtml(r.data);}
 catch(e){$('tok').value='';fail('bacct',e.message);}
}
async function loadDaily(){
 try{var r=await api('/api/daily-report');var d=r.data;if(!d||!d.finalVerdict||!Array.isArray(d.opportunities)||!d.dataQuality||!Array.isArray(d.dataQuality.assets))throw new Error('Daily report returned an incomplete data contract');
  var h='<div class="decision">'+esc(d.finalVerdict.label)+'</div><div class="mut" style="margin:6px 0">'+esc(d.finalVerdict.summary)+'</div><div class="scroll"><table><tr><th>Asset</th><th>Direction</th><th>Setup</th><th>ETI verdict</th></tr>'+d.opportunities.map(function(o){var c=o.direction==='BUY'?'up':o.direction==='SELL'?'dn':'mut';return '<tr><td>'+esc(o.asset)+'</td><td class="'+c+'"><b>'+esc(o.direction)+'</b></td><td>'+esc(o.setup)+'</td><td>'+esc(o.verdict)+'</td></tr>';}).join('')+'</table></div>';
  $('bd').className='';$('bd').innerHTML=h;$('fd').textContent=d.dateTimeUtc+(d.cache?(d.cache.hit?' · cached '+d.cache.ageSeconds+' s':' · freshly generated'):'')+' · '+d.dataQuality.assets.filter(function(a){return a.status==='evaluated';}).length+' of '+d.dataQuality.assets.length+' assets fully evaluated';}
 catch(e){fail('bd',e.message);}
}
function row(name,state,detail){return '<tr><td><i class="dot '+state+'"></i></td><td>'+esc(name)+'</td><td class="mut">'+esc(detail)+'</td></tr>';}
async function loadSys(){
 var rs=await Promise.allSettled([api('/api/system/health'),api('/api/execution/status'),api('/api/readiness/status'),api('/api/daily-report/status'),api('/api/agents/autopilot')]);var h='<table>';
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
 a=rs[4];if(a.status==='fulfilled'){var ap=a.value.data;h+=row('Agent autopilot',ap.killSwitch?'bad':'ok',(ap.enabled?'enabled':'disabled')+' · '+ap.mode+' · live orders '+(ap.liveOrdersAllowed?'ALLOWED':'not allowed')+(ap.killSwitch?' · KILL SWITCH ACTIVE':''));}else h+=row('Agent autopilot','warn',a.reason.message);
 h+='</table><div class="foot">Each row reflects a request made just now ('+esc(utc())+'). Amber means not configured or unverified; red means the check failed.</div>';
 $('by').className='';$('by').innerHTML=h;
}
async function refreshAll(){
 SEQ++;SIG=null;AGENT=null;LV=[];ENGINE_LEVELS={};
 [['bs','fs'],['ba','fa'],['bst','fst']].forEach(function(p){$(p[0]).className='mut';$(p[0]).textContent='Loading…';$(p[1]).textContent='';});
 $('frc').textContent='';$('bfv').textContent='';
 await loadMarket();
 loadSignal();loadEngineLevels();loadReady();loadStruct();loadAgents();
}
async function pollMarket(){SEQ++;var ok=await loadMarket();if(ok){loadSignal();loadEngineLevels();}}
function tfs(){$('tfs').innerHTML=TFS.map(function(t){return '<button data-tf="'+t+'" class="'+(t===S.interval?'on':'')+'">'+t+'</button>';}).join('');$('tfs').querySelectorAll('button').forEach(function(b){b.onclick=function(){S.interval=b.getAttribute('data-tf');tfs();refreshAll();};});}
$('ven').onchange=function(){S.venue=$('ven').value;paint();refreshAll();};
$('mkt').onchange=function(){S.market=$('mkt').value;paint();refreshAll();};
$('sym').onchange=function(){S.symbol=$('sym').value;refreshAll();};
$('btnacct').onclick=loadAccount;$('refreshEngineLevels').onclick=loadEngineLevels;$('gainzToken').addEventListener('keydown',function(e){if(e.key==='Enter')loadEngineLevels();});
$('tok').addEventListener('keydown',function(e){if(e.key==='Enter')loadAccount();});
window.addEventListener('resize',function(){if(CANDLES)drawChart(CANDLES);});
setInterval(function(){$('clock').textContent=utc();},1000);$('clock').textContent=utc();
setInterval(function(){if(document.visibilityState==='visible')pollMarket();},30000);
setInterval(function(){if(document.visibilityState==='visible')loadSys();},60000);
tfs();paint();refreshAll();loadDaily();loadSys();
`;

export function proPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#020817"><title>ETI Pro: Elite Trading Intelligence</title><link rel="preconnect" href="https://fonts.googleapis.com"><style>${CSS}</style><script src="/bitget-client.js"></script></head><body>${BODY}<script>${JS}</script></body></html>`;
}
