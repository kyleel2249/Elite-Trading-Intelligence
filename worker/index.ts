/**
 * ETI Cloudflare-native edge application.
 *
 * The dashboard and lightweight read-only market APIs run directly on Workers.
 * No FastAPI origin / BACKEND_URL is required. Brokerage credentials are never
 * accepted by these public market-data routes.
 */
import { handleExecution } from "./execution";
import type { ExecutionEnv } from "./execution";
import { handleMarket } from "./market";
import { handleSignals } from "./signals";
import type { MarketEnv } from "./market";

export interface Env extends ExecutionEnv, MarketEnv {
  ETI_EDGE?: string;
  MARKET_CACHE?: KVNamespace;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETI — Elite Trading Intelligence</title>
<style>
:root{color-scheme:dark;--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--green:#21d69a;--red:#ff637d;--blue:#56a8ff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 55%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}
header{padding:20px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:22px;margin:0}small,.muted{color:var(--muted)}main{padding:22px 4vw;max-width:1600px;margin:auto}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}input,select,button{background:#0b1422;color:#eaf2ff;border:1px solid var(--line);border-radius:8px;padding:10px}button{cursor:pointer}button.active{border-color:var(--green);color:var(--green)}
.grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:14px}.panel{background:linear-gradient(145deg,#121e30,#0d1624);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.panel h2{font-size:15px;margin:0 0 12px}.chart{height:350px;width:100%}canvas{width:100%;height:100%}.lower{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 5px;text-align:right;border-bottom:1px solid #1d2a3e;font-size:12px}th:first-child,td:first-child{text-align:left}.bid{color:var(--green)}.ask,.sell{color:var(--red)}.buy{color:var(--green)}.status{color:var(--green)}.meta{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);margin:8px 0 14px}.scroll{max-height:360px;overflow:auto}
@media(max-width:850px){.grid,.lower{grid-template-columns:1fr}.chart{height:280px}}

.execution-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.execution-grid label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:12px}.execution-grid input,.execution-grid select{width:100%;min-width:0}.execution-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.execution-actions button{font-weight:650}.btn-buy{background:#123b32;border-color:#1c8d6c;color:#62e6b7}.btn-sell{background:#401e2a;border-color:#a63e58;color:#ff8da0}.btn-live{border-color:#b65c38;color:#ffb08c}.execution-note{font-size:12px;color:var(--muted);line-height:1.5}.execution-output{white-space:pre-wrap;overflow-wrap:anywhere;background:#09111d;border:1px solid var(--line);border-radius:8px;padding:10px;min-height:42px}.history-table{max-height:320px;overflow:auto}
@media(max-width:850px){.execution-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body>
<header><div><h1>ETI <span style="color:var(--blue)">Elite Trading Intelligence</span></h1><small>Market structure • Liquidity • Price discovery</small></div><div id="connection" class="status">Connecting…</div></header>
<main>
<div class="toolbar"><select id="symbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select>
<select id="interval"><option>1m</option><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>1d</option><option>1w</option></select>
<button id="refresh" class="active">Refresh market</button><span class="muted" id="stamp">Waiting for market data…</span></div>
<div class="grid"><section class="panel"><h2>Live Market Chart</h2><div class="meta"><span>Last <b id="last">—</b></span><span>24h volume <b id="volume">—</b></span><span>24h change <b id="change">—</b></span><span>Provider <b id="provider">—</b></span><span id="stale" role="status" style="display:none;color:#ffb08c;border:1px solid #b65c38;border-radius:6px;padding:0 8px"></span></div><div class="chart"><canvas id="chart"></canvas></div></section>
<section class="panel"><h2>Order Book Depth</h2><div class="meta"><span>Bid <b class="bid" id="bid">—</b></span><span>Ask <b class="ask" id="ask">—</b></span><span>Spread <b id="spread">—</b></span></div><div id="book" class="scroll"></div></section></div>
<div class="lower"><section class="panel"><h2>Live Market Trade Tape</h2><div id="trades" class="scroll"></div></section><section class="panel"><h2>Cumulative Market Depth</h2><div class="chart" style="height:220px"><canvas id="depth"></canvas></div><small>Aggregated visible bid and ask liquidity. Not a full exchange order queue.</small></section></div>

<section class="panel" style="margin-top:14px">
<h2>Order Execution</h2>
<div class="meta"><span>Execution status <b id="executionStatus">Checking…</b></span><span>Kill switch <b id="killSwitchStatus">Checking…</b></span></div>
<p class="execution-note">Orders are sent only after you preview and confirm them. Paper/Testnet is the recommended starting mode. Live mode requires the live switch, broker-specific live credentials, the execution token, and the separate live activation secret. Protect this dashboard with Cloudflare Access before entering credentials. Never enter withdrawal or transfer credentials here.</p>
<div class="execution-grid">
<label>Broker<select id="orderBroker"><option value="alpaca">Alpaca</option><option value="binance">Binance</option></select></label>
<label>Mode<select id="orderMode"><option value="paper_testnet">Paper / Testnet</option><option value="live">Live trading</option></select></label>
<label>Symbol<input id="orderSymbol" value="BTCUSDT" maxlength="24" autocomplete="off"></label>
<label>Order type<select id="orderType"><option value="market">Market</option><option value="limit">Limit</option></select></label>
<label>Quantity<input id="orderQuantity" type="number" min="0" step="any" placeholder="Enter quantity"></label>
<label id="limitPriceWrap" style="display:none">Limit price<input id="orderLimitPrice" type="number" min="0" step="any" placeholder="Enter limit price"></label>
<label>Time in force<select id="orderTif"><option value="gtc">GTC</option><option value="day">DAY (Alpaca)</option><option value="ioc">IOC (Binance)</option></select></label>
<label>Operator ID<input id="operatorId" value="dashboard-operator" maxlength="80"></label>
</div>
<div class="execution-grid" style="margin-top:10px">
<label style="grid-column:span 2">Execution token (not saved)<input id="executionToken" type="password" autocomplete="off" placeholder="Paste ETI_EXECUTION_TOKEN"></label>
<label id="liveTokenWrap" style="grid-column:span 2;display:none">Live activation secret (not saved)<input id="liveActivationToken" type="password" autocomplete="off" placeholder="Paste ETI_LIVE_ACTIVATION_TOKEN"></label>
</div>
<div class="execution-actions">
<button id="previewOrder" class="active">Preview order</button>
<button id="buyOrder" class="btn-buy">Buy</button>
<button id="sellOrder" class="btn-sell">Sell</button>
<button id="clearExecutionSecrets">Clear credentials</button>
</div>
<div style="margin-top:12px"><strong>Order preview / response</strong><div id="orderOutput" class="execution-output" style="margin-top:7px">No order prepared.</div></div>
</section>
<section class="panel" style="margin-top:14px">
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">ETI Execution Audit History</h2><button id="refreshExecutionHistory">Refresh audit history</button></div>
<p class="execution-note">Shows ETI orders recorded in KV, including who or what initiated each order. This is separate from the public Binance market trade tape above.</p>
<div id="executionHistory" class="history-table"><span class="muted">Enter your execution token, then refresh.</span></div>
</section>
<p class="muted">Market panels use public exchange data. Order entry submits broker orders only after authenticated preview and explicit confirmation. Market data may be delayed or interrupted. ETI does not request or use withdrawal, transfer, funding, or wallet-management permissions.</p>
</main>
<script>
const $=id=>document.getElementById(id);let socket=null, candles=[], book={bids:[],asks:[]}, trades=[];
const fmt=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:6});
function resize(c){const dpr=devicePixelRatio||1, r=c.getBoundingClientRect();c.width=r.width*dpr;c.height=r.height*dpr;const x=c.getContext('2d');x.scale(dpr,dpr);return {x,w:r.width,h:r.height};}
function drawChart(){const c=$('chart'),{x,w,h}=resize(c);x.clearRect(0,0,w,h);if(!candles.length){x.fillStyle='#8fa3bd';x.fillText('Waiting for candle data…',12,24);return;}const vals=candles.flatMap(v=>[v[2],v[3]]),lo=Math.min(...vals),hi=Math.max(...vals),pad=(hi-lo)*.08||1,min=lo-pad,max=hi+pad;const px=i=>i*w/candles.length,py=v=>h-18-(v-min)/(max-min)*(h-34);x.strokeStyle='#24334a';x.lineWidth=1;for(let i=0;i<5;i++){let y=16+i*(h-32)/4;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}candles.forEach((v,i)=>{const [t,o,high,low,close]=v,up=close>=o;x.strokeStyle=up?'#21d69a':'#ff637d';x.fillStyle=x.strokeStyle;let xx=px(i)+w/candles.length/2;x.beginPath();x.moveTo(xx,py(high));x.lineTo(xx,py(low));x.stroke();let top=py(Math.max(o,close)),bot=py(Math.min(o,close));x.fillRect(xx-3,top,6,Math.max(1,bot-top));});x.fillStyle='#8fa3bd';x.fillText(fmt(max),5,12);x.fillText(fmt(min),5,h-5);}
function drawDepth(){const c=$('depth'),{x,w,h}=resize(c);x.clearRect(0,0,w,h);for(const [levels,color,reverse] of [[book.bids,'#21d69a',true],[book.asks,'#ff637d',false]]){const sorted=[...levels].sort((a,b)=>reverse?b[0]-a[0]:a[0]-b[0]);if(!sorted.length)continue;let total=0,max=sorted.reduce((s,v)=>s+Number(v[1]),0);x.beginPath();x.strokeStyle=color;x.lineWidth=2;sorted.forEach((v,i)=>{total+=Number(v[1]);let xx=i*w/Math.max(1,sorted.length-1),yy=h-8-total/max*(h-16);i?x.lineTo(xx,yy):x.moveTo(xx,yy);});x.stroke();}}
function renderBook(){const bids=book.bids.slice(0,15),asks=book.asks.slice(0,15);if(bids.length)$('bid').textContent=fmt(bids[0][0]);if(asks.length)$('ask').textContent=fmt(asks[0][0]);if(bids.length&&asks.length)$('spread').textContent=fmt(asks[0][0]-bids[0][0]);let rows='<table><tr><th>Side</th><th>Price</th><th>Quantity</th></tr>';for(const a of [...asks].reverse())rows+='<tr><td class="ask">ASK</td><td>'+fmt(a[0])+'</td><td>'+fmt(a[1])+'</td></tr>';for(const b of bids)rows+='<tr><td class="bid">BID</td><td>'+fmt(b[0])+'</td><td>'+fmt(b[1])+'</td></tr>';rows+='</table>';$('book').innerHTML=rows;drawDepth();}
function renderTrades(){$('trades').innerHTML='<table><tr><th>Time</th><th>Side</th><th>Price</th><th>Quantity</th></tr>'+trades.slice(0,50).map(t=>'<tr><td>'+new Date(t.T).toLocaleTimeString()+'</td><td class="'+(t.m?'sell':'buy')+'">'+(t.m?'SELL':'BUY')+'</td><td>'+fmt(t.p)+'</td><td>'+fmt(t.q)+'</td></tr>').join('')+'</table>';}
let provider=null,failCount=0,loadTimer=null,wsRetry=0,wsTimer=null,reqSeq=0,lastGoodAt=null,lastGoodKey='';
function setConn(t,c){$('connection').textContent=t;$('connection').style.color=c;}
function setStale(msg){const e=$('stale');e.style.display=msg?'inline-block':'none';e.textContent=msg||'';}
async function getJson(url){const r=await fetch(url,{cache:'no-store'}),txt=await r.text();let j=null;try{j=JSON.parse(txt);}catch(e){}if(!r.ok){let why=j&&j.detail?j.detail:txt.slice(0,160);if(j&&j.attempts)why+=' ['+j.attempts.map(a=>a.provider+':'+(a.errorClass||'ok')).join(', ')+']';throw Error(url.split('?')[0].replace('/api/market/','')+' HTTP '+r.status+' — '+why);}return {data:j,provider:r.headers.get('x-eti-provider'),failover:r.headers.get('x-eti-failover')==='true'};}
function schedule(ms){clearTimeout(loadTimer);loadTimer=setTimeout(load,ms);}
async function load(){
 const seq=++reqSeq,s=$('symbol').value,i=$('interval').value,key=s+'|'+i,q='symbol='+encodeURIComponent(s);
 try{
  const k=await getJson('/api/market/klines?'+q+'&interval='+encodeURIComponent(i)+'&limit=120');
  if(seq!==reqSeq)return;
  const rows=k.data;if(!Array.isArray(rows)||!rows.length)throw Error('klines returned no candles');
  candles=rows.map(v=>v.map(Number));provider=k.provider;lastGoodAt=Date.now();lastGoodKey=key;
  const pq='&provider='+encodeURIComponent(provider||'');
  const [d,t,tk]=await Promise.allSettled([getJson('/api/market/depth?'+q+'&limit=20'+pq),getJson('/api/market/trades?'+q+'&limit=50'+pq),getJson('/api/market/ticker?'+q+pq)]);
  if(seq!==reqSeq)return;
  const problems=[];
  if(d.status==='fulfilled'){book={bids:d.value.data.bids,asks:d.value.data.asks};}else problems.push('depth: '+d.reason.message);
  if(t.status==='fulfilled'){trades=t.value.data.map(v=>({T:Number(v.time),m:!!v.isBuyerMaker,p:String(v.price),q:String(v.qty)}));}else problems.push('trades: '+t.reason.message);
  if(tk.status==='fulfilled'){const x=tk.value.data;$('volume').textContent=fmt(x.volume);const c=Number(x.priceChangePercent);$('change').textContent=(c>=0?'+':'')+c.toFixed(2)+'%';$('change').style.color=c>=0?'#21d69a':'#ff637d';}else{$('volume').textContent=fmt(candles.at(-1)[5])+' (last candle)';$('change').textContent='—';problems.push('ticker: '+tk.reason.message);}
  drawChart();renderBook();renderTrades();
  $('last').textContent=fmt(candles.at(-1)[4]);$('provider').textContent=provider+(k.failover?' (failover)':'');
  failCount=0;setStale(problems.length?'Partial data — '+problems[0].slice(0,140):'');
  $('stamp').textContent='Updated '+new Date().toLocaleTimeString()+' via '+provider;
  setConn(provider==='binance'&&socket&&socket.readyState===1?'Live stream + REST ('+provider+')':'REST feed connected ('+provider+')',k.failover?'#f59e0b':'#21d69a');
  if(provider==='binance'){if(!socket||socket.readyState>1)connectWs();}else if(socket){socket.onclose=null;socket.close();socket=null;}
  schedule(provider==='binance'?15000:5000);
 }catch(e){
  if(seq!==reqSeq)return;
  failCount++;const wait=Math.min(60000,2000*Math.pow(2,failCount-1));
  const have=candles.length&&lastGoodKey===key;
  if(have)setStale('STALE — showing last valid data from '+new Date(lastGoodAt).toLocaleTimeString()+' · '+e.message.slice(0,160));
  else{candles=[];drawChart();setStale('');}
  setConn('Market data unavailable · retry in '+Math.round(wait/1000)+'s','#ff637d');
  $('stamp').textContent=e.message;schedule(wait);
 }
}
function connectWs(){
 if(provider!=='binance')return;
 clearTimeout(wsTimer);if(socket){socket.onclose=null;socket.close();}
 const s=$('symbol').value.toLowerCase(),sock=new WebSocket('wss://data-stream.binance.vision/stream?streams='+s+'@trade/'+s+'@depth20@100ms/'+s+'@kline_'+$('interval').value);socket=sock;
 sock.onopen=()=>{wsRetry=0;setConn('Live WebSocket + REST (binance)','#21d69a');};
 sock.onmessage=e=>{const msg=JSON.parse(e.data),d=msg.data;if(msg.stream.includes('@trade')){trades.unshift({T:d.T,m:d.m,p:d.p,q:d.q});trades=trades.slice(0,100);renderTrades();$('last').textContent=fmt(d.p);}else if(msg.stream.includes('@depth')){book={bids:d.bids.map(v=>v.map(Number)),asks:d.asks.map(v=>v.map(Number))};renderBook();}else if(msg.stream.includes('@kline')){const k=d.k,row=[k.t,k.o,k.h,k.l,k.c,k.v].map(Number);if(candles.length&&candles.at(-1)[0]===row[0])candles[candles.length-1]=row;else if(candles.length&&row[0]>candles.at(-1)[0])candles.push(row);candles=candles.slice(-120);drawChart();}};
 sock.onclose=()=>{if(socket!==sock)return;const wait=Math.min(30000,1000*Math.pow(2,wsRetry++));setConn('WebSocket disconnected · REST polling active · reconnect in '+Math.round(wait/1000)+'s','#f59e0b');wsTimer=setTimeout(connectWs,wait);};
 sock.onerror=()=>sock.close();
}
function resetAndLoad(){reqSeq++;candles=[];trades=[];book={bids:[],asks:[]};provider=null;failCount=0;lastGoodKey='';setStale('');drawChart();renderBook();renderTrades();if(socket){socket.onclose=null;socket.close();socket=null;}load();}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let preparedOrder=null, executionStatus=null;
function selectedOrder(){
 const broker=$('orderBroker').value, mode=$('orderMode').value, type=$('orderType').value;
 const quantity=Number($('orderQuantity').value), symbol=$('orderSymbol').value.trim().toUpperCase();
 const order={broker,mode,symbol,type,quantity,side:window.etiSelectedSide||'buy',timeInForce:$('orderTif').value};
 if(type==='limit') order.limitPrice=Number($('orderLimitPrice').value);
 return order;
}
function orderValidation(o,requireCredentials=true){
 if(!/^[A-Z0-9._-]{2,24}$/.test(o.symbol))return 'Enter a valid symbol.';
 if(!Number.isFinite(o.quantity)||o.quantity<=0)return 'Enter a quantity greater than zero.';
 if(o.type==='limit'&&(!Number.isFinite(o.limitPrice)||o.limitPrice<=0))return 'Enter a valid limit price.';
 if(!$('operatorId').value.trim())return 'Enter an operator ID for the audit record.';
 if(requireCredentials&&!$('executionToken').value)return 'Enter your ETI execution token.';
 if(requireCredentials&&o.mode==='live'&&!$('liveActivationToken').value)return 'Enter the separate live activation secret.';
 if(o.mode==='live'&&(!executionStatus||executionStatus.live_trading_enabled!==true))return 'Live trading is not enabled in the Worker configuration.';
 return '';
}
function renderPreview(o){
 const summary={broker:o.broker,mode:o.mode==='live'?'LIVE':'paper/testnet',symbol:o.symbol,side:o.side,type:o.type,quantity:o.quantity};
 if(o.type==='limit')summary.limitPrice=o.limitPrice;
 summary.executionSource={actorType:'manual_user',actorId:$('operatorId').value.trim(),sourceName:'ETI Dashboard',triggerReason:'Manually submitted from dashboard'};
 $('orderOutput').textContent='Review this order carefully before submission: | '+JSON.stringify(summary,null,2);
}
async function refreshExecutionStatus(){
 try{
  const r=await fetch('/api/execution/status',{cache:'no-store'}),d=await r.json();executionStatus=d;
  const brokerReady=$('orderBroker').value==='alpaca'?d.alpaca_live_configured:d.binance_live_configured;
  $('executionStatus').textContent=d.live_trading_enabled?(brokerReady?'Live switch ON · broker credentials configured':'Live switch ON · live broker credentials missing'):'Paper/Testnet default';
  $('executionStatus').style.color=d.live_trading_enabled?(brokerReady?'#21d69a':'#ffb08c'):'#21d69a';
  $('killSwitchStatus').textContent=d.kill_switch?'ACTIVE':'Inactive';
  $('killSwitchStatus').style.color=d.kill_switch?'#ff637d':'#21d69a';
  $('orderMode').value='paper_testnet';
 }catch(e){$('executionStatus').textContent='Status unavailable';}
}
async function refreshExecutionHistory(){
 const token=$('executionToken').value;
 if(!token){$('executionHistory').textContent='Enter your ETI execution token first.';return;}
 $('executionHistory').textContent='Loading audit records…';
 try{
  const r=await fetch('/api/execution/history',{headers:{Authorization:'Bearer '+token},cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.message||d.error||('HTTP '+r.status));
  const records=d.records||[];
  if(!records.length){$('executionHistory').textContent='No ETI execution records found.';return;}
  $('executionHistory').innerHTML='<table><tr><th>Time (UTC)</th><th>Broker / Mode</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Initiator</th><th>Order ID</th></tr>'+records.map(v=>'<tr><td>'+esc(v.executedAt)+'</td><td>'+esc(v.broker)+' / '+esc(v.mode)+'</td><td>'+esc(v.symbol)+'</td><td class="'+(v.side==='buy'?'buy':'sell')+'">'+esc(v.side)+'</td><td>'+esc(v.quantity)+'</td><td>'+esc((v.executionSource||{}).sourceName)+' ('+esc((v.executionSource||{}).actorId)+')</td><td>'+esc(v.brokerOrderId||v.clientOrderId)+'</td></tr>').join('')+'</table>';
 }catch(e){$('executionHistory').textContent='Could not load history: '+e.message;}
}
async function submitOrder(side){
 const o=selectedOrder();o.side=side;window.etiSelectedSide=side;
 const problem=orderValidation(o);if(problem){$('orderOutput').textContent=problem;return;}
 if(o.mode==='live'&&executionStatus&&executionStatus.kill_switch){$('orderOutput').textContent='Execution blocked: emergency kill switch is active.';return;}
 renderPreview(o);
 const modeLabel=o.mode==='live'?'LIVE':'PAPER / TESTNET';
 const detail=side.toUpperCase()+' '+o.quantity+' '+o.symbol+' via '+o.broker.toUpperCase()+' ('+modeLabel+', '+o.type.toUpperCase()+')';
 if(!window.confirm('FINAL ORDER CONFIRMATION |  | '+detail+' |  | This will submit a real broker order if LIVE is selected. Continue?'))return;
 const clientOrderId='eti'+crypto.randomUUID().replace(/-/g,'').slice(0,29);
 const body={broker:o.broker,symbol:o.symbol,side:o.side,type:o.type,quantity:o.quantity,timeInForce:o.timeInForce,clientOrderId,riskConfirmed:true,executionSource:{actorType:'manual_user',actorId:$('operatorId').value.trim(),sourceName:'ETI Dashboard',triggerReason:'Manually submitted from dashboard'}};
 if(o.type==='limit')body.limitPrice=o.limitPrice;
 const endpoint=o.mode==='live'?'/api/orders/live':'/api/orders';
 if(o.mode==='live')body.liveConfirmed=true;
 $('orderOutput').textContent='Submitting order…';
 try{
  const headers={'content-type':'application/json',Authorization:'Bearer '+$('executionToken').value};
  if(o.mode==='live')headers['X-ETI-Live-Authorization']=$('liveActivationToken').value;
  const r=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(body)}),d=await r.json();
  $('orderOutput').textContent=JSON.stringify(d,null,2);
  if(!r.ok)throw Error(d.message||d.error||('HTTP '+r.status));
  await refreshExecutionHistory();
 }catch(e){$('orderOutput').textContent+=' | Order submission failed: '+e.message;}
}
$('orderType').onchange=()=>{$('limitPriceWrap').style.display=$('orderType').value==='limit'?'flex':'none';};
$('orderMode').onchange=()=>{$('liveTokenWrap').style.display=$('orderMode').value==='live'?'flex':'none';};
$('orderBroker').onchange=()=>{$('orderTif').value=$('orderBroker').value==='binance'?'gtc':'day';if(executionStatus){const ready=$('orderBroker').value==='alpaca'?executionStatus.alpaca_live_configured:executionStatus.binance_live_configured;$('executionStatus').textContent=executionStatus.live_trading_enabled?(ready?'Live switch ON · broker credentials configured':'Live switch ON · live broker credentials missing'):'Paper/Testnet default';$('executionStatus').style.color=executionStatus.live_trading_enabled?(ready?'#21d69a':'#ffb08c'):'#21d69a';}};
$('orderSymbol').onchange=()=>{};
$('previewOrder').onclick=()=>{const o=selectedOrder();const problem=orderValidation(o,false);if(problem){$('orderOutput').textContent=problem;return;}renderPreview(o);};
$('buyOrder').onclick=()=>submitOrder('buy');
$('sellOrder').onclick=()=>submitOrder('sell');
$('clearExecutionSecrets').onclick=()=>{$('executionToken').value='';$('liveActivationToken').value='';$('orderOutput').textContent='Credentials cleared from this page.';$('executionHistory').textContent='Enter your execution token, then refresh.';};
$('refreshExecutionHistory').onclick=refreshExecutionHistory;
refreshExecutionStatus();

$('refresh').onclick=()=>{failCount=0;load();};$('symbol').onchange=()=>{$('orderSymbol').value=$('symbol').value;resetAndLoad();};$('interval').onchange=resetAndLoad;window.onresize=()=>{drawChart();drawDepth()};load();
</script></body></html>`;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/orders") || url.pathname === "/api/execution/status" || url.pathname === "/api/execution/history") {
      return handleExecution(request, _env);
    }
    if (url.pathname === "/api/signals") {
      return handleSignals(request, _env);
    }
    if (url.pathname.startsWith("/api/market/")) {
      return handleMarket(request, _env);
    }
    if (url.pathname === "/__eti/status" || url.pathname === "/api/system/health") {
      return json({ service: "Elite Trading Intelligence", role: "cloudflare-worker", status: "ok", backend_required: false, market_data: "Binance/Bybit/OKX public REST with failover (see /api/market/diag)", time: new Date().toISOString() });
    }
    if (url.pathname === "/") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return json({ error: "not_found", path: url.pathname, message: "This Cloudflare-native build currently exposes the live market dashboard and health endpoints. Existing FastAPI research/trading modules have not yet been ported." }, 404);
  },
};
