/**
 * ETI Command Centre: one page, two workspaces (Trading + Global Intelligence), one navigation shell.
 * Every panel loads independently and shows loading, error and stale states. Nothing is invented: a panel shows
 * data returned by a real endpoint or says why it is unavailable. Features that are not built yet are marked "soon" and disabled.
 * NOTE: this HTML lives in a template literal. Keep the embedded script free of backticks, dollar-brace sequences and backslashes
 * (command.test.ts parses the cooked script to enforce that).
 */
const CSS = `
:root{color-scheme:dark;--bg:#050914;--bg2:#0a1226;--panel:rgba(14,24,48,.78);--line:rgba(56,189,248,.28);--line2:rgba(99,102,241,.25);--txt:#e8f1ff;--mut:#8fa6c8;--cyan:#22d3ee;--blue:#3b82f6;--purple:#8b5cf6;--green:#10d9a0;--red:#ff4d6d;--orange:#ff9f43;--gold:#f5c542}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{background:radial-gradient(1200px 600px at 10% -10%,#10224a 0,transparent 60%),radial-gradient(900px 500px at 100% 0,#1a1050 0,transparent 55%),var(--bg);color:var(--txt);font:14px/1.45 Inter,system-ui,Segoe UI,Roboto,sans-serif}
a{color:var(--cyan)}button,input,select{font:inherit;color:var(--txt)}
button{background:linear-gradient(180deg,rgba(34,211,238,.14),rgba(59,130,246,.10));border:1px solid var(--line);border-radius:10px;padding:8px 12px;cursor:pointer;transition:box-shadow .2s,transform .1s}
button:hover:not(:disabled){box-shadow:0 0 14px rgba(34,211,238,.35)}button:active:not(:disabled){transform:translateY(1px)}button:disabled{opacity:.45;cursor:not-allowed}
button.on{border-color:var(--green);color:var(--green);box-shadow:0 0 10px rgba(16,217,160,.3)}
input,select{background:rgba(5,9,20,.8);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.app{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:100vh}
.nav{position:sticky;top:0;height:100vh;overflow:auto;padding:14px 10px;border-right:1px solid var(--line2);background:linear-gradient(180deg,rgba(10,18,38,.92),rgba(5,9,20,.92));backdrop-filter:blur(8px)}
.brand{padding:6px 8px 14px}.brand b{display:block;font-size:30px;letter-spacing:2px;font-style:italic;background:linear-gradient(90deg,#fff,var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent}.brand small{color:var(--mut);letter-spacing:1px;font-size:10px}
.nav a.item{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:10px;color:var(--txt);text-decoration:none;border:1px solid transparent;margin:2px 0}
.nav a.item:hover{background:rgba(34,211,238,.08)}.nav a.item.active{background:linear-gradient(90deg,rgba(34,211,238,.20),rgba(59,130,246,.10));border-color:var(--line)}
.nav .soon{opacity:.45;cursor:not-allowed}.nav .soon em{font-size:10px;color:var(--gold);margin-left:auto;font-style:normal;border:1px solid rgba(245,197,66,.4);border-radius:6px;padding:0 5px}
.nav h4{margin:14px 8px 4px;color:var(--mut);font-size:10px;letter-spacing:1.5px;text-transform:uppercase}
.main{min-width:0;display:flex;flex-direction:column}
.top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--line2);background:rgba(5,9,20,.72);backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}
.tag{color:var(--green);font-weight:700;font-style:italic}.tag2{color:var(--cyan);font-weight:600;font-size:12px;letter-spacing:.5px}
.pills{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.pill{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;background:rgba(14,24,48,.7)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--mut);display:inline-block}.dot.ok{background:var(--green);box-shadow:0 0 8px var(--green)}.dot.warn{background:var(--orange);box-shadow:0 0 8px var(--orange)}.dot.bad{background:var(--red);box-shadow:0 0 8px var(--red)}
.content{padding:16px 18px 110px;min-width:0}.view{display:none}.view.active{display:block}
.grid{display:grid;gap:14px;grid-template-columns:repeat(12,minmax(0,1fr))}.c4{grid-column:span 4}.c5{grid-column:span 5}.c6{grid-column:span 6}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:14px;box-shadow:0 0 0 1px rgba(139,92,246,.10) inset,0 10px 30px rgba(0,0,0,.35);backdrop-filter:blur(10px);min-width:0}
.card h3{margin:0 0 10px;font-size:14px;letter-spacing:.4px;display:flex;align-items:center;gap:8px;justify-content:space-between}.card h3 small{font-weight:400;color:var(--mut)}
.card.red{border-color:rgba(255,77,109,.5)}.card.gold{border-color:rgba(245,197,66,.45)}
.foot{margin-top:8px;color:var(--mut);font-size:11px}.body.loading{opacity:.55}.body.loading:before{content:"Loading…";color:var(--mut);display:block}
.err{color:var(--orange);border:1px dashed rgba(255,159,67,.5);border-radius:10px;padding:10px}.empty{color:var(--mut);border:1px dashed var(--line2);border-radius:10px;padding:12px}
.kpis{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}.kpi{border:1px solid var(--line2);border-radius:12px;padding:10px;background:rgba(5,9,20,.5)}.kpi small{color:var(--mut);display:block}.kpi b{font-size:20px}
.pos{color:var(--green)}.neg{color:var(--red)}.mut{color:var(--mut)}.gold{color:var(--gold)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:6px 5px;border-bottom:1px solid rgba(99,102,241,.18);text-align:left;font-size:12px;vertical-align:top}th{color:var(--mut);font-weight:600}
.scroll{max-height:340px;overflow:auto}.chart{height:340px;width:100%;position:relative}canvas{width:100%;height:100%;display:block}
.seg{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}.seg button{padding:4px 9px;font-size:12px}
.decision{font-size:34px;font-weight:800;letter-spacing:1px}.sev{display:inline-block;border-radius:6px;padding:0 6px;font-size:11px;font-weight:700}
.sev.CRITICAL{background:rgba(255,77,109,.2);color:var(--red);border:1px solid var(--red)}.sev.HIGH{background:rgba(255,159,67,.18);color:var(--orange);border:1px solid var(--orange)}.sev.MEDIUM{background:rgba(245,197,66,.15);color:var(--gold);border:1px solid var(--gold)}.sev.LOW,.sev.INFORMATIONAL,.sev.UNKNOWN{background:rgba(143,166,200,.15);color:var(--mut);border:1px solid var(--mut)}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.row>*{min-width:0}
.hero{display:grid;gap:14px;grid-template-columns:1fr 1fr}.hero .card{cursor:pointer}.hero h2{margin:0 0 4px;font-size:18px}
.qa{position:fixed;left:230px;right:0;bottom:0;display:flex;gap:8px;padding:10px 14px;background:rgba(5,9,20,.9);border-top:1px solid var(--line2);backdrop-filter:blur(8px);overflow-x:auto;z-index:6}.qa button{white-space:nowrap}
.qa .exec{background:radial-gradient(circle,rgba(34,211,238,.35),rgba(59,130,246,.15));border-color:var(--cyan);font-weight:700;margin:0 auto}
#modal{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:20;padding:14px}#modal.open{display:flex}
#modal .box{background:#0a1226;border:1px solid var(--line);border-radius:16px;max-width:900px;width:100%;max-height:86vh;overflow:auto;padding:16px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(5,9,20,.7);border:1px solid var(--line2);border-radius:10px;padding:10px;max-height:50vh;overflow:auto;font-size:12px}
@media(max-width:980px){.app{grid-template-columns:1fr}.nav{position:sticky;top:0;height:auto;display:flex;gap:6px;overflow-x:auto;padding:8px;border-right:0;border-bottom:1px solid var(--line2);z-index:7}.nav .brand,.nav h4{display:none}.nav a.item{white-space:nowrap;flex:0 0 auto}.top{position:static}.qa{left:0}.c4,.c5,.c6,.c7,.c8{grid-column:span 12}.hero{grid-template-columns:1fr}.chart{height:270px}.decision{font-size:28px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const BODY = `
<div class="app">
<nav class="nav" id="nav" aria-label="Primary">
 <div class="brand"><b>ETI</b><small>ELITE TRADING INTELLIGENCE</small></div>
 <a class="item" data-view="command" href="#command">Command Centre</a>
 <h4>Trading</h4>
 <a class="item" data-view="trading" href="#trading">Trading Dashboard</a>
 <a class="item" data-view="trading" data-anchor="p-signal" href="#trading">Trading Signals</a>
 <a class="item" data-view="risk" href="#risk">Risk Manager</a>
 <a class="item" data-view="agents" href="#agents">AI Agents</a>
 <a class="item" data-view="elite" href="#elite">Elite Trader Research</a>
 <h4>Intelligence</h4>
 <a class="item" href="/sports">Sports Betting Intelligence</a>
 <a class="item" data-view="intel" href="#intel">Global Intelligence</a>
 <a class="item" data-view="intel" data-anchor="p-sec" href="#intel">Institutional Intelligence</a>
 <a class="item" data-view="security" href="#security">Security Centre</a>
 <h4>Roadmap</h4>
 <a class="item soon" aria-disabled="true" title="Not built yet">Crawler Intel <em>soon</em></a>
 <a class="item soon" aria-disabled="true" title="Not built yet">Market Scanner <em>soon</em></a>
 <a class="item soon" aria-disabled="true" title="Not built yet">Portfolio <em>soon</em></a>
 <a class="item soon" aria-disabled="true" title="Not built yet">Trade Journal <em>soon</em></a>
 <a class="item soon" aria-disabled="true" title="Not built yet">Analytics <em>soon</em></a>
 <a class="item soon" aria-disabled="true" title="Not built yet">Reports <em>soon</em></a>
</nav>
<div class="main">
<header class="top">
 <div><span class="tag" id="tagline">Profitable. Disciplined. Intelligent.</span><br><span class="tag2" id="tagline2">DISCOVER OPPORTUNITIES. DETECT THREATS. PROTECT CAPITAL.</span></div>
 <div class="pills" id="pills" aria-live="polite">
  <span class="pill"><i class="dot" id="d-market"></i><span id="t-market">Market feed: checking</span></span>
  <span class="pill"><i class="dot" id="d-exec"></i><span id="t-exec">Execution: checking</span></span>
  <span class="pill"><i class="dot" id="d-wd"></i><span id="t-wd">Withdrawals: checking</span></span>
  <span class="pill" id="clock">--</span>
 </div>
</header>
<main class="content" id="content">

<section class="view" id="v-command">
 <div class="hero">
  <div class="card" id="launch-trading" role="button" tabindex="0"><h2>Trading Command Centre</h2><div class="mut">Charts, signals, paper account, execution history.</div><div id="ov-trading" class="foot">Loading…</div></div>
  <div class="card" id="launch-intel" role="button" tabindex="0"><h2>Global Intelligence Command Centre</h2><div class="mut">Institutional filings, research, token security.</div><div id="ov-intel" class="foot">Loading…</div></div>
 </div>
 <div class="grid" style="margin-top:14px">
  <section class="card c7"><h3>System Health <small>verified by live checks</small></h3><div class="body" id="b-health"></div><div class="foot" id="f-health"></div></section>
  <section class="card c5"><h3>Honest status</h3><div class="body mut">A green indicator means the check just succeeded. Amber means configured-but-unverified or not configured. Red means the check failed. Nothing on this screen is demonstration data.</div></section>
 </div>
</section>

<section class="view" id="v-trading">
 <div class="card" style="margin-bottom:14px"><div class="row"><b>Instrument</b><select id="symbol" aria-label="Instrument"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select><span class="mut">Context is kept when you switch workspaces.</span></div><div class="seg" id="tf"></div></div>
 <section class="card" style="margin-bottom:14px"><h3>Paper account <span class="sev MEDIUM">SIMULATED</span></h3>
  <div class="row"><input id="token" type="password" autocomplete="off" placeholder="Paper-trading token (kept in memory only)" style="min-width:260px"><button id="tokenGo">Load account</button></div>
  <div class="body" id="b-kpi"></div><div class="foot" id="f-kpi"></div></section>
 <div class="grid">
  <section class="card c8"><h3>Market Overview <small id="mk-meta"></small></h3><div class="body" id="b-market"></div><div class="foot" id="f-market"></div></section>
  <section class="card c4" id="p-signal"><h3>ETI Trade Signal</h3><div class="body" id="b-signal"></div><div class="foot" id="f-signal"></div></section>
  <section class="card c12"><h3>Execution history <small>from the execution audit log (needs token)</small></h3><div class="body" id="b-history"></div><div class="foot" id="f-history"></div></section>
 </div>
</section>

<section class="view" id="v-intel">
 <div class="grid">
  <section class="card c7" id="p-sec"><h3>Institutional Intelligence <small>SEC EDGAR</small></h3><div class="seg" id="secTabs"></div><div class="body scroll" id="b-sec"></div><div class="foot" id="f-sec"></div></section>
  <section class="card c5"><h3>Academic Research <small>arXiv q-fin</small></h3><div class="body scroll" id="b-research"></div><div class="foot" id="f-research"></div></section>
  <section class="card c7"><h3>Market Intelligence Sources</h3><div class="body" id="b-providers"></div><div class="foot" id="f-providers"></div></section>
  <section class="card c5"><h3>Readiness &amp; Economic Calendar</h3><div class="body" id="b-readiness"></div><div class="foot" id="f-readiness"></div></section>
  <section class="card c12"><h3>Feed activity <small>jobs this ETI session ran in your browser</small></h3><div class="body" id="b-feeds"></div><div class="foot">No standing background crawler is deployed yet. The 1,000 to 2,000 market scan target is not met and is not claimed.</div></section>
 </div>
</section>

<section class="view" id="v-security">
 <div class="grid">
  <section class="card red c5"><h3>Rug-Pull Defence <small>token security check</small></h3>
   <div class="row"><select id="chain" aria-label="Chain"></select><input id="addr" placeholder="0x contract address" style="flex:1;min-width:220px"><button id="chk">Check</button></div>
   <div class="body" id="b-token"><div class="empty">Enter a contract address to run a security check. Results come from GoPlus static analysis and are never presented as a safety guarantee.</div></div><div class="foot" id="f-token"></div></section>
  <section class="card red c7"><h3>Threat summary <small>checks run this session</small></h3><div class="body" id="b-threats"></div>
   <div class="foot">Protective actions are advisory in this release: they are not yet connected to open positions. No standing wallet or liquidity surveillance is running.</div></section>
  <section class="card c12"><h3>Blockchain Intelligence <small>latest DexScreener token profiles</small></h3><div class="body scroll" id="b-dex"></div><div class="foot" id="f-dex"></div></section>
 </div>
</section>

<section class="view" id="v-elite">
 <div class="grid">
  <section class="card c4"><h3>Elite Traders <small id="el-meta"></small></h3><div class="row"><input id="elq" placeholder="Search" style="flex:1"></div><div class="body scroll" id="b-elist"></div></section>
  <section class="card c8"><h3>Profile</h3><div class="body scroll" id="b-eprof"><div class="empty">Select a trader.</div></div></section>
 </div>
</section>

<section class="view" id="v-agents">
 <div class="grid">
  <section class="card c12"><h3>ETI Agents <small id="ag-meta"></small></h3><div class="row"><button id="agRun">Run analysis (read-only)</button><span class="mut">Calls /api/agents/analyze for the selected instrument. Submits no orders.</span></div><div class="body" id="b-agents"></div><div class="foot" id="f-agents"></div></section>
  <section class="card c12"><h3>Latest analysis</h3><div class="body" id="b-agrun"><div class="empty">No analysis run yet.</div></div></section>
 </div>
</section>

<section class="view" id="v-risk">
 <div class="grid">
  <section class="card c6"><h3>Execution &amp; risk controls</h3><div class="body" id="b-risk"></div><div class="foot" id="f-risk"></div></section>
  <section class="card c6"><h3>Paper-account limits</h3><div class="body" id="b-limits"><div class="empty">Enter the paper-trading token on the Trading Dashboard to load limits.</div></div></section>
 </div>
</section>

</main>
<div class="qa" id="qa">
 <button id="qa-auto">Auto Trade: status</button>
 <button id="qa-bt">Backtest Strategies</button>
 <button id="qa-risk">Risk Manager</button>
 <button class="exec" id="qa-exec">ETI Execute Intelligence</button>
 <button id="qa-exp">Export Report</button>
 <button id="qa-cmp">Compare Strategies</button>
 <button disabled title="Not built yet">Settings (soon)</button>
</div>
</div>
</div>
<div id="modal" role="dialog" aria-modal="true" aria-labelledby="mt"><div class="box"><div class="row" style="justify-content:space-between"><h3 id="mt" style="margin:0"></h3><button id="mx" aria-label="Close">Close</button></div><div id="mb"></div></div></div>
`;

const JS = `
var $=function(id){return document.getElementById(id)};
var S={symbol:'BTCUSDT',interval:'1h',view:'command',token:'',secForm:'13F-HR',checks:[],audit:[]};
var D={};var reg={};var meta={};var feeds={};var INT_SEC={'1m':60,'3m':180,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'1M':2592000};
var TFS=['1m','5m','15m','1h','4h','1d','1w'];
try{var sv=JSON.parse(sessionStorage.getItem('eti.ctx')||'{}');if(sv.symbol)S.symbol=sv.symbol;if(sv.interval)S.interval=sv.interval;}catch(e){}
function save(){try{sessionStorage.setItem('eti.ctx',JSON.stringify({symbol:S.symbol,interval:S.interval}));}catch(e){}}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function utc(d){return (d||new Date()).toISOString().slice(0,19).replace('T',' ')+' UTC';}
function fmt(n,d){var x=Number(n);if(!isFinite(x))return '—';return x.toLocaleString(undefined,{maximumFractionDigits:d==null?4:d});}
function yn(v){return v===true?'yes':v===false?'no':'not reported';}
function dotc(el,c){$(el).className='dot '+c;}
async function api(path,opt){
 var t0=performance.now(),c=new AbortController(),tm=setTimeout(function(){c.abort();},20000);
 try{
  var r=await fetch(path,Object.assign({cache:'no-store',signal:c.signal},opt||{})),txt=await r.text(),j=null;
  try{j=JSON.parse(txt);}catch(e){}
  if(!r.ok)throw new Error((j&&(j.error||j.message||j.detail))?String(j.error||j.message||j.detail):('HTTP '+r.status));
  if(j===null)throw new Error('response was not JSON');
  return {data:j,ms:Math.round(performance.now()-t0),provider:r.headers.get('x-eti-provider'),failover:r.headers.get('x-eti-failover')==='true'};
 }catch(e){if(e.name==='AbortError')throw new Error('timed out after 20 s');throw e;}
 finally{clearTimeout(tm);}
}
function authHdr(){return S.token?{headers:{Authorization:'Bearer '+S.token}}:{};}
function feed(name,ok,ms,items,err){var f=feeds[name]||(feeds[name]={ok:0,fail:0});if(ok){f.ok++;f.lastOk=Date.now();f.ms=ms;f.items=items;f.err=null;}else{f.fail++;f.err=err;f.lastFail=Date.now();}}
function run(key,fn){
 reg[key]=fn;var b=$('b-'+key),f=$('f-'+key);if(!b)return Promise.resolve();
 b.classList.add('loading');
 return fn().then(function(info){b.classList.remove('loading');if(f)f.textContent='Updated '+utc()+(info&&info.source?' · '+info.source:'')+(info&&info.ms!=null?' · '+info.ms+' ms':'');meta[key]={ok:true,at:Date.now()};})
 .catch(function(e){b.classList.remove('loading');b.innerHTML='<div class="err">Unavailable: '+esc(e.message)+' <button data-retry="'+key+'">Retry</button></div>';if(f)f.textContent='Failed '+utc();meta[key]={ok:false,at:Date.now(),error:e.message};});
}
document.addEventListener('click',function(ev){var t=ev.target;if(t&&t.getAttribute&&t.getAttribute('data-retry')){var k=t.getAttribute('data-retry');if(reg[k])run(k,reg[k]);}});
function openModal(title,html){$('mt').textContent=title;$('mb').innerHTML=html;$('modal').classList.add('open');$('mx').focus();}
function closeModal(){$('modal').classList.remove('open');}
$('mx').onclick=closeModal;$('modal').onclick=function(e){if(e.target===$('modal'))closeModal();};
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
function jsonBox(o){var s='';try{s=JSON.stringify(o,null,2);}catch(e){s=String(o);}if(s.length>12000)s=s.slice(0,12000)+' … (truncated)';return '<pre>'+esc(s)+'</pre>';}

/* ---------- top status ---------- */
async function loadStatus(){
 var ex=await Promise.allSettled([api('/api/execution/status'),api('/api/system/health')]);
 if(ex[0].status==='fulfilled'){var d=ex[0].value.data;S.exec=d;
  if(d.live_trading_enabled){dotc('d-exec','warn');$('t-exec').textContent='Execution: LIVE SWITCH ON'+(d.kill_switch?' · KILL SWITCH ACTIVE':'');}
  else{dotc('d-exec',d.kill_switch?'bad':'ok');$('t-exec').textContent='Execution: PAPER/TESTNET · live disabled'+(d.kill_switch?' · KILL SWITCH ACTIVE':'');}
  if(d.withdrawal_permissions===false){dotc('d-wd','ok');$('t-wd').textContent='Withdrawals: disabled';}else{dotc('d-wd','bad');$('t-wd').textContent='Withdrawals: NOT CONFIRMED DISABLED';}
 }else{dotc('d-exec','bad');$('t-exec').textContent='Execution status unavailable';dotc('d-wd','bad');$('t-wd').textContent='Withdrawals: unverified';}
}
function setMarketPill(state,text){dotc('d-market',state);$('t-market').textContent=text;}
setInterval(function(){$('clock').textContent=utc();},1000);$('clock').textContent=utc();

/* ---------- health ---------- */
function hrow(name,state,detail){return '<tr><td><i class="dot '+state+'"></i></td><td>'+esc(name)+'</td><td class="mut">'+esc(detail)+'</td></tr>';}
reg.health=null;
async function loadHealth(){
 var rs=await Promise.allSettled([api('/api/system/health'),api('/api/execution/status'),api('/api/futures/status'),api('/api/readiness/status'),api('/api/market/diag?symbol='+S.symbol)]);
 var h='<table>';var ms=0;
 var r=rs[0];if(r.status==='fulfilled'){ms=r.value.ms;h+=hrow('Cloudflare Worker','ok','status '+esc(r.value.data.status)+' · '+r.value.ms+' ms');}else h+=hrow('Cloudflare Worker','bad',r.reason.message);
 r=rs[1];if(r.status==='fulfilled'){var d=r.value.data;h+=hrow('Execution gateway','ok','mode '+d.mode+' · live trading '+(d.live_trading_enabled?'ON':'off'));
  h+=hrow('Order safeguards',d.safeguards&&d.safeguards.engine==='in_process'?'ok':'warn',d.safeguards&&d.safeguards.engine==='in_process'?'in-process (no external service); live trading disabled':'not reported');
  h+=hrow('Execution audit log',d.audit_log_configured===true?'ok':'warn',d.audit_log_configured===true?'configured':(d.audit_log_configured===false?'not configured':'not reported'));
  h+=hrow('Kill switch',d.kill_switch?'bad':'ok',d.kill_switch?'ACTIVE: execution blocked':'inactive');
  h+=hrow('Alpaca paper',d.alpaca_paper_configured===true?'ok':'warn',d.alpaca_paper_configured===true?'credentials configured (not connection-tested here)':'not configured');
  h+=hrow('Binance testnet',d.binance_testnet_configured===true?'ok':'warn',d.binance_testnet_configured===true?'credentials configured (not connection-tested here)':'not configured');
 }else h+=hrow('Execution gateway','bad',r.reason.message);
 r=rs[2];if(r.status==='fulfilled'){var f=r.value.data;h+=hrow('Futures testnet gateway',f.enabled?'ok':'warn',(f.enabled?'enabled':'disabled')+' · mode '+f.mode+' · live futures '+(f.live_futures?'ON':'off'));}else h+=hrow('Futures testnet gateway','bad',r.reason.message);
 r=rs[3];if(r.status==='fulfilled'){var m=r.value.data.markets||{};h+=hrow('Crypto price data',String(m.crypto&&m.crypto.priceData).indexOf('connected')===0?'ok':'warn',m.crypto&&m.crypto.priceData);h+=hrow('Forex price data',String(m.forex&&m.forex.priceData).indexOf('connected')===0?'ok':'warn',m.forex&&m.forex.priceData);h+=hrow('Equities price data',String(m.equities&&m.equities.priceData).indexOf('connected')===0?'ok':'warn',m.equities&&m.equities.priceData);}else h+=hrow('Readiness engine','bad',r.reason.message);
 r=rs[4];if(r.status==='fulfilled'){h+=hrow('Market providers (diagnostics)','ok','diagnostic endpoint reachable · '+r.value.ms+' ms');D.diag=r.value.data;}else h+=hrow('Market providers (diagnostics)','bad',r.reason.message);
 h+='</table>';$('b-health').innerHTML=h;D.health=true;return {ms:ms,source:'Worker status endpoints'};
}

/* ---------- market chart ---------- */
function ema(a,p){var o=[],k=2/(p+1);a.forEach(function(v,i){o.push(i?v*k+o[i-1]*(1-k):v);});return o;}
function drawChart(c){
 var cv=$('chart');if(!cv)return;var dpr=window.devicePixelRatio||1,r=cv.getBoundingClientRect();cv.width=r.width*dpr;cv.height=r.height*dpr;var x=cv.getContext('2d');x.scale(dpr,dpr);var w=r.width,h=r.height;x.clearRect(0,0,w,h);
 var vh=h*0.18,ph=h-vh-16;var hi=-Infinity,lo=Infinity,vmax=0;c.forEach(function(k){hi=Math.max(hi,k[2]);lo=Math.min(lo,k[3]);vmax=Math.max(vmax,k[5]);});var pad=(hi-lo)*0.08||1;hi+=pad;lo-=pad;
 var py=function(v){return 8+(hi-v)/(hi-lo)*ph;},bw=w/c.length;
 x.strokeStyle='rgba(99,102,241,.2)';x.lineWidth=1;for(var i=0;i<5;i++){var y=8+i*ph/4;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}
 c.forEach(function(k,i){var up=k[4]>=k[1],col=up?'#10d9a0':'#ff4d6d',xx=i*bw+bw/2;x.strokeStyle=col;x.fillStyle=col;x.beginPath();x.moveTo(xx,py(k[2]));x.lineTo(xx,py(k[3]));x.stroke();var t=py(Math.max(k[1],k[4])),b=py(Math.min(k[1],k[4]));x.fillRect(xx-Math.max(1,bw*0.32),t,Math.max(2,bw*0.64),Math.max(1,b-t));x.globalAlpha=0.45;x.fillRect(xx-Math.max(1,bw*0.32),h-(k[5]/vmax)*vh,Math.max(2,bw*0.64),(k[5]/vmax)*vh);x.globalAlpha=1;});
 var cl=c.map(function(k){return k[4];});[[ema(cl,20),'#22d3ee'],[ema(cl,50),'#f5c542']].forEach(function(p){x.strokeStyle=p[1];x.lineWidth=1.5;x.beginPath();p[0].forEach(function(v,i){var xx=i*bw+bw/2;if(i)x.lineTo(xx,py(v));else x.moveTo(xx,py(v));});x.stroke();});
 x.fillStyle='#8fa6c8';x.font='11px sans-serif';x.fillText(fmt(hi),4,12);x.fillText(fmt(lo),4,ph+6);x.fillStyle='#22d3ee';x.fillText('EMA20',w-120,12);x.fillStyle='#f5c542';x.fillText('EMA50',w-66,12);
}
async function loadMarket(){
 var q='symbol='+encodeURIComponent(S.symbol);
 var k;try{k=await api('/api/market/klines?'+q+'&interval='+encodeURIComponent(S.interval)+'&limit=120');}catch(e){setMarketPill('bad','Market feed: UNAVAILABLE');throw e;}
 var rows=k.data;if(!Array.isArray(rows)||!rows.length){setMarketPill('bad','Market feed: no candles');throw new Error('klines returned no candles');}
 var c=rows.map(function(v){return v.map(Number);});D.candles=c;
 var last=c[c.length-1],age=Math.max(0,Math.round((Date.now()-last[0])/1000)),lim=(INT_SEC[S.interval]||3600)*3,stale=age>lim;
 var pq='&provider='+encodeURIComponent(k.provider||'');
 var rs=await Promise.allSettled([api('/api/market/ticker?'+q+pq),api('/api/market/depth?'+q+'&limit=20'+pq)]);
 var tk=rs[0].status==='fulfilled'?rs[0].value.data:null,dp=rs[1].status==='fulfilled'?rs[1].value.data:null;
 var chg=tk&&isFinite(Number(tk.priceChangePercent))?Number(tk.priceChangePercent):null;
 var bid=dp&&dp.bids&&dp.bids[0]?Number(dp.bids[0][0]):null,ask=dp&&dp.asks&&dp.asks[0]?Number(dp.asks[0][0]):null;
 var html='<div class="row" style="margin-bottom:6px"><b style="font-size:20px">'+fmt(last[4])+'</b><span class="'+(chg==null?'mut':chg>=0?'pos':'neg')+'">'+(chg==null?'24h change unavailable':(chg>=0?'+':'')+chg.toFixed(2)+'% 24h')+'</span><span class="mut">Bid '+(bid==null?'—':fmt(bid))+' · Ask '+(ask==null?'—':fmt(ask))+' · Spread '+(bid!=null&&ask!=null?fmt(ask-bid):'—')+'</span></div>';
 if(stale)html+='<div class="err" style="margin-bottom:6px">STALE: latest candle is '+Math.round(age/60)+' min old (limit '+Math.round(lim/60)+' min). Do not trade on this data.</div>';
 html+='<div class="chart"><canvas id="chart" aria-label="Candlestick chart"></canvas></div>';
 $('b-market').innerHTML=html;drawChart(c);
 $('mk-meta').textContent=k.provider?('via '+k.provider+(k.failover?' (failover)':'')):'';
 setMarketPill(stale?'warn':'ok',stale?'Market feed: STALE · latest candle opened '+Math.round(age/60)+' min ago':'Market feed: fresh · '+(k.provider||'?')+(k.failover?' (failover)':'')+' · latest candle opened '+Math.round(age/60)+' min ago');
 feed('market klines',true,k.ms,c.length);
 return {ms:k.ms,source:(k.provider||'provider')+(k.failover?' (failover)':'')+' · REST'+(rs.some(function(r){return r.status==='rejected';})?' · partial: ticker/depth unavailable':'')};
}

/* ---------- signal ---------- */
function lvl(l,label,v){return '<tr><td>'+label+'</td><td>'+(v==null?'—':fmt(v))+'</td></tr>';}
async function loadSignal(){
 var r=await api('/api/signals?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval));var d=r.data;D.signal=d;
 var tradeable=d.tradeable===true,col=d.label==='BUY'?'pos':'neg';
 var h='<div class="decision '+(tradeable?col:'mut')+'">'+(tradeable?esc(d.label):'NO TRADE')+'</div>';
 h+='<div class="mut">'+esc(d.symbol)+' · '+esc(d.interval)+' · conviction <b>'+esc(String(d.conviction).toUpperCase())+'</b> · regime '+esc(d.regime&&d.regime.state)+'</div>';
 if(!tradeable)h+='<div class="empty" style="margin:8px 0">The quality gate stands aside. Directional lean: <b class="'+col+'">'+esc(d.label)+'</b> at '+esc(d.conviction)+' conviction. Levels below are reference only, not a recommendation.</div>';
 h+='<table>'+lvl(0,tradeable?'Entry':'Reference entry',d.entry)+lvl(0,'Stop loss',d.stopLoss)+(d.targets||[]).map(function(t){return lvl(0,'Take-profit '+t.target+' ('+t.rewardRisk+'R)',t.price);}).join('')+'</table>';
 var v=d.historicalValidation||{};
 h+='<div class="foot">Confluence score '+esc(d.score)+' (heuristic, not a probability). Replay win rate on this chart: '+(v.winRate==null?'withheld (n='+esc(v.sampleCount)+', under 20)':esc(v.winRate)+'% (n='+esc(v.sampleCount)+')')+'. Simulation excludes fees and slippage.</div>';
 var ps=d.positionSizing;h+='<div class="foot">Sizing: '+(ps&&ps.suggestedRiskPercent>0?'up to '+esc(ps.suggestedRiskPercent)+'% of equity at risk':'none suggested')+(ps?' ('+esc(ps.basis)+')':'')+'</div>';
 h+='<div class="seg"><button id="sigMore">View analysis</button></div><div id="sigDetail" style="display:none"></div>';
 $('b-signal').innerHTML=h;
 $('sigMore').onclick=function(){var el=$('sigDetail');if(el.style.display==='none'){el.style.display='block';el.innerHTML='<b>Evidence</b><ul>'+(d.evidence||[]).map(function(e){return '<li>'+esc(e)+'</li>';}).join('')+'</ul><b>Strategy attribution</b><div class="scroll" style="max-height:220px"><table>'+(d.strategyAttribution||[]).map(function(a){return '<tr><td>'+esc(a.trader)+'</td><td>'+esc(a.contribution)+'</td></tr>';}).join('')+'</table></div><b>Invalidation</b><ul>'+(d.invalidation||[]).map(function(e){return '<li>'+esc(e)+'</li>';}).join('')+'</ul>';}else el.style.display='none';};
 feed('signal engine',true,r.ms,1);
 return {ms:r.ms,source:'ETI signal engine · '+(d.provider||'')};
}

/* ---------- paper account + history ---------- */
async function loadKpi(){
 if(!S.token){$('b-kpi').innerHTML='<div class="empty">Enter the paper-trading token to load the simulated account. No figures are shown without a real account response.</div>';return {source:'not loaded'};}
 var rs=await Promise.allSettled([api('/api/paper/status',authHdr()),api('/api/paper/performance',authHdr())]);
 if(rs[0].status==='rejected')throw new Error(rs[0].reason.message==='unauthorized'?'token rejected (unauthorized)':rs[0].reason.message);
 var s=rs[0].value.data,p=rs[1].status==='fulfilled'?rs[1].value.data:null;D.paper=s;
 var wins=p&&p.windows?Object.keys(p.windows):[];var w=S.win&&wins.indexOf(S.win)>=0?S.win:(wins.indexOf('All')>=0?'All':wins[0]);var rep=w?p.windows[w]:null;
 var pct=function(x){return x==null?'—':(x*100).toFixed(1)+'%';};
 var h='<div class="kpis"><div class="kpi"><small>Equity (simulated)</small><b>'+fmt(s.equity,2)+'</b></div><div class="kpi"><small>Starting equity</small><b>'+fmt(s.startingEquity,2)+'</b></div><div class="kpi"><small>Open positions</small><b>'+esc(Array.isArray(s.openPositions)?s.openPositions.length:(s.openPositions&&typeof s.openPositions==='object'?Object.keys(s.openPositions).length:'—'))+'</b></div><div class="kpi"><small>Closed trades</small><b>'+esc(s.closedTrades)+'</b></div><div class="kpi"><small>Kill switch</small><b class="'+(s.killSwitch?'neg':'pos')+'">'+(s.killSwitch?'ACTIVE':'off')+'</b></div></div>';
 if(rep){h+='<div class="seg">'+wins.map(function(k){return '<button data-win="'+esc(k)+'" class="'+(k===w?'on':'')+'">'+esc(k)+'</button>';}).join('')+'</div><div class="kpis"><div class="kpi"><small>Net P/L ('+esc(w)+')</small><b class="'+(rep.netPnl>=0?'pos':'neg')+'">'+fmt(rep.netPnl,2)+'</b></div><div class="kpi"><small>Win rate</small><b>'+(rep.winRate==null?'withheld':pct(rep.winRate))+'</b><small>'+esc(rep.wins)+' wins / '+esc(rep.trades)+' trades</small></div><div class="kpi"><small>Profit factor</small><b>'+(rep.profitFactor==null?'withheld':fmt(rep.profitFactor,2))+'</b></div><div class="kpi"><small>Max drawdown</small><b class="neg">'+pct(rep.maxDrawdownPct)+'</b></div></div><div class="foot">'+esc(rep.note||'')+' '+esc(p.disclosure||'')+'</div>';}
 else h+='<div class="empty" style="margin-top:8px">Performance report unavailable.</div>';
 $('b-kpi').innerHTML=h;$('b-kpi').querySelectorAll('button[data-win]').forEach(function(b){b.onclick=function(){S.win=b.getAttribute('data-win');run('kpi',loadKpi);};});
 return {ms:rs[0].value.ms,source:'paper trading engine (SIMULATED)'};
}
async function loadHistory(){
 if(!S.token){$('b-history').innerHTML='<div class="empty">Enter the token above to load execution history.</div>';return {source:'not loaded'};}
 var r=await api('/api/execution/history',authHdr());var recs=r.data.records||[];
 if(!recs.length){$('b-history').innerHTML='<div class="empty">No ETI execution records found.</div>';return {ms:r.ms,source:'execution audit log'};}
 $('b-history').innerHTML='<div class="scroll"><table><tr><th>Time (UTC)</th><th>Broker / mode</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Initiator</th><th>Order ID</th></tr>'+recs.map(function(v){var s=v.executionSource||{};return '<tr><td>'+esc(v.executedAt)+'</td><td>'+esc(v.broker)+' / '+esc(v.mode)+'</td><td>'+esc(v.symbol)+'</td><td class="'+(v.side==='buy'?'pos':'neg')+'">'+esc(v.side)+'</td><td>'+esc(v.quantity)+'</td><td>'+esc(s.sourceName)+' ('+esc(s.actorId)+')</td><td>'+esc(v.brokerOrderId||v.clientOrderId)+'</td></tr>';}).join('')+'</table></div>';
 return {ms:r.ms,source:'execution audit log'};
}
async function loadLimits(){
 if(!S.token)return {source:'not loaded'};var r=await api('/api/paper/status',authHdr());var c=r.data.config||{};
 $('b-limits').innerHTML='<table>'+Object.keys(c).map(function(k){return '<tr><td>'+esc(k)+'</td><td>'+esc(typeof c[k]==='object'?JSON.stringify(c[k]):c[k])+'</td></tr>';}).join('')+'</table><div class="foot">Read-only. Limits are enforced server-side by the paper engine and the in-process order safeguards, never by this page.</div>';
 return {ms:r.ms,source:'paper trading engine'};
}

/* ---------- intelligence ---------- */
function secTabs(){var forms=['13F-HR','4','SC 13D','SC 13G','8-K'];$('secTabs').innerHTML=forms.map(function(f){return '<button data-sf="'+esc(f)+'" class="'+(f===S.secForm?'on':'')+'">'+esc(f==='4'?'Form 4':f)+'</button>';}).join('');$('secTabs').querySelectorAll('button').forEach(function(b){b.onclick=function(){S.secForm=b.getAttribute('data-sf');secTabs();run('sec',loadSec);};});}
async function loadSec(){
 var r;try{r=await api('/api/intel/sec?form='+encodeURIComponent(S.secForm)+'&count=25');}catch(e){feed('SEC EDGAR',false,0,0,e.message);throw e;}
 var d=r.data;D.sec=d;feed('SEC EDGAR',true,r.ms,d.count);
 $('b-sec').innerHTML=(d.items.length?'<table><tr><th>Form</th><th>Filer</th><th>Filed</th><th>Accepted (UTC)</th></tr>'+d.items.map(function(i){return '<tr><td>'+esc(i.form)+'</td><td>'+(i.url?'<a href="'+esc(i.url)+'" target="_blank" rel="noopener noreferrer">'+esc(i.company)+'</a>':esc(i.company))+(i.role?' <span class="mut">('+esc(i.role)+')</span>':'')+'</td><td>'+esc(i.filedDate||'—')+'</td><td>'+esc(i.acceptedAt||'—')+'</td></tr>';}).join('')+'</table>':'<div class="empty">No filings returned.</div>')+'<div class="foot">'+esc(d.caveat)+'</div>';
 return {ms:r.ms,source:'SEC EDGAR · '+d.count+' filings'};
}
async function loadResearch(){
 var r;try{r=await api('/api/intel/research?count=15');}catch(e){feed('arXiv q-fin',false,0,0,e.message);throw e;}
 var d=r.data;D.research=d;feed('arXiv q-fin',true,r.ms,d.count);
 $('b-research').innerHTML=(d.items.length?d.items.map(function(i){return '<div style="margin-bottom:10px"><a href="'+esc(i.id)+'" target="_blank" rel="noopener noreferrer"><b>'+esc(i.title)+'</b></a><div class="mut">'+esc(i.authors.join(', '))+' · '+esc(i.category||'')+' · '+esc(String(i.published).slice(0,10))+'</div></div>';}).join(''):'<div class="empty">No papers returned.</div>')+'<div class="foot">'+esc(d.caveat)+'</div>';
 return {ms:r.ms,source:'arXiv · '+d.count+' papers'};
}
async function loadProviders(){
 var r=await api('/api/agents/providers?symbol='+encodeURIComponent(S.symbol));var ps=r.data.providers||[];feed('news and macro providers',ps.some(function(p){return p.ok;}),r.ms,ps.length,ps.every(function(p){return !p.ok;})?'all providers failed':null);
 $('b-providers').innerHTML='<table><tr><th></th><th>Provider</th><th>Detail</th><th>Latency</th></tr>'+ps.map(function(p){return '<tr><td><i class="dot '+(p.ok?'ok':'bad')+'"></i></td><td>'+esc(p.provider)+'</td><td class="mut">'+esc(p.ok?(p.items!=null?p.items+' items':'ok'):p.detail)+'</td><td>'+esc(p.latencyMs)+' ms</td></tr>';}).join('')+'</table><div class="foot">Each dot reflects a fetch made just now. Sentiment is not scored here: this panel only reports source availability.</div>';
 return {ms:r.ms,source:'agents provider check'};
}
async function loadReadiness(){
 var r=await api('/api/readiness/status');var d=r.data,ec=d.economicCalendar||{};
 $('b-readiness').innerHTML='<table><tr><td><i class="dot '+(ec.status==='ok'||ec.status==='configured'?'ok':'warn')+'"></i></td><td>Economic calendar</td><td class="mut">'+esc(ec.status)+' · '+esc(ec.events)+' events'+(ec.configure?' · '+esc(ec.configure):'')+'</td></tr></table><div class="foot">No calendar events are shown unless a feed is configured. Nothing here is invented.</div>';
 return {ms:r.ms,source:'readiness engine'};
}
function loadFeeds(){
 var names=Object.keys(feeds);
 $('b-feeds').innerHTML=names.length?'<table><tr><th></th><th>Feed</th><th>Last success</th><th>Latency</th><th>Items</th><th>OK / failed</th><th>Last error</th></tr>'+names.map(function(n){var f=feeds[n];var st=f.err?(f.ok?'warn':'bad'):'ok';return '<tr><td><i class="dot '+st+'"></i></td><td>'+esc(n)+'</td><td>'+(f.lastOk?esc(utc(new Date(f.lastOk))):'never')+'</td><td>'+esc(f.ms==null?'—':f.ms+' ms')+'</td><td>'+esc(f.items==null?'—':f.items)+'</td><td>'+f.ok+' / '+f.fail+'</td><td class="mut">'+esc(f.err||'')+'</td></tr>';}).join('')+'</table>':'<div class="empty">No feed jobs have run yet this session.</div>';
}
reg.feeds=null;

/* ---------- security ---------- */
function gauge(score,level){var c=level==='CRITICAL'?'#ff4d6d':level==='HIGH'?'#ff9f43':level==='MEDIUM'?'#f5c542':level==='LOW'?'#10d9a0':'#8fa6c8';var s=score==null?0:score;return '<svg viewBox="0 0 120 74" width="150" role="img" aria-label="Risk score '+(score==null?'unknown':s+' of 100')+'"><path d="M10 64 A50 50 0 0 1 110 64" pathLength="100" fill="none" stroke="rgba(143,166,200,.25)" stroke-width="10" stroke-linecap="round"/><path d="M10 64 A50 50 0 0 1 110 64" pathLength="100" fill="none" stroke="'+c+'" stroke-width="10" stroke-linecap="round" stroke-dasharray="'+s+' 100"/><text x="60" y="52" text-anchor="middle" fill="#e8f1ff" font-size="20" font-weight="700">'+(score==null?'?':s)+'</text><text x="60" y="68" text-anchor="middle" fill="'+c+'" font-size="9" font-weight="700">'+esc(level)+'</text></svg>';}
function threats(){
 var cnt={CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0,UNKNOWN:0};S.checks.forEach(function(c){cnt[c.level]=(cnt[c.level]||0)+1;});
 var h='<div class="kpis">'+['CRITICAL','HIGH','MEDIUM','LOW','UNKNOWN'].map(function(k){return '<div class="kpi"><small>'+k+'</small><b>'+cnt[k]+'</b></div>';}).join('')+'</div>';
 h+=S.checks.length?'<div class="scroll" style="margin-top:8px"><table><tr><th>Time</th><th>Chain</th><th>Token</th><th>Level</th><th>Score</th></tr>'+S.checks.slice().reverse().map(function(c){return '<tr><td>'+esc(c.at)+'</td><td>'+esc(c.chain)+'</td><td>'+esc(c.name)+' <span class="mut">'+esc(c.address.slice(0,10))+'…</span></td><td><span class="sev '+esc(c.level)+'">'+esc(c.level)+'</span></td><td>'+esc(c.score==null?'?':c.score)+'</td></tr>';}).join('')+'</table></div>':'<div class="empty" style="margin-top:8px">No tokens checked yet this session. Counts above come only from checks you ran.</div>';
 $('b-threats').innerHTML=h;
}
async function checkToken(chain,address){
 $('b-token').classList.add('loading');
 try{
  var r=await api('/api/intel/security/token?chain='+encodeURIComponent(chain)+'&address='+encodeURIComponent(address));var d=r.data;
  feed('GoPlus token security',true,r.ms,d.findings?d.findings.length:0);
  S.checks.push({at:utc().slice(11,19),chain:d.chainName,address:d.address,name:d.tokenSymbol||d.tokenName||'unnamed',level:d.level,score:d.score});
  var h='<div class="row">'+gauge(d.score,d.level)+'<div><div><b>'+esc(d.tokenName||'Unnamed token')+'</b> '+(d.tokenSymbol?'('+esc(d.tokenSymbol)+')':'')+'</div><div class="mut">'+esc(d.chainName)+' · '+esc(d.address)+'</div><div style="margin-top:6px"><span class="sev '+esc(d.level)+'">'+esc(d.level)+'</span> '+(d.liquidityUsd!=null?'liquidity $'+fmt(d.liquidityUsd,0):'liquidity unknown')+(d.lockedLiquidityPct!=null?' · locked LP '+d.lockedLiquidityPct+'%':'')+'</div></div></div>';
  h+='<div class="empty" style="margin:8px 0"><b>Recommended action:</b> '+esc(d.recommendedAction)+'</div>';
  h+=d.findings&&d.findings.length?'<table><tr><th>Severity</th><th>Finding</th><th>Evidence</th></tr>'+d.findings.map(function(f){return '<tr><td><span class="sev '+esc(f.severity)+'">'+esc(f.severity)+'</span></td><td>'+esc(f.title)+'</td><td class="mut">'+esc(f.evidence)+'</td></tr>';}).join('')+'</table>':'<div class="mut">No findings in the provider data.</div>';
  if(d.unknown&&d.unknown.length)h+='<div class="foot">Unknown (not treated as safe): '+esc(d.unknown.join(', '))+'</div>';
  h+='<div class="foot">Source: '+esc(d.source)+' · checked '+esc(d.fetchedAt)+'. '+esc(d.confidence)+'</div>';
  $('b-token').innerHTML=h;$('f-token').textContent='Checked '+utc()+' · '+r.ms+' ms';
 }catch(e){feed('GoPlus token security',false,0,0,e.message);$('b-token').innerHTML='<div class="err">Check failed: '+esc(e.message)+'. A failed check is not a clean result.</div>';}
 $('b-token').classList.remove('loading');threats();
}
async function loadDex(){
 var r;try{r=await api('/api/intel/dex/latest');}catch(e){feed('DexScreener',false,0,0,e.message);throw e;}
 var d=r.data;feed('DexScreener',true,r.ms,d.count);
 $('b-dex').innerHTML=(d.items.length?'<table><tr><th>Chain</th><th>Address</th><th>Description</th><th></th></tr>'+d.items.map(function(i,n){return '<tr><td>'+esc(i.chain)+'</td><td class="mut">'+esc(i.address.slice(0,12))+'…</td><td>'+esc(i.description)+'</td><td>'+(i.checkChain?'<button data-dx="'+n+'">Check</button>':'<span class="mut">EVM only</span>')+'</td></tr>';}).join('')+'</table>':'<div class="empty">No token profiles returned.</div>')+'<div class="foot">'+esc(d.caveat)+'</div>';
 $('b-dex').querySelectorAll('button[data-dx]').forEach(function(b){b.onclick=function(){var i=d.items[Number(b.getAttribute('data-dx'))];$('chain').value=i.checkChain;$('addr').value=i.address;checkToken(i.checkChain,i.address);};});
 return {ms:r.ms,source:'DexScreener · '+d.count+' profiles'};
}

/* ---------- elite traders ---------- */
var TR=[];
async function loadElite(){
 var q=$('elq').value.trim();var r=await api('/api/intelligence/traders'+(q?'?q='+encodeURIComponent(q):''));var d=r.data;TR=d.profiles||[];
 $('el-meta').textContent=(d.count==null?TR.length:d.count)+' profiles · '+(d.source||'');
 $('b-elist').innerHTML=TR.length?TR.map(function(t){return '<div><button style="width:100%;text-align:left;margin:2px 0" data-tid="'+esc(t.id)+'">'+esc(t.name)+'</button></div>';}).join(''):'<div class="empty">No matches.</div>';
 $('b-elist').querySelectorAll('button[data-tid]').forEach(function(b){b.onclick=function(){showTrader(b.getAttribute('data-tid'));};});
 if(TR.length&&!S.trader)showTrader(TR[0].id);
 return {ms:r.ms,source:d.source};
}
function nt(v){if(v==null||v==='')return '—';if(Array.isArray(v))return v.map(nt).join('; ');if(typeof v==='object')return '['+esc(v.classification||'')+'] '+esc(v.claim||'')+(v.source?' — '+esc(v.source):' — no source recorded');return esc(v);}
async function showTrader(id){
 S.trader=id;$('b-eprof').innerHTML='<div class="mut">Loading…</div>';
 try{var r=await api('/api/intelligence/traders/'+encodeURIComponent(id));var p=r.data.profile,c=r.data.completeness||{},f=r.data.netWorthFreshness||{};
  var rows=[['Philosophy',p.philosophy],['Markets',p.markets_traded],['Entry criteria',p.entry_criteria],['Exit criteria',p.exit_criteria],['Stop-loss',p.stop_loss_methodology],['Position sizing',p.position_sizing],['Risk to reward',p.risk_reward],['Avoid trading when',p.avoid_conditions],['Historical returns',p.historical_returns],['Historical drawdowns',p.historical_drawdowns],['Win rates',p.win_rates],['Net worth',p.net_worth],['Famous successful trades',p.famous_successful_trades],['Famous unsuccessful trades',p.famous_unsuccessful_trades],['Strengths',p.strengths],['Weaknesses',p.weaknesses],['Lessons for ETI',p.eti_lessons],['Strategy modules',p.strategy_module_ids]];
  $('b-eprof').innerHTML='<div style="font-size:18px"><b>'+esc(p.full_name)+'</b></div><div class="mut">Fields: '+esc(c.fieldsPresent)+' / '+esc(c.fieldsRequired)+' · net worth '+esc(r.data.netWorthStatus)+' · as of '+esc(f.asOf)+(f.stale?' · STALE':'')+'</div>'+rows.map(function(x){return '<div style="margin:8px 0"><b>'+esc(x[0])+'</b><div class="mut">'+nt(x[1])+'</div></div>';}).join('');
 }catch(e){$('b-eprof').innerHTML='<div class="err">Could not load profile: '+esc(e.message)+'</div>';}
}

/* ---------- agents ---------- */
async function loadAgents(){
 var r=await api('/api/agents');var ag=r.data.agents||[];D.agents=ag;$('ag-meta').textContent=ag.length+' agents defined';
 $('b-agents').innerHTML='<div class="grid">'+ag.map(function(a){return '<div class="card c4"><b>'+esc(a.number)+'. '+esc(a.name)+'</b><div class="mut" style="margin:4px 0">'+esc(a.mandate)+'</div><div class="foot">Inputs: '+esc((a.inputs||[]).join(', '))+(a.externalDataRequired?'<br>Needs external data: '+esc(a.externalDataRequired):'')+'<br>Status: defined. Runs when you start an analysis.</div></div>';}).join('')+'</div>';
 return {ms:r.ms,source:'agent roster'};
}
function findReports(o,depth){if(!o||typeof o!=='object'||depth>4)return null;if(Array.isArray(o)){if(o.length&&o[0]&&o[0].agent&&o[0].stance)return o;for(var i=0;i<o.length;i++){var f=findReports(o[i],depth+1);if(f)return f;}return null;}for(var k in o){var g=findReports(o[k],depth+1);if(g)return g;}return null;}
async function runAnalysis(){
 $('b-agrun').innerHTML='<div class="mut">Running analysis…</div>';
 try{var r=await api('/api/agents/analyze?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval));var d=r.data;D.analysis=d;feed('agent analysis',true,r.ms,1);
  var reps=Array.isArray(d.reports)&&d.reports.length?d.reports:findReports(d,0);var dec=(d.decision&&typeof d.decision==='object')?d.decision:{action:d.decision};var h='<div class="row"><span class="pill">Decision: <b>'+esc(dec.action||'see raw response')+'</b></span><span class="pill">consensus confidence '+esc(dec.confidence==null?'—':dec.confidence)+' (heuristic)</span><span class="mut">'+esc(S.symbol)+' · '+esc(S.interval)+' · '+r.ms+' ms · '+esc(utc())+'</span></div>';
  if(reps)h+='<div class="grid" style="margin-top:8px">'+reps.map(function(a){var c=a.stance==='bullish'?'pos':a.stance==='bearish'?'neg':'mut';return '<div class="card c4"><b>'+esc(a.agent)+'</b> <span class="'+c+'">'+esc(a.stance)+'</span><div class="mut">status '+esc(a.status==null?'not reported':a.status)+' · confidence '+esc(a.confidence==null?'—':Number(a.confidence).toFixed(2))+' (heuristic)</div><div style="margin-top:4px">'+esc(a.summary)+'</div>'+(a.missingInputs&&a.missingInputs.length?'<div class="foot">Missing inputs: '+esc(a.missingInputs.join(', '))+'</div>':'')+'</div>';}).join('')+'</div>';
  h+='<div class="seg"><button id="agRaw">Show raw response</button></div>';$('b-agrun').innerHTML=h;$('agRaw').onclick=function(){openModal('Raw agent analysis',jsonBox(d));};
 }catch(e){feed('agent analysis',false,0,0,e.message);$('b-agrun').innerHTML='<div class="err">Analysis unavailable: '+esc(e.message)+'. No agent output is shown because none was produced.</div>';}
}

/* ---------- risk ---------- */
async function loadRisk(){
 var rs=await Promise.allSettled([api('/api/execution/status'),api('/api/futures/status')]);if(rs[0].status==='rejected')throw new Error(rs[0].reason.message);
 var d=rs[0].value.data,f=rs[1].status==='fulfilled'?rs[1].value.data:null;
 var rows=[['Execution mode',d.mode],['Live trading available',d.live_trading_available],['Safeguards',d.safeguards&&d.safeguards.engine],['Max order quantity',d.safeguards&&d.safeguards.max_order_quantity],['Duplicate window (s)',d.safeguards&&d.safeguards.duplicate_window_seconds],['External risk gateway',d.external_risk_gateway],['Readiness gate',d.readiness_gate],['Kill switch',d.kill_switch],['Audit log configured',d.audit_log_configured],['Withdrawal permissions enabled',d.withdrawal_permissions],['Alpaca paper configured',d.alpaca_paper_configured],['Binance testnet configured',d.binance_testnet_configured]];
 if(f){rows.push(['Futures testnet enabled',f.enabled],['Futures credentials configured',f.credentials_configured],['Futures caps configured',f.caps_configured],['Futures hard leverage cap',f.max_leverage_hard_cap],['Futures risk gate configured',f.risk_gate_configured],['Live futures',f.live_futures]);}
 var show=function(v){return v===true?'yes':v===false?'no':(v==null?'not reported':String(v));};
 $('b-risk').innerHTML='<table>'+rows.map(function(r){return '<tr><td>'+esc(r[0])+'</td><td><b>'+esc(show(r[1]))+'</b></td></tr>';}).join('')+'</table><div class="foot">Read-only view. Live trading can only be activated through the separate authenticated process; no button here can do it.</div>';
 return {ms:rs[0].value.ms,source:'execution status endpoints'};
}

/* ---------- quick actions ---------- */
function log(step,ok,ms,detail){S.audit.push({at:utc(),step:step,ok:ok,ms:ms,detail:detail});}
async function execIntel(){
 var btn=$('qa-exec');btn.disabled=true;btn.textContent='Running…';S.audit=[];
 var steps=[['Market candles','/api/market/klines?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval)+'&limit=5'],['Signal engine','/api/signals?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval)],['Agent analysis (read-only)','/api/agents/analyze?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval)],['Readiness','/api/readiness/status'],['Execution status','/api/execution/status']];
 for(var i=0;i<steps.length;i++){try{var r=await api(steps[i][1]);log(steps[i][0],true,r.ms,'ok');}catch(e){log(steps[i][0],false,0,e.message);}}
 var okc=S.audit.filter(function(a){return a.ok;}).length;
 openModal('ETI Execute Intelligence: cycle report','<div class="mut">Analysis only. This cycle submits no orders. Log is kept in this browser session; server-side request logs are in Cloudflare observability.</div><table><tr><th>Time</th><th>Step</th><th>Result</th><th>Latency</th></tr>'+S.audit.map(function(a){return '<tr><td>'+esc(a.at)+'</td><td>'+esc(a.step)+'</td><td class="'+(a.ok?'pos':'neg')+'">'+(a.ok?'OK':'FAILED: '+esc(a.detail))+'</td><td>'+(a.ok?a.ms+' ms':'—')+'</td></tr>';}).join('')+'</table><div class="foot">'+okc+' of '+S.audit.length+' steps succeeded.</div>');
 btn.disabled=false;btn.textContent='ETI Execute Intelligence';refreshView();
}
async function autoStatus(){
 var ex=S.exec||null;var h='<table><tr><td>Environment</td><td><b>'+(ex?(ex.live_trading_enabled?'LIVE SWITCH ON':'PAPER / TESTNET (live disabled)'):'unknown (status unavailable)')+'</b></td></tr><tr><td>Live activation</td><td>'+(ex?(ex.live_activation_configured?'configured (separate secret required per order)':'not configured'):'unknown')+'</td></tr></table>';
 if(S.token){try{var r=await api('/api/paper/status',authHdr());var sc=r.data.scheduler||{};h+='<table><tr><td>Paper auto-execute</td><td><b>'+(sc.autoExecute?'ON':'OFF')+'</b></td></tr><tr><td>Scheduled symbols</td><td>'+esc((sc.symbols||[]).join(', ')||'none')+'</td></tr><tr><td>Last scheduled run</td><td>'+esc(sc.lastRun?JSON.stringify(sc.lastRun):'none recorded')+'</td></tr></table>';}catch(e){h+='<div class="err">Paper status unavailable: '+esc(e.message)+'</div>';}}
 else h+='<div class="empty">Enter the paper-trading token on the Trading Dashboard to see auto-execute state.</div>';
 openModal('Auto Trade status',h+'<div class="foot">Auto-trading is configured on the server and cannot be switched on from this page. No dashboard control can enable live trading.</div>');
}
async function backtest(){
 openModal('Backtest: '+S.symbol+' '+S.interval,'<div class="mut">Running backtest on live candles…</div>');
 try{var r=await api('/api/algo/backtest?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval));$('mb').innerHTML='<div class="mut">Simulation on historical candles with fees and slippage. Not a forecast. '+r.ms+' ms</div>'+jsonBox(r.data);}
 catch(e){$('mb').innerHTML='<div class="err">Backtest unavailable: '+esc(e.message)+'</div>';}
}
async function compare(){
 openModal('Compare strategies','<div class="mut">Loading…</div>');
 try{var r=await api('/api/intelligence/strategies');var m=r.data.modules||[];$('mb').innerHTML='<div class="scroll" style="max-height:60vh"><table><tr><th>Module</th><th>Inspired by</th><th>Family</th><th>Runs on candles</th><th>Needs</th></tr>'+m.map(function(x){return '<tr><td>'+esc(x.name)+'</td><td>'+esc(x.inspiredBy)+'</td><td>'+esc(x.family)+'</td><td class="'+(x.candleTestable?'pos':'mut')+'">'+(x.candleTestable?'yes':'no')+'</td><td class="mut">'+esc(x.requires||'')+'</td></tr>';}).join('')+'</table></div><ul>'+(r.data.combinationRules||[]).map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';}
 catch(e){$('mb').innerHTML='<div class="err">Unavailable: '+esc(e.message)+'</div>';}
}
function exportReport(){
 var rep={schema:'eti.command-centre.report/1',generatedAt:new Date().toISOString(),context:{symbol:S.symbol,interval:S.interval},panelStatus:meta,feeds:feeds,signal:D.signal||null,agentAnalysis:D.analysis||null,agentsDefined:D.agents?D.agents.length:null,secFilings:D.sec?{form:D.sec.form,count:D.sec.count,fetchedAt:D.sec.fetchedAt}:null,research:D.research?{count:D.research.count,fetchedAt:D.research.fetchedAt}:null,tokenChecks:S.checks,executeIntelligenceLog:S.audit,notes:'Only data returned by live endpoints during this session. Missing sections were not loaded.'};
 var blob=new Blob([JSON.stringify(rep,null,2)],{type:'application/json'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='eti-report-'+new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')+'.json';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);
}

/* ---------- views ---------- */
var VIEWS=['command','trading','intel','security','elite','agents','risk'];
var LOADERS={
 command:function(){run('health',loadHealth);overview();},
 trading:function(){run('market',loadMarket);run('signal',loadSignal);run('kpi',loadKpi);run('history',loadHistory);},
 intel:function(){secTabs();run('sec',loadSec);run('research',loadResearch);run('providers',loadProviders);run('readiness',loadReadiness);setTimeout(loadFeeds,2500);},
 security:function(){threats();run('dex',loadDex);},
 elite:function(){run('elist',loadElite);},
 agents:function(){run('agents',loadAgents);},
 risk:function(){run('risk',loadRisk);run('limits',loadLimits);}
};
reg.elist=null;
async function overview(){
 var a=await Promise.allSettled([api('/api/signals?symbol='+encodeURIComponent(S.symbol)+'&interval='+encodeURIComponent(S.interval)),api('/api/intel/sec?form=13F-HR&count=25'),api('/api/intel/research?count=15')]);
 var t=a[0].status==='fulfilled'?(a[0].value.data.tradeable?a[0].value.data.label:'NO TRADE')+' on '+S.symbol+' ('+S.interval+', '+a[0].value.data.conviction+' conviction)':'signal unavailable: '+a[0].reason.message;
 $('ov-trading').innerHTML='Current decision: <b>'+esc(t)+'</b>. Market feed: '+esc($('t-market').textContent.replace('Market feed: ',''));
 var s=a[1].status==='fulfilled'?a[1].value.data.count+' recent 13F filings':'SEC feed unavailable',p=a[2].status==='fulfilled'?a[2].value.data.count+' recent q-fin papers':'research feed unavailable';
 $('ov-intel').innerHTML='<b>'+esc(s)+'</b> · <b>'+esc(p)+'</b> · '+S.checks.length+' token checks this session';
}
function refreshView(){var f=LOADERS[S.view];if(f)f();}
function showView(v,anchor){
 if(VIEWS.indexOf(v)<0)v='command';S.view=v;
 VIEWS.forEach(function(n){$('v-'+n).classList.toggle('active',n===v);});
 document.querySelectorAll('.nav a.item[data-view]').forEach(function(a){a.classList.toggle('active',a.getAttribute('data-view')===v&&(!a.getAttribute('data-anchor')||a.getAttribute('data-anchor')===anchor));});
 var trading=(v==='trading'||v==='command');var inIntel=(v==='intel'||v==='security');
 $('tagline').textContent=inIntel?'Discover opportunities. Detect threats. Protect capital.':'Profitable. Disciplined. Intelligent.';$('tagline2').textContent=inIntel?'GLOBAL INTELLIGENCE COMMAND CENTRE':'TRADING COMMAND CENTRE';
 refreshView();if(anchor){setTimeout(function(){var el=$(anchor);if(el)el.scrollIntoView({behavior:'smooth',block:'start'});},400);}
}
document.querySelectorAll('.nav a.item[data-view]').forEach(function(a){a.addEventListener('click',function(ev){ev.preventDefault();var v=a.getAttribute('data-view');history.replaceState(null,'','#'+v);showView(v,a.getAttribute('data-anchor'));});});
$('launch-trading').onclick=function(){history.replaceState(null,'','#trading');showView('trading');};
$('launch-intel').onclick=function(){history.replaceState(null,'','#intel');showView('intel');};
['launch-trading','launch-intel'].forEach(function(id){$(id).addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();$(id).click();}});});
window.addEventListener('hashchange',function(){showView((location.hash||'#command').slice(1));});

/* ---------- controls ---------- */
$('tf').innerHTML=TFS.map(function(t){return '<button data-tf="'+t+'" class="'+(t===S.interval?'on':'')+'">'+t+'</button>';}).join('');
$('tf').querySelectorAll('button').forEach(function(b){b.onclick=function(){S.interval=b.getAttribute('data-tf');save();$('tf').querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b);});run('market',loadMarket);run('signal',loadSignal);};});
$('symbol').value=S.symbol;$('symbol').onchange=function(){S.symbol=$('symbol').value;save();if(S.view==='trading'||S.view==='agents'||S.view==='command')refreshView();};
$('tokenGo').onclick=function(){S.token=$('token').value;run('kpi',loadKpi);run('history',loadHistory);if(S.view==='risk')run('limits',loadLimits);};
$('chain').innerHTML='<option value="1">Ethereum</option><option value="56">BNB Chain</option><option value="137">Polygon</option><option value="42161">Arbitrum</option><option value="8453">Base</option><option value="10">Optimism</option><option value="43114">Avalanche</option>';
$('chk').onclick=function(){var a=$('addr').value.trim();if(!a){$('b-token').innerHTML='<div class="err">Enter a contract address.</div>';return;}checkToken($('chain').value,a);};
$('elq').oninput=function(){clearTimeout(window.__elt);window.__elt=setTimeout(function(){S.trader=null;run('elist',loadElite);},300);};
$('agRun').onclick=runAnalysis;
$('qa-exec').onclick=execIntel;$('qa-auto').onclick=autoStatus;$('qa-bt').onclick=backtest;$('qa-cmp').onclick=compare;$('qa-exp').onclick=exportReport;
$('qa-risk').onclick=function(){history.replaceState(null,'','#risk');showView('risk');};
window.addEventListener('resize',function(){if(D.candles&&$('chart'))drawChart(D.candles);});
setInterval(function(){if(document.visibilityState==='visible'&&S.view==='trading')run('market',loadMarket);},30000);
loadStatus();setInterval(loadStatus,60000);
showView((location.hash||'#command').slice(1));
`;

export function commandPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Command Centre</title><style>${CSS}</style></head><body>${BODY}<script>${JS}</script></body></html>`;
}
