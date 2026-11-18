export const LIQUIDITY_CSS = String.raw`.eti-liq{margin:12px 0;padding:14px;background:linear-gradient(145deg,#0e2036,#091729);border:1px solid #29445f;border-radius:13px;color:#eaf2ff;font:12px Inter,system-ui,sans-serif;min-width:0}.eti-liq *{box-sizing:border-box}.eti-liq-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.eti-liq h2{font-size:15px;margin:0}.eti-liq-sub{color:#8ea6c2;font-size:10px;margin-top:4px}.eti-liq-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.eti-liq button,.eti-liq select{background:#071526;color:#eaf2ff;border:1px solid #29435f;border-radius:7px;padding:7px 9px;font:inherit;cursor:pointer}.eti-liq button.on{border-color:#56adff;color:#cce7ff;background:#102c48}.eti-liq-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:12px 0}.eti-liq-stat{background:#08182a;border:1px solid #1e3650;border-radius:8px;padding:9px;min-width:0}.eti-liq-stat small{display:block;color:#8ea6c2;font-size:9px;letter-spacing:.5px}.eti-liq-stat strong{display:block;font-size:15px;margin:5px 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.eti-liq-stat span{color:#8ea6c2;font-size:9px}.eti-liq-strategy{margin-top:10px}.eti-liq-strategy .eti-liq-grid{grid-template-columns:repeat(6,minmax(0,1fr))}.eti-liq-strategy .eti-liq-canvas{height:300px}.eti-liq-main{display:grid;grid-template-columns:minmax(0,1.8fr) minmax(240px,1fr);gap:10px}.eti-liq-canvas-wrap{position:relative;min-width:0;background:#061321;border:1px solid #203b59;border-radius:9px;overflow:hidden}.eti-liq-canvas{display:block;width:100%;height:340px}.eti-liq-side{display:grid;gap:8px;align-content:start;min-width:0}.eti-liq-box{background:#08182a;border:1px solid #1e3650;border-radius:8px;padding:10px;min-width:0}.eti-liq-box h3{font-size:11px;margin:0 0 8px}.eti-liq-row{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px solid #1d2e43;font-size:10px}.eti-liq-row:last-child{border-bottom:0}.eti-liq-row b{font-variant-numeric:tabular-nums;text-align:right}.eti-liq-muted{color:#8ea6c2}.eti-liq-bid{color:#61d9c2}.eti-liq-ask{color:#ff899d}.eti-liq-warn{color:#ffc77d}.eti-liq-signal{font-size:12px;font-weight:800;letter-spacing:.3px}.eti-liq-foot{font-size:9px;color:#8ea6c2;line-height:1.55;margin-top:10px}.eti-liq-pill{display:inline-flex;align-items:center;border:1px solid #29435f;border-radius:99px;padding:3px 7px;font-size:9px;color:#a9bfd6}.eti-liq-pill.good{border-color:#1c8d6c;color:#72e6bf}.eti-liq-pill.bad{border-color:#a63e58;color:#ff9aaa}.eti-liq-overlay{position:absolute;inset:0;width:100%;height:100%;z-index:9;pointer-events:none}.eti-liq-hidden{display:none!important}.eti-liq-actions [data-eti-layer]{opacity:.55}.eti-liq-actions [data-eti-layer].on{opacity:1;border-color:#56adff;color:#cfe3ff;background:#10223a}@media(max-width:900px){.eti-liq-grid,.eti-liq-strategy .eti-liq-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.eti-liq-main{grid-template-columns:1fr}.eti-liq-canvas{height:300px}}@media(max-width:560px){.eti-liq{padding:10px}.eti-liq-grid,.eti-liq-strategy .eti-liq-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.eti-liq-head{align-items:flex-start}.eti-liq-canvas{height:260px}.eti-liq-actions button{padding:6px 7px;font-size:10px}}
`;
export const LIQUIDITY_JS = String.raw`(function(){
"use strict";
if(window.__ETI_LIQUIDITY_BOOTED)return;window.__ETI_LIQUIDITY_BOOTED=true;
const $=id=>document.getElementById(id),fmt=(n,d=2)=>Number.isFinite(Number(n))?Number(n).toLocaleString(undefined,{maximumFractionDigits:d}):"—";
const state={venue:"bitget",market:"futures",category:"linear",symbol:"BTCUSDT",interval:"1h",depth:null,previous:null,trades:[],candles:[],candlesByTimeframe:{},signalAt:0,derivatives:null,marketMetrics:null,analysis:null,orderFlow:null,history:[],ws:null,timer:null,candleAt:0,lastOrderFlowAt:0,busy:false,overlay:true,scenarios:true,root:false,lastError:"",sequence:0,equity:74,ledger:[],structure:null,layers:{fvg:true,orderBlocks:true,structure:true,liquidity:true,sr:true}};
const maxHistory=90;
function isRoot(){return !!$("symVenue")&&!$("tt-venue");}
function readContext(){
 state.root=isRoot();
 const venueSelect=$(state.root?"symVenue":"tt-venue");if(venueSelect&&!venueSelect.dataset.etiDefaulted){venueSelect.value="bitget";venueSelect.dataset.etiDefaulted="1";}
 try{const saved=Number(localStorage.getItem("eti-risk-equity-v1"));if(Number.isFinite(saved)&&saved>0)state.equity=saved;const ledger=JSON.parse(localStorage.getItem("eti-risk-ledger-v1")||"[]");state.ledger=Array.isArray(ledger)?ledger.slice(-100):[];}catch(e){state.ledger=[];}
 state.venue=$(state.root?"symVenue":"tt-venue")?.value||"bitget";
 state.market=$(state.root?"symMarket":"tt-market")?.value||"futures";
 state.symbol=($(state.root?"symbol":"tt-symbol")?.value||"BTCUSDT").trim().toUpperCase();
 state.interval=$(state.root?"interval":"tt-interval")?.value||"1h";
 const cat=$(state.root?"orderBitgetMarket":"tt-category")?.value||$(state.root?"symCat":"tt-category")?.value||"";
 const normalizedCategory=String(cat).toUpperCase();
 state.category=state.venue==="bitget"?(state.market==="futures"?(["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"].includes(normalizedCategory)?normalizedCategory:normalizedCategory==="INVERSE"?"COIN-FUTURES":"USDT-FUTURES"):"SPOT"):(state.market==="futures"?(cat==="inverse"?"inverse":"linear"):"spot");
 if(state.venue==="bitget"&&state.market!=="futures")state.category="SPOT";
}
function historyKey(){return "eti-liquidity-depth-v1:"+[state.venue,state.market,state.category,state.symbol].join(":");}
function restoreHistory(){try{const a=JSON.parse(localStorage.getItem(historyKey())||"[]");state.history=Array.isArray(a)?a.slice(-maxHistory):[];}catch(e){state.history=[];}}
function saveHistory(){try{localStorage.setItem(historyKey(),JSON.stringify(state.history.slice(-maxHistory)));}catch(e){}}
function syncRiskDisplay(){const summary=$("eti-risk-equity-summary"),panel=$("eti-risk-equity");if(summary)summary.textContent="$"+fmt(state.equity,2);if(panel){const strong=panel.querySelector("strong");if(strong)strong.textContent="$"+fmt(state.equity,2);}const capital=$("eti-risk-capital");if(capital)capital.value=String(state.equity);const next=$("eti-risk-next");if(next)next.textContent="Next trade risk budget (30%): $"+fmt(state.equity*.30,2);}
function mount(){
 const anchor=state.root?document.querySelector(".chart-workspace"):(document.querySelector("#tt-chart")?.closest(".tt-card")||document.querySelector("#tt-chart")?.parentElement);
 if(!anchor||$("eti-liquidity-panel"))return;
 const el=document.createElement("section");el.id="eti-liquidity-panel";el.className="eti-liq";
 el.innerHTML='<div class="eti-liq-head"><div><h2>Institutional Liquidity Intelligence</h2><div class="eti-liq-sub">Live order-book depth · liquidity persistence · absorption · sweep confluence</div></div><div class="eti-liq-actions"><span id="eti-liq-feed" class="eti-liq-pill">Connecting</span><button id="eti-liq-overlay" class="on" type="button">Chart overlay: ON</button><button type="button" class="on" data-eti-layer="fvg">FVG</button><button type="button" class="on" data-eti-layer="orderBlocks">Order blocks</button><button type="button" class="on" data-eti-layer="structure">BOS / CHoCH</button><button type="button" class="on" data-eti-layer="liquidity">Liquidity</button><button type="button" class="on" data-eti-layer="sr">S/R</button><button id="eti-liq-scenarios" class="on" type="button">Liquidation scenarios: ON</button><button id="eti-liq-refresh" type="button">Refresh</button></div></div><div class="eti-liq-grid"><div class="eti-liq-stat"><small>REFERENCE MID</small><strong id="eti-liq-mid">—</strong><span id="eti-liq-spread">Spread unavailable</span></div><div class="eti-liq-stat"><small>BOOK IMBALANCE</small><strong id="eti-liq-imbalance">—</strong><span>Top 20 levels · not direction alone</span></div><div class="eti-liq-stat"><small>TRADE DELTA</small><strong id="eti-liq-delta">—</strong><span id="eti-liq-delta-sub">Recent executed trades</span></div><div class="eti-liq-stat"><small>LIQUIDITY CONFLUENCE</small><strong id="eti-liq-score">—</strong><span id="eti-liq-signal">Waiting for evidence</span></div><div class="eti-liq-stat"><small>BOOK BEHAVIOUR</small><strong id="eti-liq-behaviour">—</strong><span id="eti-liq-behaviour-sub">Persistence / pulled / absorbed</span></div><div class="eti-liq-stat"><small>DATA FRESHNESS</small><strong id="eti-liq-age">—</strong><span id="eti-liq-source">Exchange feed</span></div></div><div class="eti-liq-main"><div class="eti-liq-canvas-wrap"><canvas id="eti-liq-canvas" class="eti-liq-canvas" role="img" aria-label="Order-book liquidity heatmap showing bid and ask liquidity through time"></canvas></div><div class="eti-liq-side"><div class="eti-liq-box"><h3>Largest displayed liquidity</h3><div id="eti-liq-walls" class="eti-liq-muted">Waiting for order-book depth…</div></div><div class="eti-liq-box"><h3>Liquidity behaviour</h3><div id="eti-liq-events" class="eti-liq-muted">Waiting for successive snapshots…</div></div><div class="eti-liq-box"><h3>Estimated liquidation scenarios</h3><div id="eti-liq-liquidations" class="eti-liq-muted">Scenario model pending mark/last price.</div><div class="eti-liq-sub">Illustrative isolated-margin price bands at assumed leverage; not exchange liquidation data.</div></div><div class="eti-liq-box"><h3>Strategy confluence</h3><div id="eti-liq-confluence" class="eti-liq-muted">Waiting for market structure and trade flow…</div></div></div></div><div class="eti-liq-strategy"><div class="eti-liq-box"><h3>Universal signal engine · Bitget primary</h3><div class="eti-liq-grid"><div class="eti-liq-stat"><small>STRATEGY SIGNAL</small><strong id="eti-strategy-direction">WAIT</strong><span id="eti-strategy-score">Score pending</span></div><div class="eti-liq-stat"><small>INDICATOR STACK</small><strong id="eti-strategy-rsi">RSI —</strong><span id="eti-strategy-ema">EMA alignment pending</span></div><div class="eti-liq-stat"><small>ENTRY / STOP</small><strong id="eti-strategy-entry">—</strong><span id="eti-strategy-stop">Stop —</span></div><div class="eti-liq-stat"><small>TARGET / R:R</small><strong id="eti-strategy-target">—</strong><span id="eti-strategy-rr">Reward/risk —</span></div><div class="eti-liq-stat"><small>ACCOUNT EQUITY</small><strong id="eti-risk-equity-summary">$74.00</strong><span>Compounded realized PnL</span></div><div class="eti-liq-stat"><small>RISK CONFIGURATION</small><strong>20× · 30%</strong><span>Risk budget · margin cap 30%</span></div></div><div class="eti-liq-main"><div class="eti-liq-canvas-wrap"><canvas id="eti-sr-canvas" class="eti-liq-canvas" role="img" aria-label="Support and resistance heatmap built from swing levels, candle volume profile and Bitget order-book liquidity"></canvas></div><div class="eti-liq-side"><div class="eti-liq-box"><h3>Support / resistance heat zones</h3><div id="eti-sr-levels" class="eti-liq-muted">Waiting for candle and Bitget depth data…</div></div><div class="eti-liq-box"><h3>Position sizing · live capital base</h3><div id="eti-risk-equity" class="eti-liq-stat"><small>COMPOUNDED EQUITY</small><strong>$74.00</strong><span id="eti-risk-next">Next trade risk budget (30%): $22.20</span></div><div id="eti-risk-plan" class="eti-liq-muted">Waiting for a confirmed setup…</div><div class="eti-liq-sub">20× leverage · 30% requested risk budget · 30% maximum margin allocation. WARNING: 30% requested trade risk is highly aggressive. Actual loss is capped by margin and liquidation-distance checks; a setup can be blocked.</div></div><div class="eti-liq-box"><h3>Update capital after a closed trade</h3><div class="eti-liq-row"><label for="eti-risk-capital">Current trading capital (USDT)</label><input id="eti-risk-capital" type="number" min="0.01" step="0.01" value="74" style="width:120px;background:#071526;color:#eaf2ff;border:1px solid #29435f;border-radius:6px;padding:6px"></div><div class="eti-liq-row"><label for="eti-risk-pnl">Realised trade profit / loss (USDT)</label><input id="eti-risk-pnl" type="number" step="0.01" placeholder="e.g. 4.50" style="width:120px;background:#071526;color:#eaf2ff;border:1px solid #29435f;border-radius:6px;padding:6px"></div><button id="eti-risk-apply" type="button">Update capital & calculate next trade</button><div id="eti-risk-status" class="eti-liq-sub" aria-live="polite">Next capital = current capital + realised PnL. Next trade risk budget = 30% of updated capital.</div><div class="eti-liq-row"><b>Recent capital ledger</b><button id="eti-risk-undo" type="button">Undo last update</button></div><div id="eti-risk-ledger" class="eti-liq-muted" style="white-space:pre-line;max-height:130px;overflow:auto" aria-live="polite">No capital updates recorded.</div></div></div></div><div class="eti-liq-foot">Signal generation is market-wide and symbol-agnostic. Bitget USDT perpetual data is the default primary feed; select another supported venue when required. The support/resistance heatmap separates exchange resting depth from candle-derived swing and approximate volume-profile zones. Signals are analytical only.</div></div><div class="eti-liq-foot">Order-book heatmap uses observed resting depth from the selected venue. Historical bands are stored in this browser (up to 90 snapshots per symbol). Displayed orders can be cancelled or moved. Liquidation bands are mathematical scenarios using assumed leverage and a generic maintenance-margin approximation; they are not actual trader positions or verified liquidation clusters. This module is analytical only and does not submit orders.</div>';
 anchor.insertAdjacentElement("afterend",el);
 $("eti-liq-overlay").onclick=()=>{state.overlay=!state.overlay;$("eti-liq-overlay").textContent="Chart overlay: "+(state.overlay?"ON":"OFF");$("eti-liq-overlay").classList.toggle("on",state.overlay);drawOverlay();};
 $("eti-liq-scenarios").onclick=()=>{state.scenarios=!state.scenarios;$("eti-liq-scenarios").textContent="Liquidation scenarios: "+(state.scenarios?"ON":"OFF");$("eti-liq-scenarios").classList.toggle("on",state.scenarios);renderScenarios();drawHeatmap();};
 $("eti-liq-refresh").onclick=()=>poll(true);
 function saveRiskLedger(){try{localStorage.setItem("eti-risk-equity-v1",String(state.equity));localStorage.setItem("eti-risk-ledger-v1",JSON.stringify(state.ledger.slice(-100)));}catch(e){const status=$("eti-risk-status");if(status)status.textContent="Capital updated in this session, but browser storage is unavailable; record this value before closing.";}}
function renderRiskLedger(){const el=$("eti-risk-ledger"),undo=$("eti-risk-undo");if(!el)return;const rows=state.ledger.slice(-5).reverse();el.textContent=rows.length?rows.map(v=>new Date(v.at).toLocaleString()+" · "+v.symbol+" · "+(v.pnl>=0?"+":"")+fmt(v.pnl,4)+" USDT · $"+fmt(v.previousCapital,2)+" → $"+fmt(v.nextCapital,2)+" · next 30% $"+fmt(v.riskBudget,2)).join(String.fromCharCode(10)):"No capital updates recorded.";if(undo)undo.disabled=!state.ledger.length;}
$("eti-risk-capital").value=String(state.equity);syncRiskDisplay();renderRiskLedger();$("eti-risk-apply").onclick=()=>{const capitalEl=$("eti-risk-capital"),pnlEl=$("eti-risk-pnl"),capital=Number(capitalEl?.value),pnl=Number(pnlEl?.value);if(!capitalEl||!pnlEl||capitalEl.value.trim()===""||pnlEl.value.trim()===""||!Number.isFinite(capital)||capital<=0||!Number.isFinite(pnl)){ $("eti-risk-status").textContent="Enter a positive trading capital and the realised profit or loss for the closed trade.";return;}const next=Number((capital+pnl).toFixed(8));if(!Number.isFinite(next)||next<=0){$("eti-risk-status").textContent="Updated capital must remain above zero. Check the entered loss.";return;}state.ledger.push({at:Date.now(),symbol:state.symbol,venue:state.venue,market:state.market,previousCapital:capital,pnl,nextCapital:next,riskBudget:Number((next*.30).toFixed(8))});state.ledger=state.ledger.slice(-100);state.equity=next;saveRiskLedger();pnlEl.value="";syncRiskDisplay();renderRiskLedger();$("eti-risk-status").textContent="Capital updated: $"+fmt(capital,2)+" + PnL $"+fmt(pnl,4)+" = $"+fmt(state.equity,2)+". Next trade risk budget (30%): $"+fmt(state.equity*.30,2)+". Update recorded in the local ledger.";poll(true);};$("eti-risk-undo").onclick=()=>{const last=state.ledger.pop();if(!last)return;state.equity=last.previousCapital;saveRiskLedger();syncRiskDisplay();renderRiskLedger();$("eti-risk-status").textContent="Last capital update reversed. Current capital restored to $"+fmt(state.equity,2)+".";poll(true);};
 createChartOverlay();
}
function setFeed(text,good){const el=$("eti-liq-feed");if(!el)return;el.textContent=text;el.className="eti-liq-pill"+(good===true?" good":good===false?" bad":"");}
function query(path){const p=new URLSearchParams({venue:state.venue,market:state.market==="futures"?"futures":"spot",symbol:state.symbol,limit:"100"});if(path.indexOf("klines")>=0)p.set("interval",state.interval);if(state.venue==="bybit")p.set("category",state.category);return fetch(path+"?"+p,{cache:"no-store"}).then(async r=>{const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(j?.detail||j?.error||"HTTP "+r.status);return j;});}
function normalizeTrades(rows,venue){
 return (rows||[]).map(t=>{
  if(Array.isArray(t))return {time:Number(t[0]),price:Number(t[1]),qty:Number(t[2]),side:String(t[3]||"").toLowerCase()};
  if(venue==="bitget")return {time:Number(t.T||t.time||t.ts),price:Number(t.p||t.price),qty:Number(t.q||t.qty||t.size),side:t.m===true?"sell":"buy"};
  return {time:Number(t.time||t.T||t.ts),price:Number(t.price||t.p),qty:Number(t.qty||t.size||t.q),side:t.isBuyerMaker===true?"sell":String(t.side||"").toLowerCase()};
 }).filter(t=>Number.isFinite(t.price)&&t.price>0&&Number.isFinite(t.qty)&&t.qty>0&&["buy","sell"].includes(t.side)).slice(0,300);
}
async function getCandles(){
 const now=Date.now();if(state.candles.length&&now-state.candleAt<12000&&now-state.signalAt<60000)return;
 let rows;
 if(state.venue==="bitget"){
  const market=state.market==="futures"?"futures":"spot";
  if(window.ETIBitget&&typeof window.ETIBitget.loadSignalInputs==="function"&&now-state.signalAt>=60000){const multi=await window.ETIBitget.loadSignalInputs({symbol:state.symbol,market,category:state.category});state.candlesByTimeframe=multi.candles||{};state.signalAt=now;}
  try{rows=state.candlesByTimeframe[state.interval]?.length?state.candlesByTimeframe[state.interval]:await window.ETIBitget.candles({symbol:state.symbol,interval:state.interval,limit:300,market,category:state.category});}catch(e){if(!state.candles.length)throw e;rows=state.candles;}
 }else rows=await query("/api/market/klines");
 state.candles=(rows||[]).map(r=>Array.isArray(r)?r:[r.time*1000,r.open,r.high,r.low,r.close,r.volume]).filter(r=>Array.isArray(r)&&r.length>=6).slice(-300);
 state.candleAt=now;
}
async function fetchBook(){
 if(state.venue==="bitget"){
  if(!window.ETIBitget||typeof window.ETIBitget.context!=="function")throw new Error("Bitget browser adapter unavailable");
  const m=state.market==="futures"?"futures":"spot";
  const r=await window.ETIBitget.context({symbol:state.symbol,market:m,category:state.category,depthLimit:100,tradeLimit:100});
  if(!r.depth){if(state.depth?.bids?.length&&state.depth?.asks?.length)return {depth:state.depth,trades:state.trades,ticker:state.marketMetrics?{quoteVolume:state.marketMetrics.turnover24h,volume:state.marketMetrics.volume24h,priceChangePercent:state.marketMetrics.priceChange24h,highPrice:state.marketMetrics.high24h,lowPrice:state.marketMetrics.low24h}:null,derivatives:state.derivatives,source:"Bitget WebSocket recovery"};throw new Error(r.failures?.depth||"Bitget order book unavailable; waiting for WebSocket depth");}
  return {depth:r.depth,trades:normalizeTrades(r.trades,"bitget"),ticker:r.ticker,derivatives:r.derivatives,source:"Bitget browser REST"};
 }
 const [depth,trades]=await Promise.all([query("/api/market/depth"),query("/api/market/trades")]);
 return {depth,trades:normalizeTrades(trades,"bybit"),source:"Bybit REST"};
}
async function poll(force){
 if(state.busy)return;readContext();if(!state.symbol||!/^[A-Z0-9]{3,24}$/.test(state.symbol)){setFeed("Invalid symbol",false);return;}
 state.busy=true;const seq=++state.sequence;
 try{
  const result=await fetchBook();if(seq!==state.sequence)return;
  const book={bids:result.depth.bids,asks:result.depth.asks,timestamp:Number(result.depth.timestamp)||Date.now()};
  if(!book.bids.length||!book.asks.length)throw new Error("Exchange returned empty order-book sides");
  const prev=state.depth;state.previous=prev;state.depth=book;state.trades=result.trades||[];state.derivatives=result.derivatives||null;state.marketMetrics=result.ticker?{turnover24h:result.ticker.quoteVolume,volume24h:result.ticker.volume,priceChange24h:result.ticker.priceChangePercent,high24h:result.ticker.highPrice,low24h:result.ticker.lowPrice}:null;
  const now=Date.now(),last=state.history[state.history.length-1];
  if(force||!last||now-last.t>900){state.history.push({t:now,mid:(book.bids[0][0]+book.asks[0][0])/2,bids:book.bids.slice(0,45),asks:book.asks.slice(0,45)});state.history=state.history.slice(-maxHistory);saveHistory();}
  await getCandles();if(seq!==state.sequence)return;
  state.structure=buildStructureMap(state.candles);
  await loadOrderFlow();if(seq!==state.sequence)return;
  const payload={symbol:state.symbol,venue:state.venue,market:state.market,category:state.category,depth:book,previousDepth:prev,history:state.history.slice(-45).map(s=>({timestamp:s.t,bids:s.bids,asks:s.asks})),trades:state.trades,candles:state.candles,candlesByTimeframe:state.candlesByTimeframe,derivatives:state.derivatives,marketMetrics:state.marketMetrics,risk:{capital:state.equity,leverage:20,riskPercent:30,maxMarginPercent:30,compoundProfits:true,maxDailyLossPercent:30}};
  const response=await fetch("/api/liquidity/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),cache:"no-store"});
  const analysis=await response.json().catch(()=>null);if(seq!==state.sequence)return;if(!response.ok)throw new Error(analysis?.detail||analysis?.error||"Liquidity analysis failed");
  state.analysis=analysis;setFeed(result.source+" · live snapshot",true);render();drawHeatmap();drawOverlay();
 }catch(e){state.lastError=e?.message||"feed unavailable";setFeed("Feed unavailable · "+state.lastError,false);const note=$("eti-liq-source");if(note)note.textContent="Last successful snapshot retained; "+state.lastError;}
 finally{if(seq===state.sequence)state.busy=false;}
}
async function loadOrderFlow(){
 if(!state.depth||!state.trades.length||Date.now()-state.lastOrderFlowAt<5000)return;
 state.lastOrderFlowAt=Date.now();
 const q=new URLSearchParams({symbol:state.symbol,venue:state.venue,market:state.market==="futures"?"futures":"spot",category:state.category});
 const trades=state.trades.map(t=>({time:t.time,price:t.price,qty:t.qty,isBuyerMaker:t.side==="sell"}));
 try{
  const r=await fetch("/api/analysis/orderflow?"+q,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:state.venue,depth:state.depth,trades,candles:state.candles}),cache:"no-store"});
  const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(j?.detail||j?.error||"Order-flow history unavailable");state.orderFlow=j;
 }catch(e){state.orderFlow={dataQuality:{notes:[e?.message||"Order-flow history unavailable"]},liquidityHistory:{status:"unavailable",persistentLevels:[]}};}
}
function render(){
 const a=state.analysis;if(!a)return;
 $("eti-liq-mid").textContent=fmt(a.mid,Math.min(8,Math.max(2,state.pricePrecision||2)));
 $("eti-liq-spread").textContent=fmt(a.spreadBps,2)+" bps spread";
 $("eti-liq-imbalance").textContent=(a.depth.imbalance*100).toFixed(1)+"%";
 $("eti-liq-delta").textContent=(a.orderFlow.delta>=0?"+":"")+fmt(a.orderFlow.delta,0);
 $("eti-liq-delta-sub").textContent=fmt(a.orderFlow.deltaPct,1)+"% of recent traded notional";
 $("eti-liq-score").textContent=a.confluence.score+"/100";
 $("eti-liq-signal").textContent=a.confluence.direction==="WAIT"?"NO CONFIRMED SETUP":a.confluence.direction+" WATCH";
 $("eti-liq-behaviour").textContent=a.behaviour.persistent+" / "+a.behaviour.pulled+" / "+a.behaviour.absorbed;
 $("eti-liq-behaviour-sub").textContent="Persistent / pulled / absorbed · replenished "+a.behaviour.replenished;
 const age=a.dataQuality.freshnessMs===null?"timestamp unavailable":fmt(a.dataQuality.freshnessMs/1000,1)+"s old";
 $("eti-liq-age").textContent=age;$("eti-liq-source").textContent=a.dataQuality.warnings.length?a.dataQuality.warnings[0]:"Validated exchange snapshot";
 const wallHtml=(side,rows)=>rows.length?rows.slice(0,5).map(x=>'<div class="eti-liq-row"><span class="'+(side==="bid"?"eti-liq-bid":"eti-liq-ask")+'">'+side.toUpperCase()+' · '+fmt(x.price,6)+'</span><b>'+fmt(x.notional,0)+'</b></div>').join(""):'<div class="eti-liq-row"><span>No large walls detected</span></div>';
 $("eti-liq-walls").innerHTML=wallHtml("bid",a.walls.bids)+wallHtml("ask",a.walls.asks);
 $("eti-liq-events").innerHTML='<div class="eti-liq-row"><span>Persistent levels</span><b>'+a.behaviour.persistent+'</b></div><div class="eti-liq-row"><span>Pulled levels</span><b class="eti-liq-warn">'+a.behaviour.pulled+'</b></div><div class="eti-liq-row"><span>Absorbed levels</span><b>'+a.behaviour.absorbed+'</b></div><div class="eti-liq-row"><span>Replenished levels</span><b>'+a.behaviour.replenished+'</b></div>';
 const persisted=state.orderFlow?.liquidityHistory?.persistentLevels||[];const of=state.orderFlow?.tape||{};if(Number.isFinite(Number(of.deltaPct)))$("eti-liq-delta-sub").textContent=fmt(of.deltaPct,1)+"% tape delta · CVD "+fmt(of.cumulativeDelta,2);if(persisted.length)$("eti-liq-behaviour-sub").textContent="D1/KV persistent bands "+persisted.length+" · local replenishment "+a.behaviour.replenished;const p=a.priceAction||{};let conf='<div class="eti-liq-row"><span>Liquidity sweep</span><b>'+(p.sweep?p.sweep.direction.toUpperCase()+' · '+fmt(p.sweep.level,6):'None confirmed')+'</b></div><div class="eti-liq-row"><span>Fair value gap</span><b>'+(p.fvg?p.fvg.direction.toUpperCase()+' · '+fmt(p.fvg.low,6)+'–'+fmt(p.fvg.high,6):'None detected')+'</b></div><div class="eti-liq-row"><span>Order-flow alignment</span><b>'+(a.confluence.buyAligned?'Bullish':a.confluence.bearAligned?'Bearish':'Mixed / weak')+'</b></div><div class="eti-liq-row"><span>Market structure</span><b>'+String(p.structure||'unavailable').toUpperCase()+'</b></div>';
 $("eti-liq-confluence").innerHTML=conf;
 renderScenarios();renderStrategy();
}
function renderScenarios(){
 const el=$("eti-liq-liquidations");if(!el)return;
 if(!state.scenarios){el.textContent="Scenario display disabled.";return;}
 const mid=state.analysis?.mid;if(!Number.isFinite(mid)){el.textContent="Waiting for a valid reference price.";return;}
 const mmr=.005,levs=[5,10,20,50];
 el.innerHTML=levs.map(L=>{const long=mid*(1-1/L+mmr),short=mid*(1+1/L-mmr);return '<div class="eti-liq-row"><span>'+L+'× assumed leverage</span><b><span class="eti-liq-bid">L '+fmt(long,6)+'</span> / <span class="eti-liq-ask">S '+fmt(short,6)+'</span></b></div>';}).join("");
}
function renderStrategy(){
 const s=state.analysis?.strategy;if(!s)return;
 const dir=$("eti-strategy-direction");if(dir){dir.textContent=s.direction+" · "+s.confidence+"%";dir.style.color=s.direction==="LONG"?"#61d9c2":s.direction==="SHORT"?"#ff899d":"#ffc77d";}
 $("eti-strategy-score").textContent="Composite score "+s.score+"/100 · "+s.regime+" · MTF "+(s.multiTimeframeConfluence?.bias||"pending")+" ("+(s.multiTimeframeConfluence?.availableCount||0)+" TF) · "+(s.session?.name||"session pending")+" · "+(s.sentiment?.fundingCrowding||"funding unavailable");
 $("eti-strategy-rsi").textContent="RSI "+(s.indicators.rsi14===null?"—":fmt(s.indicators.rsi14,1));
 $("eti-strategy-ema").textContent=(s.indicators.ema20&&s.indicators.ema50?(s.indicators.ema20>s.indicators.ema50?"EMA20 > EMA50":"EMA20 < EMA50"):"EMA stack pending")+" · MACD "+(s.indicators.macd?fmt(s.indicators.macd.histogram,6):"—")+" · 24h turnover $"+fmt(s.sentiment?.turnover24h,0)+" · OI "+fmt(s.sentiment?.openInterest,0);
 $("eti-strategy-entry").textContent=s.entry?fmt(s.entry,8):"—";$("eti-strategy-stop").textContent="Stop "+(s.stop?fmt(s.stop,8):"—");
 $("eti-strategy-target").textContent=s.target1?fmt(s.target1,8):"—";$("eti-strategy-rr").textContent="Target model "+(s.riskReward||"—")+"R · Hedge: "+(s.hedgeAssessment||"pending");
 syncRiskDisplay();
 const p=s.positionPlan,plan=$("eti-risk-plan");
 plan.textContent=p?["Sizing: "+(p.valid?"VALID":"BLOCKED"),"Requested risk budget: $"+fmt(p.riskBudget,2),"Actual planned loss: $"+fmt(p.plannedLoss,2)+" ("+fmt(p.actualRiskPercent,2)+"%)","Notional / margin: $"+fmt(p.notional,2)+" / $"+fmt(p.margin,2),"Quantity: "+fmt(p.quantity,4),"Stop / estimated liquidation buffer: "+fmt(p.stopDistancePct,2)+"% / "+fmt(p.estimatedLiquidationBufferPct,2)+"%",p.reason].join("\n"):"No directional setup; no position sizing.";
 const levels=s.supportResistanceHeatmap||[],levelEl=$("eti-sr-levels");
 levelEl.textContent=levels.length?levels.slice(0,10).map(z=>z.type.toUpperCase()+" · "+fmt(z.price,8)+" · "+z.source+" · strength "+fmt(z.strength,2)).join("\n"):"No qualified zones yet.";
 drawSrHeatmap(levels);
}
function drawSrHeatmap(zones){
 const c=$("eti-sr-canvas");if(!c)return;const rect=c.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(320,rect.width),h=Math.max(220,rect.height);c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);const x=c.getContext("2d");x.scale(dpr,dpr);x.fillStyle="#061321";x.fillRect(0,0,w,h);
 const rows=state.candles||[];if(!rows.length){x.fillStyle="#8ea6c2";x.fillText("Waiting for candle history…",16,28);return;}
 const recent=rows.slice(-100),lo=Math.min(...recent.map(r=>r[3])),hi=Math.max(...recent.map(r=>r[2])),span=hi-lo||Math.max(hi*.001,1e-8),left=62,right=14,top=18,bottom=28,plotH=h-top-bottom;
 const y=p=>top+(hi-p)/span*plotH;x.strokeStyle="#29435f";x.fillStyle="#8ea6c2";x.font="10px system-ui";for(let i=0;i<=4;i++){const p=hi-span*i/4,yy=y(p);x.beginPath();x.moveTo(left,yy);x.lineTo(w-right,yy);x.stroke();x.fillText(fmt(p,8),5,yy+3);}
 zones.forEach(z=>{const yy=y(z.price);if(yy<top||yy>h-bottom)return;x.fillStyle=z.type==="support"?"rgba(65,217,180,"+Math.min(.42,.12+z.strength*.2)+")":"rgba(255,112,139,"+Math.min(.42,.12+z.strength*.2)+")";x.fillRect(left,yy-5,w-left-right,10);x.fillStyle=z.type==="support"?"#61d9c2":"#ff899d";x.fillText(z.type==="support"?"S":"R",w-27,yy-7);});
 const last=rows[rows.length-1][4],ly=y(last);x.strokeStyle="#f5d27a";x.setLineDash([4,4]);x.beginPath();x.moveTo(left,ly);x.lineTo(w-right,ly);x.stroke();x.setLineDash([]);x.fillStyle="#f5d27a";x.fillText("LAST "+fmt(last,8),left+5,Math.max(top+10,ly-7));
}
function drawHeatmap(){
 const c=$("eti-liq-canvas");if(!c)return;const rect=c.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(320,rect.width),h=Math.max(220,rect.height);
 c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);const x=c.getContext("2d");x.scale(dpr,dpr);x.fillStyle="#061321";x.fillRect(0,0,w,h);
 const samples=state.history;if(!samples.length){x.fillStyle="#8ea6c2";x.fillText("Waiting for historical depth snapshots…",16,28);return;}
 const all=[];samples.forEach(s=>{(s.bids||[]).forEach(v=>all.push(v[0]));(s.asks||[]).forEach(v=>all.push(v[0]));});
 let lo=Math.min(...all),hi=Math.max(...all);if(!(hi>lo)){lo*=.999;hi*=1.001;}const pad=(hi-lo)*.06;lo-=pad;hi+=pad;
 const left=58,right=12,top=14,bottom=28,plotW=w-left-right,plotH=h-top-bottom,cellW=plotW/samples.length;
 const maxN=Math.max(1,...samples.flatMap(s=>[...(s.bids||[]),...(s.asks||[])].map(v=>v[0]*v[1])));
 const y=p=>top+(hi-p)/(hi-lo)*plotH;
 samples.forEach((s,i)=>{const xx=left+i*cellW;(s.bids||[]).forEach(v=>{const yy=y(v[0]),int=Math.sqrt(v[0]*v[1]/maxN);x.fillStyle="rgba(42,190,170,"+(0.08+int*.78)+")";x.fillRect(xx,yy-2,Math.max(1,cellW+.5),4);});(s.asks||[]).forEach(v=>{const yy=y(v[0]),int=Math.sqrt(v[0]*v[1]/maxN);x.fillStyle="rgba(239,91,119,"+(0.08+int*.78)+")";x.fillRect(xx,yy-2,Math.max(1,cellW+.5),4);});});
 x.strokeStyle="#29435f";x.lineWidth=1;x.setLineDash([3,4]);for(let i=0;i<5;i++){const yy=top+i*plotH/4;x.beginPath();x.moveTo(left,yy);x.lineTo(w-right,yy);x.stroke();x.fillStyle="#8ea6c2";x.fillText(fmt(hi-i*(hi-lo)/4,6),5,yy+3);}x.setLineDash([]);
 if(state.analysis){const yy=y(state.analysis.mid);x.strokeStyle="#f3d27b";x.lineWidth=1.3;x.beginPath();x.moveTo(left,yy);x.lineTo(w-right,yy);x.stroke();x.fillStyle="#f3d27b";x.fillText("MID",left+4,Math.max(10,yy-5));}
 x.fillStyle="#8ea6c2";x.fillText("OLDER",left,h-8);x.textAlign="right";x.fillText("LIVE",w-right,h-8);x.textAlign="left";
 if(state.scenarios&&state.analysis){const mid=state.analysis.mid;[5,10,20,50].forEach(L=>{const p1=mid*(1-1/L+.005),p2=mid*(1+1/L-.005);x.fillStyle="rgba(42,190,170,.10)";x.fillRect(left,y(p1)-3,plotW,6);x.fillStyle="rgba(239,91,119,.10)";x.fillRect(left,y(p2)-3,plotW,6);});}
}
function buildStructureMap(rows){
 const c=(rows||[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(v=>Number.isFinite(Number(v)))&&Number(r[1])>0&&Number(r[2])>=Number(r[3])).slice(-300);
 const fvg=[],orderBlocks=[],events=[];if(c.length<12)return {fvg,orderBlocks,events};
 const tr=c.map((r,i)=>i?Math.max(r[2]-r[3],Math.abs(r[2]-c[i-1][4]),Math.abs(r[3]-c[i-1][4])):r[2]-r[3]);
 const atr=i=>{const a=tr.slice(Math.max(0,i-13),i+1);return a.reduce((x,y)=>x+y,0)/Math.max(1,a.length);};
 for(let i=2;i<c.length;i++){
  const a=c[i-2],b=c[i-1],z=c[i],bull=Number(a[2])<Number(z[3]),bear=Number(a[3])>Number(z[2]);
  if(bull||bear){const low=bull?Number(a[2]):Number(z[2]),high=bull?Number(z[3]):Number(a[3]),future=c.slice(i+1);const mitigated=bull?future.some(x=>Number(x[3])<=high):future.some(x=>Number(x[2])>=low);fvg.push({direction:bull?"bullish":"bearish",low,high,time:Number(z[0]),endTime:Number(c[c.length-1][0]),unmitigated:!mitigated,mitigated});}
  if(i<12)continue;
  const prior=c.slice(i-12,i),priorHigh=Math.max(...prior.map(x=>Number(x[2]))),priorLow=Math.min(...prior.map(x=>Number(x[3]))),body=Math.abs(Number(z[4])-Number(z[1])),bullBreak=Number(z[4])>priorHigh&&Number(z[4])>Number(z[1])&&body>=atr(i)*1.35,bearBreak=Number(z[4])<priorLow&&Number(z[4])<Number(z[1])&&body>=atr(i)*1.35;
  if(bullBreak||bearBreak){let ob=-1;for(let j=i-1;j>=Math.max(0,i-6);j--){if((bullBreak&&Number(c[j][4])<Number(c[j][1]))||(bearBreak&&Number(c[j][4])>Number(c[j][1]))){ob=j;break;}}
   if(ob>=0){const o=c[ob],low=Number(o[3]),high=Number(o[2]),future=c.slice(i+1),invalidated=bullBreak?future.some(x=>Number(x[4])<low):future.some(x=>Number(x[4])>high);orderBlocks.push({direction:bullBreak?"bullish":"bearish",low,high,time:Number(o[0]),breakTime:Number(z[0]),unmitigated:!invalidated,invalidated});}
   const previous=events[events.length-1],direction=bullBreak?"bullish":"bearish",type=previous&&previous.direction!==direction?"CHoCH":"BOS";events.push({type,direction,time:Number(z[0]),price:Number(bullBreak?priorHigh:priorLow),index:i});
  }
 }
 return {fvg:fvg.slice(-35),orderBlocks:orderBlocks.slice(-20),events:events.slice(-20)};
}
function createChartOverlay(){
 const host=state.root?(window.ETILiveChart?.isAdvanced?.()?document.querySelector("#chartAdvanced"):document.querySelector("#liveChartFrame")):document.querySelector("#tt-chart");if(!host||host.querySelector(".eti-liq-overlay"))return;
 if(getComputedStyle(host).position==="static")host.style.position="relative";
 const c=document.createElement("canvas");c.className="eti-liq-overlay";c.setAttribute("aria-hidden","true");host.appendChild(c);state.overlayCanvas=c;
}
function drawOverlay(){
 const c=state.overlayCanvas;if(!c)return;const zones=state.analysis?.strategy?.supportResistanceHeatmap||[],host=c.parentElement;if(!host)return;
 c.classList.toggle("eti-liq-hidden",!state.overlay);const w=host.clientWidth,h=host.clientHeight,dpr=Math.min(2,window.devicePixelRatio||1);c.width=Math.max(1,Math.round(w*dpr));c.height=Math.max(1,Math.round(h*dpr));const x=c.getContext("2d");x.setTransform(dpr,0,0,dpr,0,0);x.clearRect(0,0,w,h);
 const rows=state.candles||[],bridge=state.root?window.ETILiveChart:window.ETIProTerminalChart;if(rows.length<2)return;
 const price=p=>{const v=bridge&&bridge.priceToCoordinate?bridge.priceToCoordinate(Number(p)):null;if(Number.isFinite(v))return v;const vals=rows.slice(-180).flatMap(r=>[Number(r[2]),Number(r[3])]),lo=Math.min(...vals),hi=Math.max(...vals);return hi>lo?(hi-Number(p))/(hi-lo)*h:null;};
 const time=t=>{const v=bridge&&bridge.timeToCoordinate?bridge.timeToCoordinate(Number(t)):null;if(Number.isFinite(v))return v;const i=rows.findIndex(r=>Number(r[0])>=Number(t));return i<0?w:Math.max(0,i/rows.length*w);};
 const right=w,left=0;
 function band(z,color,label,alpha){const a=price(z.high),b=price(z.low);if(a===null||b===null||!Number.isFinite(a)||!Number.isFinite(b))return;const top=Math.max(0,Math.min(a,b)),bottom=Math.min(h,Math.max(a,b));if(bottom<0||top>h)return;const xx=Math.max(left,Math.min(right,time(z.time||rows[0][0])));x.fillStyle=color.replace("ALPHA",String(alpha));x.fillRect(xx,top,Math.max(1,right-xx),Math.max(2,bottom-top));x.strokeStyle=color.replace("ALPHA","0.72");x.setLineDash([5,4]);x.beginPath();x.moveTo(xx,top);x.lineTo(right,top);x.moveTo(xx,bottom);x.lineTo(right,bottom);x.stroke();x.setLineDash([]);x.fillStyle=color.replace("ALPHA","0.95");x.font="10px system-ui";x.fillText(label,Math.max(4,xx+5),Math.max(12,top-3));}
 const st=state.structure||{fvg:[],orderBlocks:[],events:[]};
 if(state.layers.fvg){st.fvg.filter(z=>z.unmitigated).forEach(z=>band(z,z.direction==="bullish"?"rgba(37,213,160,ALPHA)":"rgba(243,106,128,ALPHA)","UNMITIGATED FVG",.13));st.fvg.filter(z=>!z.unmitigated).slice(-8).forEach(z=>band(z,"rgba(230,195,106,ALPHA)","FVG",.055));}
 if(state.layers.orderBlocks)st.orderBlocks.filter(z=>z.unmitigated).forEach(z=>band(z,z.direction==="bullish"?"rgba(86,173,255,ALPHA)":"rgba(181,140,255,ALPHA)","ORDER BLOCK",.13));
 if(state.layers.sr)zones.slice(0,20).forEach(z=>band(z,z.type==="support"?"rgba(37,213,160,ALPHA)":"rgba(243,106,128,ALPHA)",z.type==="support"?"SUPPORT":"RESISTANCE",Math.max(.035,Math.min(.10,Number(z.strength||1)*.06))));
 if(state.layers.liquidity){const walls=state.analysis?.walls||{bids:[],asks:[]};[...(walls.bids||[]).slice(0,8),...(walls.asks||[]).slice(0,8)].forEach(v=>{const yy=price(v.price);if(!Number.isFinite(yy)||yy<0||yy>h)return;const bid=v.side==="bid";x.fillStyle=bid?"rgba(37,213,160,.13)":"rgba(243,106,128,.13)";x.fillRect(0,yy-3,w,6);x.strokeStyle=bid?"rgba(37,213,160,.65)":"rgba(243,106,128,.65)";x.setLineDash([3,5]);x.beginPath();x.moveTo(0,yy);x.lineTo(w,yy);x.stroke();x.setLineDash([]);});}
 if(state.layers.structure){st.events.forEach(e=>{const xx=time(e.time);if(!Number.isFinite(xx)||xx<0||xx>w)return;const choch=e.type==="CHoCH";x.fillStyle=choch?"rgba(181,140,255,.12)":"rgba(86,173,255,.10)";x.fillRect(xx,0,Math.max(2,w/Math.max(100,rows.length)),h);const yy=price(e.price);if(Number.isFinite(yy)){x.strokeStyle=choch?"#b58cff":"#56adff";x.setLineDash([6,4]);x.beginPath();x.moveTo(0,yy);x.lineTo(w,yy);x.stroke();x.setLineDash([]);}x.fillStyle=choch?"#c5a5ff":"#7fc4ff";x.font="10px system-ui";x.fillText(e.type+" "+e.direction.toUpperCase(),Math.min(w-90,xx+4),14+(e.index%3)*12);});}
}
function stopStream(){if(state.ws){try{state.ws.close();}catch(e){}state.ws=null;}}
function startStream(){
 stopStream();if(state.venue!=="bitget"||!window.ETIBitget?.subscribe)return;
 try{state.ws=window.ETIBitget.subscribe({symbol:state.symbol,market:state.market==="futures"?"futures":"spot",category:state.category,interval:state.interval},{onStatus:s=>{if(s.connected)setFeed("Bitget WebSocket connected · "+state.category,true);else if(s.state==="error"||s.state==="reconnecting")setFeed("Bitget stream "+s.state+" · "+(s.detail||"REST recovery active"),false);},onMessage:m=>{if(m.type==="ticker"&&m.data){const t=m.data;state.marketMetrics={turnover24h:t.quoteVolume,volume24h:t.volume,priceChange24h:t.priceChangePercent,high24h:t.highPrice,low24h:t.lowPrice};state.derivatives={fundingRate:t.fundingRate,openInterest:t.openInterest,timestamp:t.timestamp,source:"bitget-websocket"};}else if(m.type==="depth"&&m.data?.bids?.length&&m.data?.asks?.length){state.previous=state.depth;state.depth={...m.data,timestamp:m.timestamp};state.trades=state.trades.slice(0,200);const snap={t:Date.now(),mid:(m.data.bids[0][0]+m.data.asks[0][0])/2,bids:m.data.bids.slice(0,45),asks:m.data.asks.slice(0,45)};state.history.push(snap);state.history=state.history.slice(-maxHistory);saveHistory();analyzeStreamDepth();}else if(m.type==="trades"){state.trades=normalizeTrades(m.data,"bitget").concat(state.trades).slice(0,300);}else if(m.type==="candle"){const r=m.data;if(Array.isArray(r)&&r.length>=6){const row=r.map(Number);if(row.every(Number.isFinite)&&row[0]>0&&row[4]>0){const last=state.candles.at(-1);if(last&&Number(last[0])===row[0])state.candles[state.candles.length-1]=row;else state.candles.push(row);state.candles=state.candles.slice(-300);state.candleAt=Date.now();state.structure=buildStructureMap(state.candles);drawOverlay();}}}}});}catch(e){setFeed("Bitget WebSocket unavailable · REST fallback",false);}
}
let analyzeAt=0;
async function analyzeStreamDepth(){
 if(!state.depth||Date.now()-analyzeAt<900)return;analyzeAt=Date.now();const key=[state.venue,state.market,state.category,state.symbol].join("|");
 try{const r=await fetch("/api/liquidity/analyze",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({symbol:state.symbol,venue:state.venue,market:state.market,category:state.category,depth:state.depth,previousDepth:state.previous,history:state.history.slice(-45).map(s=>({timestamp:s.t,bids:s.bids,asks:s.asks})),trades:state.trades,candles:state.candles,candlesByTimeframe:state.candlesByTimeframe,derivatives:state.derivatives,marketMetrics:state.marketMetrics,risk:{capital:state.equity,leverage:20,riskPercent:30,maxMarginPercent:30,compoundProfits:true}})});const a=await r.json();if(key!==[state.venue,state.market,state.category,state.symbol].join("|"))return;if(r.ok){state.analysis=a;await loadOrderFlow();render();drawHeatmap();drawOverlay();}}catch(e){}
}
function restart(){
 state.sequence++;state.busy=false;readContext();stopStream();state.depth=null;state.previous=null;state.trades=[];state.candles=[];state.candleAt=0;state.analysis=null;state.candlesByTimeframe={};state.signalAt=0;state.derivatives=null;state.marketMetrics=null;state.history=[];restoreHistory();mount();createChartOverlay();poll(true);startStream();
}
function watchControls(){
 const ids=isRoot()?["symVenue","symMarket","symCat","symbol","interval"]:["tt-venue","tt-market","tt-category","tt-symbol","tt-interval"];
 ids.forEach(id=>{const el=$(id);if(el){el.addEventListener("change",restart);if(id==="symbol"||id==="tt-symbol")el.addEventListener("keydown",e=>{if(e.key==="Enter")setTimeout(restart,100);});}});
 document.querySelectorAll("[data-eti-layer]").forEach(b=>b.addEventListener("click",()=>{const key=b.dataset.etiLayer;state.layers[key]=!state.layers[key];b.classList.toggle("on",state.layers[key]);drawOverlay();}));
 window.addEventListener("resize",()=>{drawHeatmap();drawOverlay();});
}
readContext();restoreHistory();mount();createChartOverlay();watchControls();poll(true);startStream();
state.timer=setInterval(()=>poll(false),state.venue==="bitget"?5000:3000);
window.ETILiquidity={refresh:()=>poll(true),getState:()=>({symbol:state.symbol,venue:state.venue,market:state.market,history:state.history.length,analysis:state.analysis,feedError:state.lastError})};
})();`;
