/**
 * ETI Cloudflare-native edge application.
 *
 * The dashboard and lightweight read-only market APIs run directly on Workers.
 * No FastAPI origin / BACKEND_URL is required. Brokerage credentials are never
 * accepted by these public market-data routes.
 */
export interface Env {
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
</style></head><body>
<header><div><h1>ETI <span style="color:var(--blue)">Elite Trading Intelligence</span></h1><small>Market structure • Liquidity • Price discovery</small></div><div id="connection" class="status">Connecting…</div></header>
<main>
<div class="toolbar"><select id="symbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select>
<select id="interval"><option>1m</option><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>1d</option><option>1w</option></select>
<button id="refresh" class="active">Refresh market</button><span class="muted" id="stamp">Waiting for market data…</span></div>
<div class="grid"><section class="panel"><h2>Live Market Chart</h2><div class="meta"><span>Last <b id="last">—</b></span><span>24h volume <b id="volume">—</b></span><span>Source <b>Binance public market feed</b></span></div><div class="chart"><canvas id="chart"></canvas></div></section>
<section class="panel"><h2>Order Book Depth</h2><div class="meta"><span>Bid <b class="bid" id="bid">—</b></span><span>Ask <b class="ask" id="ask">—</b></span><span>Spread <b id="spread">—</b></span></div><div id="book" class="scroll"></div></section></div>
<div class="lower"><section class="panel"><h2>Executed Trade History</h2><div id="trades" class="scroll"></div></section><section class="panel"><h2>Cumulative Market Depth</h2><div class="chart" style="height:220px"><canvas id="depth"></canvas></div><small>Aggregated visible bid and ask liquidity. Not a full exchange order queue.</small></section></div>
<p class="muted">Public exchange market data only. This dashboard does not place orders. Market data may be delayed, interrupted, or subject to exchange limits. Trading credentials and withdrawal permissions are not used.</p>
</main>
<script>
const $=id=>document.getElementById(id);let socket=null, candles=[], book={bids:[],asks:[]}, trades=[];
const fmt=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:6});
function resize(c){const dpr=devicePixelRatio||1, r=c.getBoundingClientRect();c.width=r.width*dpr;c.height=r.height*dpr;const x=c.getContext('2d');x.scale(dpr,dpr);return {x,w:r.width,h:r.height};}
function drawChart(){const c=$('chart'),{x,w,h}=resize(c);x.clearRect(0,0,w,h);if(!candles.length){x.fillStyle='#8fa3bd';x.fillText('Waiting for candle data…',12,24);return;}const vals=candles.flatMap(v=>[v[2],v[3]]),lo=Math.min(...vals),hi=Math.max(...vals),pad=(hi-lo)*.08||1,min=lo-pad,max=hi+pad;const px=i=>i*w/candles.length,py=v=>h-18-(v-min)/(max-min)*(h-34);x.strokeStyle='#24334a';x.lineWidth=1;for(let i=0;i<5;i++){let y=16+i*(h-32)/4;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}candles.forEach((v,i)=>{const [t,o,high,low,close]=v,up=close>=o;x.strokeStyle=up?'#21d69a':'#ff637d';x.fillStyle=x.strokeStyle;let xx=px(i)+w/candles.length/2;x.beginPath();x.moveTo(xx,py(high));x.lineTo(xx,py(low));x.stroke();let top=py(Math.max(o,close)),bot=py(Math.min(o,close));x.fillRect(xx-3,top,6,Math.max(1,bot-top));});x.fillStyle='#8fa3bd';x.fillText(fmt(max),5,12);x.fillText(fmt(min),5,h-5);}
function drawDepth(){const c=$('depth'),{x,w,h}=resize(c);x.clearRect(0,0,w,h);for(const [levels,color,reverse] of [[book.bids,'#21d69a',true],[book.asks,'#ff637d',false]]){const sorted=[...levels].sort((a,b)=>reverse?b[0]-a[0]:a[0]-b[0]);if(!sorted.length)continue;let total=0,max=sorted.reduce((s,v)=>s+Number(v[1]),0);x.beginPath();x.strokeStyle=color;x.lineWidth=2;sorted.forEach((v,i)=>{total+=Number(v[1]);let xx=i*w/Math.max(1,sorted.length-1),yy=h-8-total/max*(h-16);i?x.lineTo(xx,yy):x.moveTo(xx,yy);});x.stroke();}}
function renderBook(){const bids=book.bids.slice(0,15),asks=book.asks.slice(0,15);if(bids.length)$('bid').textContent=fmt(bids[0][0]);if(asks.length)$('ask').textContent=fmt(asks[0][0]);if(bids.length&&asks.length)$('spread').textContent=fmt(asks[0][0]-bids[0][0]);let rows='<table><tr><th>Side</th><th>Price</th><th>Quantity</th></tr>';for(const a of [...asks].reverse())rows+='<tr><td class="ask">ASK</td><td>'+fmt(a[0])+'</td><td>'+fmt(a[1])+'</td></tr>';for(const b of bids)rows+='<tr><td class="bid">BID</td><td>'+fmt(b[0])+'</td><td>'+fmt(b[1])+'</td></tr>';rows+='</table>';$('book').innerHTML=rows;drawDepth();}
function renderTrades(){$('trades').innerHTML='<table><tr><th>Time</th><th>Side</th><th>Price</th><th>Quantity</th></tr>'+trades.slice(0,50).map(t=>'<tr><td>'+new Date(t.T).toLocaleTimeString()+'</td><td class="'+(t.m?'sell':'buy')+'">'+(t.m?'SELL':'BUY')+'</td><td>'+fmt(t.p)+'</td><td>'+fmt(t.q)+'</td></tr>').join('')+'</table>';}
async function load(){const s=$('symbol').value,i=$('interval').value;try{const r=await fetch('https://api.binance.com/api/v3/klines?symbol='+s+'&interval='+i+'&limit=120');if(!r.ok)throw Error('Kline HTTP '+r.status);candles=await r.json();drawChart();const b=await fetch('https://api.binance.com/api/v3/depth?symbol='+s+'&limit=20');if(!b.ok)throw Error('Depth HTTP '+b.status);const d=await b.json();book={bids:d.bids.map(v=>v.map(Number)),asks:d.asks.map(v=>v.map(Number))};renderBook();$('last').textContent=fmt(candles.at(-1)[4]);$('volume').textContent=fmt(candles.at(-1)[5]);$('stamp').textContent='REST snapshot '+new Date().toLocaleTimeString();$('connection').textContent='Connected · REST snapshot';}catch(e){$('connection').textContent='Market data unavailable';$('connection').style.color='#ff637d';$('stamp').textContent=e.message;}}
function connect(){if(socket)socket.close();const s=$('symbol').value.toLowerCase();socket=new WebSocket('wss://stream.binance.com:9443/stream?streams='+s+'@trade/'+s+'@depth20@100ms/'+s+'@kline_'+$('interval').value);socket.onopen=()=>{$('connection').textContent='Live WebSocket connected';$('connection').style.color='#21d69a';};socket.onmessage=e=>{const msg=JSON.parse(e.data),d=msg.data;if(msg.stream.includes('@trade')){trades.unshift(d);trades=trades.slice(0,100);renderTrades();$('last').textContent=fmt(d.p);}else if(msg.stream.includes('@depth')){book={bids:d.b.map(v=>v.map(Number)),asks:d.a.map(v=>v.map(Number))};renderBook();}else if(msg.stream.includes('@kline')){const k=d.k, row=[k.t,k.o,k.h,k.l,k.c,k.v].map((v,i)=>i===0?Number(v):Number(v));if(candles.length&&candles.at(-1)[0]===row[0])candles[candles.length-1]=row;else candles.push(row);candles=candles.slice(-120);drawChart();}};socket.onclose=()=>{$('connection').textContent='Disconnected · retrying';$('connection').style.color='#f59e0b';};socket.onerror=()=>socket.close();}
$('refresh').onclick=()=>{load().then(connect)};$('symbol').onchange=()=>{trades=[];load().then(connect)};$('interval').onchange=()=>load().then(connect);window.onresize=()=>{drawChart();drawDepth()};load().then(connect);setInterval(()=>{if(!socket||socket.readyState>1)connect()},5000);
</script></body></html>`;

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__eti/status" || url.pathname === "/api/system/health") {
      return json({ service: "Elite Trading Intelligence", role: "cloudflare-worker", status: "ok", backend_required: false, market_data: "public Binance REST + WebSocket", time: new Date().toISOString() });
    }
    if (url.pathname === "/api/market/providers") {
      return json({ providers: [{ id: "binance", market_data: true, order_book: true, trades: true, candles: true, authentication_required: false }], note: "Read-only public market data. Broker integrations require separate secure server-side implementation." });
    }
    if (url.pathname === "/") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    return json({ error: "not_found", path: url.pathname, message: "This Cloudflare-native build currently exposes the live market dashboard and health endpoints. Existing FastAPI research/trading modules have not yet been ported." }, 404);
  },
};
