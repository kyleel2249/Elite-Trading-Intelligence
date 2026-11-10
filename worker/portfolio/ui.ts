/**
 * Dashboard fragments for the live portfolio: Open Orders, Positions, Closed Trades, Performance, and the chart trade layer.
 * These strings are interpolated into the dashboard template literal in worker/index.ts, so they must contain no backticks,
 * no dollar-brace sequences and no backslashes.
 * Everything shown is read from /api/portfolio/* (the persistent ledger). Nothing here invents a fill, price, balance or P&L.
 */
export const PORTFOLIO_CSS = `
.pf{margin-top:14px}.pf h2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.pf h3{font-size:13px;margin:18px 0 8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pfbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px}.pfbar select,.pfbar button,.pfbar input{padding:6px 10px;font-size:12px}
.pfstat{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}.pfstat i{width:8px;height:8px;border-radius:50%;background:#4a5d78;display:inline-block}.pfstat.ok i{background:#21d69a}.pfstat.poll i{background:#f0c674}.pfstat.off i{background:#ff637d}
.pfkpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:6px 0 10px}.pfkpi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#0b1422}.pfkpi span{display:block;font-size:11px;color:var(--muted)}.pfkpi b{font-size:15px}
.pfnote{border:1px solid #b65c38;color:#ffb08c;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.pfinfo{border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}
.pfwrap{overflow-x:auto;border:1px solid #1d2a3e;border-radius:10px}.pf table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.pf th{color:var(--muted);text-align:left;font-weight:600;padding:7px 9px;border-bottom:1px solid #1d2a3e;position:sticky;top:0;background:#0d1624}.pf td{padding:7px 9px;border-bottom:1px solid #16233a}.pf tr:last-child td{border-bottom:0}.pf td.num,.pf th.num{text-align:right;font-variant-numeric:tabular-nums}
.pf .pos{color:#21d69a}.pf .neg{color:#ff637d}.pf .buy{color:#21d69a}.pf .sell{color:#ff637d}.pf .empty{padding:14px;color:var(--muted);text-align:center}
.pfchip{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:0 8px;font-size:11px}.pfchip.pending{color:#8fa3bd}.pfchip.open{color:#56a8ff}.pfchip.partially_filled{color:#f0c674}.pfchip.filled{color:#21d69a}.pfchip.cancelled,.pfchip.expired{color:#8fa3bd}.pfchip.rejected{color:#ff637d}
.pf button.mini{padding:2px 9px;font-size:11px;border-radius:6px}.pf button.danger{border-color:#7c2f3d;color:#ff9aab}
.pffilters{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 8px}.pffilters input,.pffilters select{padding:6px 8px;font-size:12px;min-width:0}
.pfperf{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px;align-items:start}.pfcurve{height:220px;border:1px solid #1d2a3e;border-radius:10px;background:#0b1422}.pfstats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
.pflev{display:none;border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0;background:#0b1422}.pflev.on{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.pflev label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--muted)}.pflev input{padding:6px 8px;width:110px}
.pfpop{position:absolute;display:none;z-index:6;background:#0b1422f7;border:1px solid var(--blue);border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.6;box-shadow:0 8px 28px #000a;max-width:290px;white-space:normal}.pfpop button{float:right;padding:0 7px;margin:-4px -6px 0 8px}
.planbox{grid-column:1/-1;border:1px dashed var(--line);border-radius:8px;padding:8px;display:none}.planbox.on{display:block}.planbox .row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}.planbox label{font-size:11px}.planbox input{width:100%;padding:6px}
@media(max-width:900px){.pfperf{grid-template-columns:1fr}}
@media(max-width:700px){.pfkpis{grid-template-columns:repeat(2,minmax(0,1fr))}.planbox .row{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

export const PORTFOLIO_HTML = `
<section class="panel pf" id="portfolioPanel" aria-label="Live portfolio">
<h2><span>Portfolio: Open Orders, Positions and P&amp;L</span><span id="pfStatus" class="pfstat" role="status"><i></i><span>Connecting…</span></span></h2>
<div class="pfbar"><label class="muted" for="pfEnv">Environment</label><select id="pfEnv" aria-label="Portfolio environment"><option value="internal_paper">Internal Paper (simulated)</option><option value="exchange_testnet">Exchange Testnet</option><option value="live">Live (disabled)</option></select><button id="pfSync" class="mini" title="Match resting paper orders now / pull the broker's latest order and fill state">Sync now</button><button id="pfReconcile" class="mini" title="Check the ledger against the environment">Reconcile</button><span id="pfSource" class="muted"></span></div>
<div id="pfNotes"></div>
<div id="pfKpis" class="pfkpis"></div>
<h3>Open Orders <label class="muted"><input type="checkbox" id="pfAllOrders"> include filled, cancelled, rejected and expired</label></h3>
<div class="pfwrap"><div id="pfOrders"></div></div>
<h3>Active Holdings and Positions</h3>
<div class="pfwrap"><div id="pfPositions"></div></div>
<div id="pfLev" class="pflev"></div>
<h3>Closed Trades <a id="pfCsv" class="muted" href="#" download>Export CSV</a></h3>
<div class="pffilters"><input id="pfFSymbol" placeholder="Symbol" size="8" aria-label="Filter by symbol"><input id="pfFFrom" type="date" aria-label="From date"><input id="pfFTo" type="date" aria-label="To date"><input id="pfFStrategy" placeholder="Strategy" size="10" aria-label="Filter by strategy"><select id="pfFResult" aria-label="Filter by result"><option value="">Win and loss</option><option value="win">Profitable</option><option value="loss">Losing</option><option value="breakeven">Breakeven</option></select><select id="pfFSource" aria-label="Filter by source"><option value="">Any source</option><option value="internal_sim">Internal Paper</option><option value="exchange_reported">Exchange Testnet</option></select><button id="pfFClear" class="mini">Clear</button></div>
<div class="pfwrap"><div id="pfClosed"></div></div>
<h3>Portfolio Performance</h3>
<div class="pfperf"><div><canvas id="pfCurve" class="pfcurve" role="img" aria-label="Equity curve from actual fills"></canvas><div id="pfCurveNote" class="muted" style="font-size:11px;margin-top:4px"></div></div><div id="pfStats" class="pfstats"></div></div>
<details style="margin-top:12px"><summary class="muted">Ledger integrity (anomalies and reconciliation)</summary><div id="pfIntegrity" class="muted" style="font-size:12px;margin-top:6px"></div></details>
</section>
`;

export const PLAN_HTML = `
<div class="planbox" id="planBox"><div class="row"><label>Stop loss<input id="planStop" type="number" step="any" min="0"></label><label>TP1<input id="planTp1" type="number" step="any" min="0"></label><label>TP2<input id="planTp2" type="number" step="any" min="0"></label><label>TP3<input id="planTp3" type="number" step="any" min="0"></label></div><div class="execution-actions" style="margin-top:6px;padding:0"><button type="button" id="planFromSignal" title="Copy the current ETI engine entry/stop/targets (long setups only)">Use ETI signal levels</button><button type="button" id="planClear">Clear</button></div><div id="planNote" class="muted" style="font-size:11px;margin-top:4px">Internal paper exits automatically at the stop and TP1/TP2/TP3 (40/30/30, stop first). On exchange testnet these levels are alert-only.</div></div>
`;

export const PORTFOLIO_JS = `
/* ===== live portfolio: ledger-backed panels + chart trade layer ===== */
const pf={env:'internal_paper',state:null,timer:null,fails:0,okAt:0,busy:false,pollMs:15000,allOrders:false,closedRows:null,hits:[],pop:null,lastPx:null,levEdit:null};
const pfEsc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pfNum=(v,d)=>{if(v==null||!isFinite(v))return '—';const dd=d==null?2:d,m=Math.abs(v)>=1||v===0?dd:Math.max(dd,6);return Number(v).toLocaleString(undefined,{minimumFractionDigits:Math.min(dd,m),maximumFractionDigits:m});};
const pfQty=v=>v==null||!isFinite(v)?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:8});
const pfMoney=(v,sign)=>v==null||!isFinite(v)?'—':(sign&&v>0?'+':'')+pfNum(v,2);
const pfCls=v=>v==null||!isFinite(v)||Math.abs(v)<1e-9?'':v>0?'pos':'neg';
const pfTime=t=>t?new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const pfDur=ms=>{if(ms==null)return '—';const s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m?m+'m '+(s%60)+'s':s+'s';};
const PF_STATUS={pending:'Pending',open:'Open',partially_filled:'Partially Filled',filled:'Filled',cancelled:'Cancelled',rejected:'Rejected',expired:'Expired'};
const PF_BROKER={binance_testnet:'binance',alpaca_paper:'alpaca',eti_paper:'eti_paper'};
function pfEnvOfBroker(){return $('orderBroker').value==='eti_paper'?'internal_paper':'exchange_testnet';}
function pfHeaders(json){const h={};if(json)h['content-type']='application/json';const t=$('executionToken')?$('executionToken').value:'';if(t)h.Authorization='Bearer '+t;return h;}
async function pfCall(path,body){
 const go=()=>fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:pfHeaders(!!body),body:body?JSON.stringify(body):undefined});
 let r=await go();
 if(r.status===401&&!($('executionToken')&&$('executionToken').value)){await startSessions();r=await go();}
 const d=await r.json().catch(()=>({}));return {r,d};
}
function pfSetStatus(kind,text){const e=$('pfStatus');e.className='pfstat '+kind;e.lastChild.textContent=text;}
function pfSchedule(ms){clearTimeout(pf.timer);pf.timer=setTimeout(pfLoad,ms);}
function pfNextDelay(){
 if(pf.fails)return Math.min(60000,3000*Math.pow(2,pf.fails-1));
 if(document.hidden)return 60000;
 const s=pf.state;return s&&((s.openOrders&&s.openOrders.length)||(s.positions&&s.positions.length))?4000:15000;
}
async function pfLoad(){
 if(pf.busy){pf.again=true;return;}pf.busy=true;pf.again=false;
 const env=pf.env;
 try{
  const q='/api/portfolio/state?environment='+env,{r,d}=await pfCall(q);
  if(env!==pf.env)return;
  if(r.status===403){pf.state=null;pfSetStatus('off','No '+pf.env.replace('_',' ')+' session');pfRender();pf.fails=0;pfSchedule(20000);return;}
  if(!r.ok)throw Error(d.message||d.error||('HTTP '+r.status));
  pf.state=d;pf.fails=0;pf.okAt=Date.now();pf.pollMs=pfNextDelay();
  pfSetStatus(document.hidden?'poll':'ok',d.disabled?'Disabled':'Synced · every '+Math.round(pf.pollMs/1000)+'s');
  pfRender();drawChart();pfSchedule(pf.pollMs);
 }catch(e){pf.fails++;const d=pfNextDelay();pfSetStatus('off','Offline · retrying in '+Math.round(d/1000)+'s'+(pf.state?' · showing last data':''));pfSchedule(d);}
 finally{pf.busy=false;if(pf.again){pf.again=false;setTimeout(pfLoad,50);}}
}
function pfKick(){clearTimeout(pf.timer);pfLoad();setTimeout(pfLoad,2500);}
function pfMark(p){const sym=$('symbol').value;if(p.symbol===sym&&candles.length){const px=candles[candles.length-1][4];if(px>0)return {px,src:'chart'};}return p.markPrice!=null?{px:p.markPrice,src:p.markStale?'stale':'server'}:{px:null,src:'none'};}
function pfLive(){
 const s=pf.state;if(!s||!s.positions)return null;let unreal=0,value=0,ok=true;
 const rows=s.positions.map(p=>{const m=pfMark(p),u=m.px==null?null:(m.px-p.avgEntry)*p.qty;if(m.px==null)ok=false;else{unreal+=u;value+=m.px*p.qty;}return {p,m,u,pct:m.px==null?null:(m.px/p.avgEntry-1)*100,v:m.px==null?null:m.px*p.qty};});
 const b=s.balances||{},equity=ok&&b.cash!=null?b.cash+value:null;
 return {rows,unreal:ok?unreal:null,value:ok?value:null,equity,total:equity!=null&&b.starting?equity-b.starting:null,totalPct:equity!=null&&b.starting?(equity/b.starting-1)*100:null};
}
function pfRender(){
 const s=pf.state;
 $('pfEnv').value=pf.env;
 if(!s){$('pfNotes').innerHTML='<div class="pfinfo">No portfolio session for this environment yet. Sessions start automatically; exchange testnet needs credentials in Cloudflare secrets.</div>';['pfKpis','pfOrders','pfPositions','pfClosed','pfStats'].forEach(i=>$(i).innerHTML='');return;}
 if(s.disabled||s.unavailable){$('pfNotes').innerHTML='<div class="pfnote">'+pfEsc(s.message)+'</div>';['pfKpis','pfOrders','pfPositions','pfClosed','pfStats'].forEach(i=>$(i).innerHTML='');return;}
 $('pfSource').textContent=s.source||'';
 let notes='';
 if(s.environment==='exchange_testnet')notes+='<div class="pfinfo">Exchange testnet: fills and prices are exactly what the broker reported. ETI does not track the testnet cash balance (use Reconcile). Stop and take-profit levels here are alert-only; close manually.</div>';
 else notes+='<div class="pfinfo">Internal Paper: simulated by ETI against a persistent ledger. Fills use live public prices plus the configured slippage and fee; resting orders fill only when a closed 1-minute bar trades through their price. No exchange is contacted.</div>';
 (s.alerts||[]).forEach(a=>{notes+='<div class="pfnote">'+pfEsc(a.message)+'</div>';});
 if(s.marksStale&&s.marksStale.length)notes+='<div class="pfnote">No fresh price for '+pfEsc(s.marksStale.join(', '))+': showing the last known mark, unrealized P&amp;L may be out of date.</div>';
 if(s.truncated)notes+='<div class="pfnote">The ledger is longer than the display limit; older events are not folded in.</div>';
 $('pfNotes').innerHTML=notes;
 pfRenderKpis();pfRenderOrders();pfRenderPositions();pfRenderClosed();pfRenderPerf();pfRenderIntegrity();
}
function pfRenderKpis(){
 const s=pf.state;if(!s||!s.balances)return;const b=s.balances,L=pfLive()||{},st=s.stats||{},p=s.pnl||{};
 const k=(l,v,c,t)=>'<div class="pfkpi"'+(t?' title="'+pfEsc(t)+'"':'')+'><span>'+l+'</span><b class="'+(c||'')+'">'+v+'</b></div>';
 const cur=pfEsc(b.currency||'');
 $('pfKpis').innerHTML=
  k('Equity ('+cur+')',pfMoney(L.equity!=null?L.equity:b.equity),'',b.cash==null?'ETI does not hold a testnet cash balance':'Cash + open positions at the latest marks')+
  k('Available',pfMoney(b.available),'','Cash not reserved by open buy orders')+
  k('Unrealized P&amp;L',pfMoney(L.unreal!=null?L.unreal:p.unrealized,true),pfCls(L.unreal!=null?L.unreal:p.unrealized),'Open positions marked to the live price')+
  k('Realized P&amp;L (net)',pfMoney(p.realizedNet,true),pfCls(p.realizedNet),'Closed and partial exits, after known fees')+
  k('Daily P&amp;L',pfMoney(p.daily,true),pfCls(p.daily),'Since 00:00 UTC')+
  k('Total P&amp;L',pfMoney(L.total!=null?L.total:p.total,true)+(p.totalPct!=null?' ('+pfNum(L.totalPct!=null?L.totalPct:p.totalPct,2)+'%)':''),pfCls(L.total!=null?L.total:p.total))+
  k('Win rate',st.winRate==null?'—':pfNum(st.winRate*100,1)+'% ('+st.wins+'/'+st.trades+')')+
  k('Exposure',b.exposurePct==null?'—':pfNum(b.exposurePct,1)+'%','','Position value / equity');
}
function pfChip(o){return '<span class="pfchip '+o.status+'"'+(o.statusReason?' title="'+pfEsc(o.statusReason)+'"':'')+'>'+PF_STATUS[o.status]+'</span>';}
function pfRenderOrders(){
 const s=pf.state;if(!s)return;const rows=pf.allOrders?(s.orders||[]):(s.openOrders||[]);
 if(!rows.length){$('pfOrders').innerHTML='<div class="empty">'+(pf.allOrders?'No orders yet.':'No open orders.')+'</div>';return;}
 let h='<table><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th class="num">Quantity</th><th class="num">Filled</th><th class="num">Price</th><th>Status</th><th>Created</th><th>Updated</th><th>Venue</th><th></th></tr></thead><tbody>';
 rows.forEach(o=>{
  const price=o.type==='limit'?pfNum(o.limitPrice,2):o.type==='stop'?'stop '+pfNum(o.stopPrice,2):(o.avgFillPrice!=null?pfNum(o.avgFillPrice,2):'market');
  const act=o.status==='pending'||o.status==='open'||o.status==='partially_filled';
  h+='<tr><td>'+pfEsc(o.symbol)+'</td><td class="'+o.side+'">'+o.side.toUpperCase()+'</td><td>'+(o.type==='stop'?'STOP-LOSS':o.type.toUpperCase())+'</td><td class="num">'+pfQty(o.qty)+'</td><td class="num">'+pfQty(o.filledQty)+(o.avgFillPrice!=null?' @ '+pfNum(o.avgFillPrice,2):'')+'</td><td class="num">'+price+'</td><td>'+pfChip(o)+'</td><td>'+pfTime(o.createdAt)+'</td><td>'+pfTime(o.updatedAt)+'</td><td>'+pfEsc(o.venue)+'</td><td>'+(act?'<button class="mini danger" data-cancel="'+pfEsc(o.orderId)+'">Cancel</button>':'')+'</td></tr>';
 });
 $('pfOrders').innerHTML=h+'</tbody></table>';
}
function pfRenderPositions(){
 const s=pf.state,L=pfLive();if(!s||!L)return;
 if(!L.rows.length){$('pfPositions').innerHTML='<div class="empty">No open positions. A holding appears here only after a fill.</div>';return;}
 let h='<table><thead><tr><th>Symbol</th><th class="num">Quantity</th><th class="num">Avg entry</th><th class="num">Mark</th><th class="num">Value</th><th class="num">Unrealized</th><th class="num">Realized (net)</th><th class="num">Stop</th><th class="num">TP1</th><th class="num">TP2</th><th class="num">TP3</th><th>Status</th><th>Held</th><th></th></tr></thead><tbody>';
 L.rows.forEach(r=>{const p=r.p,tp=i=>p.levels.tp[i]==null?'—':(p.levels.hit[i]?'✓ ':'')+pfNum(p.levels.tp[i],2);
  h+='<tr><td>'+pfEsc(p.symbol)+'<div class="muted">'+pfEsc(p.venue)+'</div></td><td class="num">'+pfQty(p.qty)+(p.reservedQty?'<div class="muted">'+pfQty(p.reservedQty)+' in sell orders</div>':'')+'</td><td class="num">'+pfNum(p.avgEntry,2)+'</td><td class="num" title="'+(r.m.src==='chart'?'live chart price':r.m.src==='stale'?'last known, no fresh price':'server price')+'">'+pfNum(r.m.px,2)+(r.m.src==='stale'?' <span class="neg">stale</span>':'')+'</td><td class="num">'+pfMoney(r.v)+'</td><td class="num '+pfCls(r.u)+'">'+pfMoney(r.u,true)+'<div>'+(r.pct==null?'':(r.pct>0?'+':'')+pfNum(r.pct,2)+'%')+'</div></td><td class="num '+pfCls(p.realizedNet)+'">'+pfMoney(p.realizedNet,true)+'</td><td class="num">'+(p.levels.stop==null?'—':pfNum(p.levels.stop,2))+'</td><td class="num">'+tp(0)+'</td><td class="num">'+tp(1)+'</td><td class="num">'+tp(2)+'</td><td><span class="pfchip open">Open</span></td><td>'+pfDur(Date.now()-p.openedAt)+'</td><td><button class="mini" data-levels="'+pfEsc(p.symbol)+'">Levels</button> <button class="mini danger" data-close="'+pfEsc(p.symbol)+'">Close</button></td></tr>';});
 $('pfPositions').innerHTML=h+'</tbody></table>';
}
function pfFilters(){const q=new URLSearchParams();[['symbol','pfFSymbol'],['from','pfFFrom'],['to','pfFTo'],['strategy','pfFStrategy'],['result','pfFResult'],['source','pfFSource']].forEach(a=>{const v=$(a[1]).value.trim();if(v)q.set(a[0],v);});return q;}
function pfRenderClosed(){
 const s=pf.state;if(!s)return;const rows=pf.closedRows||s.closed||[];
 const q=pfFilters();q.set('environment',pf.env);q.set('format','csv');$('pfCsv').href='/api/portfolio/history?'+q.toString();
 if(!rows.length){$('pfClosed').innerHTML='<div class="empty">'+(pf.closedRows?'No closed trades match these filters.':'No closed trades yet.')+'</div>';return;}
 let h='<table><thead><tr><th>Symbol</th><th class="num">Qty</th><th class="num">Entry</th><th class="num">Exit</th><th>Entered</th><th>Exited</th><th>Held</th><th class="num">Gross P&amp;L</th><th class="num">Fees</th><th class="num">Net P&amp;L</th><th class="num">Slippage</th><th>Result</th><th>Strategy / signal</th><th>Source</th></tr></thead><tbody>';
 rows.forEach(t=>{const unk=t.unknownFees>0,src=t.fills.some(f=>f.origin==='internal_sim')?'Internal Paper':'Exchange Testnet';
  h+='<tr><td>'+pfEsc(t.symbol)+'</td><td class="num">'+pfQty(t.qty)+'</td><td class="num">'+pfNum(t.entryPrice,2)+'</td><td class="num">'+pfNum(t.exitPrice,2)+'</td><td>'+pfTime(t.entryAt)+'</td><td>'+pfTime(t.exitAt)+'</td><td>'+pfDur(t.holdingMs)+'</td><td class="num '+pfCls(t.gross)+'">'+pfMoney(t.gross,true)+'</td><td class="num"'+(unk?' title="'+t.unknownFees+' fill(s) had no fee reported by the broker"':'')+'>'+pfMoney(t.fees)+(unk?' +?':'')+'</td><td class="num '+pfCls(t.net)+'"'+(unk?' title="Excludes fees the broker did not report"':'')+'>'+pfMoney(t.net,true)+(unk?'*':'')+'</td><td class="num">'+pfMoney(t.slippageCost)+'</td><td class="'+(t.result==='win'?'pos':t.result==='loss'?'neg':'')+'">'+t.result.toUpperCase()+'</td><td>'+pfEsc(t.strategy||'manual')+(t.signalId?'<div class="muted">'+pfEsc(t.signalId)+'</div>':'')+'</td><td>'+src+'</td></tr>';});
 $('pfClosed').innerHTML=h+'</tbody></table>';
}
let pfFTimer=null;
async function pfApplyFilters(){
 const q=pfFilters();
 if(![...q.keys()].length){pf.closedRows=null;pfRenderClosed();return;}
 q.set('environment',pf.env);
 const {r,d}=await pfCall('/api/portfolio/history?'+q.toString());
 if(r.ok){pf.closedRows=d.trades;pfRenderClosed();}
}
function pfRenderPerf(){
 const s=pf.state;if(!s||!s.stats)return;const st=s.stats,b=s.balances,L=pfLive()||{};
 const k=(l,v,t)=>'<div class="pfkpi"'+(t?' title="'+pfEsc(t)+'"':'')+'><span>'+l+'</span><b>'+v+'</b></div>';
 $('pfStats').innerHTML=k('Trades',st.trades)+k('Win rate',st.winRate==null?'—':pfNum(st.winRate*100,1)+'%')+k('Avg win',pfMoney(st.avgWin))+k('Avg loss',pfMoney(st.avgLoss))+k('Profit factor',st.profitFactor==null?'—':pfNum(st.profitFactor,2))+k('Best / worst',pfMoney(st.bestTrade)+' / '+pfMoney(st.worstTrade))+k('Fees paid',pfMoney(s.pnl.fees),st.unknownFees?'Some fills had no reported fee':'')+k('Slippage cost',pfMoney(s.slippageCost!=null?s.slippageCost:st.slippageCost))+k('Position value',pfMoney(L.value!=null?L.value:b.positionValue))+k('Start balance',pfMoney(b.starting));
 pfDrawCurve();
}
function pfDrawCurve(){
 const c=$('pfCurve'),s=pf.state;if(!c||!s)return;const r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);
 const pts=(s.curve||[]).filter(p=>p.equity!=null);const live=pfLive();if(live&&live.equity!=null)pts.push({t:Date.now(),equity:live.equity});
 $('pfCurveNote').textContent=pts.length<2?'':'Equity = cash + positions at the last fill or mark prices. Points exist only where a fill or price mark was recorded.';
 if(pts.length<2){x.fillStyle=C.muted;x.font=FONT;x.fillText(s.balances&&s.balances.cash==null?'ETI does not track a testnet balance, so there is no equity curve here.':'The equity curve starts after the first fill.',12,24);return;}
 let lo=Infinity,hi=-Infinity;pts.forEach(p=>{if(p.equity<lo)lo=p.equity;if(p.equity>hi)hi=p.equity;});const pad=(hi-lo)*.1||Math.max(1,hi*.001);lo-=pad;hi+=pad;
 const t0=pts[0].t,t1=pts[pts.length-1].t||t0+1,L=48,R=8,T=10,B=18,X=t=>L+(t-t0)/(t1-t0||1)*(w-L-R),Y=v=>T+(hi-v)/(hi-lo)*(h-T-B);
 x.font=FONT;x.fillStyle=C.muted;x.strokeStyle=C.grid;x.lineWidth=1;
 for(let i=0;i<=3;i++){const v=hi-(hi-lo)*i/3,y=Y(v);x.beginPath();x.moveTo(L,y);x.lineTo(w-R,y);x.stroke();x.fillText(pfNum(v,0),2,y+4);}
 const base=s.balances.starting;if(base!=null&&base>lo&&base<hi){x.setLineDash([3,3]);x.strokeStyle=C.muted;x.beginPath();x.moveTo(L,Y(base));x.lineTo(w-R,Y(base));x.stroke();x.setLineDash([]);}
 const up=pts[pts.length-1].equity>=pts[0].equity;x.strokeStyle=up?C.up:C.down;x.lineWidth=1.8;x.beginPath();pts.forEach((p,i)=>{if(i)x.lineTo(X(p.t),Y(p.equity));else x.moveTo(X(p.t),Y(p.equity));});x.stroke();
 x.fillStyle=C.muted;x.fillText(new Date(t0).toLocaleDateString(),L,h-4);x.textAlign='right';x.fillText(new Date(t1).toLocaleString(),w-R,h-4);x.textAlign='left';
}
function pfRenderIntegrity(){
 const s=pf.state;if(!s)return;let h='';const rc=s.recon;
 h+=rc?'<div>Last reconciliation '+pfTime(rc.checkedAt)+' ('+pfEsc(rc.source.replace('_',' '))+'): <b class="'+(rc.ok?'pos':'neg')+'">'+(rc.ok?'consistent':'differences found')+'</b></div>'+(rc.problems||[]).map(p=>'<div class="neg">'+pfEsc(p)+'</div>').join(''):'<div>No reconciliation run yet. Use Reconcile.</div>';
 const an=s.anomalies||[];h+=an.length?'<div style="margin-top:6px">Ledger anomalies (ignored, never counted in P&amp;L):</div>'+an.map(a=>'<div>'+pfTime(a.at)+' · '+pfEsc(a.kind)+' · '+pfEsc(a.detail)+'</div>').join(''):'<div style="margin-top:6px">No ledger anomalies.</div>';
 h+='<div style="margin-top:6px">Storage: '+pfEsc((s.storage||'').toUpperCase())+'. '+pfEsc(s.sync&&s.sync.consistency||'')+' Events recorded: '+s.eventCount+'.</div>';
 $('pfIntegrity').innerHTML=h;
}
/* ---- actions ---- */
function pfBody(over){return Object.assign({riskConfirmed:true,executionSource:{actorType:'manual_user',actorId:($('operatorId').value.trim()||'dashboard-operator'),sourceName:'ETI Dashboard Portfolio',triggerReason:'Position close from dashboard'}},over);}
async function pfClose(symbol){
 const s=pf.state,p=s&&s.positions.find(x=>x.symbol===symbol);if(!p)return;
 const free=p.qty-(p.reservedQty||0);if(free<=1e-12){alert('All of this position is already committed to open sell orders. Cancel them first.');return;}
 const broker=PF_BROKER[p.venue]||'eti_paper',label=broker==='eti_paper'?'INTERNAL PAPER, SIMULATED':'EXCHANGE TESTNET';
 if(!confirm('CLOSE POSITION | | SELL '+pfQty(free)+' '+symbol+' at market via '+broker.toUpperCase()+' ('+label+'). Continue?'))return;
 const body=pfBody({broker,symbol,side:'sell',type:'market',quantity:free,timeInForce:'gtc',clientOrderId:'eti'+crypto.randomUUID().replace(/-/g,'').slice(0,29)});
 const {r,d}=await pfCall('/api/orders',body);
 $('orderOutput').textContent=JSON.stringify(d,null,2);
 if(!r.ok)alert('Close failed: '+(d.message||d.error||('HTTP '+r.status)));
 pfKick();
}
async function pfCancel(id){
 if(!confirm('Cancel this order?'))return;
 const {r,d}=await pfCall('/api/portfolio/cancel',{environment:pf.env,orderId:id});
 if(!r.ok)alert('Cancel failed: '+(d.message||d.error||('HTTP '+r.status)));
 pfKick();
}
function pfOpenLevels(symbol){
 const s=pf.state,p=s&&s.positions.find(x=>x.symbol===symbol),e=$('pfLev');if(!p)return;pf.levEdit=symbol;
 const v=x=>x==null?'':x;
 e.innerHTML='<b>'+pfEsc(symbol)+' levels</b><label>Stop<input id="lvStop" type="number" step="any" value="'+v(p.levels.stop)+'"></label><label>TP1<input id="lvTp1" type="number" step="any" value="'+v(p.levels.tp[0])+'"></label><label>TP2<input id="lvTp2" type="number" step="any" value="'+v(p.levels.tp[1])+'"></label><label>TP3<input id="lvTp3" type="number" step="any" value="'+v(p.levels.tp[2])+'"></label><button id="lvSave" class="active mini">Save levels</button><button id="lvCancel" class="mini">Close</button><span id="lvMsg" class="muted"></span>';
 e.classList.add('on');
 $('lvCancel').onclick=()=>e.classList.remove('on');
 $('lvSave').onclick=async()=>{const g=id=>$(id).value===''?null:Number($(id).value);const {r,d}=await pfCall('/api/portfolio/plan',{environment:pf.env,symbol,stop:g('lvStop'),tp1:g('lvTp1'),tp2:g('lvTp2'),tp3:g('lvTp3')});$('lvMsg').textContent=r.ok?'Saved.':(d.message||d.error||'Failed');if(r.ok){pfKick();setTimeout(()=>e.classList.remove('on'),600);}};
}
/* ---- chart trade layer: markers are keyed by fill timestamp and snapped to the candle that contains it ---- */
function pfCandleIdx(t){
 const n=candles.length;if(!n||t<candles[0][0])return -1;
 const iv=n>1?candles[1][0]-candles[0][0]:60000;if(t>=candles[n-1][0]+iv)return -1;
 let lo=0,hi=n-1;while(lo<hi){const m=(lo+hi+1)>>1;if(candles[m][0]<=t)lo=m;else hi=m-1;}return lo;
}
function pfChartData(){
 const s=pf.state,sym=$('symbol').value;if(!s||s.disabled||!s.fills)return null;
 const orders={};(s.orders||[]).forEach(o=>{orders[o.orderId]=o;});
 const last={};(s.closed||[]).forEach(t=>{if(t.fills.length){const f=t.fills[t.fills.length-1];last[f.orderId+'|'+f.fillId]=t;}});
 return {sym,orders,last,fills:s.fills.filter(f=>f.symbol===sym&&f.applied!==false),positions:(s.positions||[]).filter(p=>p.symbol===sym),open:(s.openOrders||[]).filter(o=>o.symbol===sym)};
}
function pfRange(ref){
 const d=layers.trades?pfChartData():null,out=[];if(!d||!ref)return out;const near=v=>v!=null&&Math.abs(v/ref-1)<0.12;
 d.positions.forEach(p=>{[p.avgEntry,p.levels.stop].concat(p.levels.tp).forEach(v=>{if(near(v))out.push(v);});});
 d.open.forEach(o=>{const v=o.type==='stop'?o.stopPrice:o.limitPrice;if(near(v))out.push(v);});
 d.fills.forEach(f=>{if(near(f.price))out.push(f.price);});return out;
}
function pfTri(x,cx,y,up,s,fill,col){x.beginPath();if(up){x.moveTo(cx,y);x.lineTo(cx-s,y+s*1.7);x.lineTo(cx+s,y+s*1.7);}else{x.moveTo(cx,y);x.lineTo(cx-s,y-s*1.7);x.lineTo(cx+s,y-s*1.7);}x.closePath();if(fill){x.fillStyle=col;x.fill();}x.strokeStyle=col;x.lineWidth=1.6;x.stroke();}
function pfDrawTrades(x,g,py,labels){
 pf.hits=[];const d=layers.trades?pfChartData():null;if(!d||!candles.length)return;
 const slots={};
 d.fills.forEach(f=>{
  const i=pfCandleIdx(f.at);if(i<0)return;const v=candles[i],buy=f.side==='buy',cx=g.x(i),o=d.orders[f.orderId]||{},closing=!buy&&d.last[f.orderId+'|'+f.fillId],partial=o.qty&&f.qty<o.qty-1e-9;
  const key=i+buy,k=slots[key]=(slots[key]||0)+1,off=6+(k-1)*13,y=buy?py(v[3])+off:py(v[2])-off;
  const why=o.reason==='stop_loss'?'SL':/^take_profit_/.test(o.reason||'')?'TP'+(o.reason||'').slice(-1):null;
  const col=buy?C.up:C.down;
  if(closing){x.fillStyle=col;x.fillRect(cx-5,y-5,10,10);x.strokeStyle='#fff';x.lineWidth=1;x.strokeRect(cx-5,y-5,10,10);}
  else pfTri(x,cx,y,buy,6,!partial,col);
  x.fillStyle=col;x.font='9px Inter,system-ui,sans-serif';x.textAlign='center';x.fillText((closing?'EXIT ':'')+(why?why+' ':'')+pfQty(f.qty),cx,buy?y+16:y-14);x.textAlign='left';x.font=FONT;
  pf.hits.push({x:cx,y:buy?y+5:y-5,kind:'fill',f,o,t:closing||null,why,partial});
 });
 d.positions.forEach(p=>{
  const m=pfMark(p),u=m.px==null?null:(m.px-p.avgEntry)*p.qty,line=(v,col,dash,txt,h)=>{if(v==null)return;const y=py(v);x.setLineDash(dash);x.strokeStyle=col;x.lineWidth=1.2;x.beginPath();x.moveTo(0,y);x.lineTo(g.plotW,y);x.stroke();x.setLineDash([]);labels.push({y,t:txt,c:col});pf.hits.push({x:g.plotW-20,y,kind:'line',p,txt,h});};
  line(p.avgEntry,'#e6edf7',[6,3],'POS '+pfQty(p.qty)+' @ '+fp(p.avgEntry)+(u==null?'':' '+(u>=0?'+':'')+pfNum(u,2)),'Open position: '+pfQty(p.qty)+' at avg '+fp(p.avgEntry));
  line(p.levels.stop,C.down,[3,3],'SL '+fp(p.levels.stop),'Stop loss');
  p.levels.tp.forEach((v,i)=>line(v,C.up,p.levels.hit[i]?[1,4]:[3,3],'TP'+(i+1)+(p.levels.hit[i]?'✓ ':' ')+fp(v),'Take profit '+(i+1)+(p.levels.hit[i]?' (reached)':'')));
 });
 d.open.forEach(o=>{const v=o.type==='stop'?o.stopPrice:o.limitPrice;if(v==null)return;const y=py(v),col=o.side==='buy'?C.up:C.down;x.setLineDash([1,4]);x.strokeStyle=C.amber;x.lineWidth=1.4;x.beginPath();x.moveTo(0,y);x.lineTo(g.plotW,y);x.stroke();x.setLineDash([]);labels.push({y,t:(o.type==='stop'?'STOP ':'LMT ')+o.side.toUpperCase()+' '+pfQty(o.qty-o.filledQty)+' '+fp(v),c:col});pf.hits.push({x:g.plotW-20,y,kind:'order',o});});
}
function pfPopHtml(h){
 const f=h.f,o=h.o||{};
 if(h.kind==='fill'){const side=f.side.toUpperCase();return '<b class="'+f.side+'">'+side+(h.t?' · EXIT':'')+(h.why?' · '+h.why:'')+'</b> '+pfEsc(f.symbol)+'<br>Qty '+pfQty(f.qty)+(h.partial?' (partial fill of '+pfQty(o.qty)+')':'')+' @ '+pfNum(f.price,2)+'<br>Time '+pfTime(f.at)+'<br>Order '+pfEsc(o.type||'')+' · '+pfEsc(o.status?PF_STATUS[o.status]:'')+'<br>Fee '+(f.fee==null?'not reported':pfNum(f.fee,4))+(f.slippageBps!=null?' · slippage '+pfNum(f.slippageBps,1)+' bps':'')+'<br>Source '+(f.origin==='internal_sim'?'Internal Paper (simulated)':'Exchange Testnet (broker-reported)')+(h.t?'<br>Trade net '+pfMoney(h.t.net,true)+' ('+h.t.result+')':'');}
 if(h.kind==='order')return '<b>'+pfEsc(o.type.toUpperCase())+' '+o.side.toUpperCase()+'</b> '+pfEsc(o.symbol)+'<br>Qty '+pfQty(o.qty)+' · filled '+pfQty(o.filledQty)+'<br>Status '+PF_STATUS[o.status]+'<br>Created '+pfTime(o.createdAt);
 const p=h.p,m=pfMark(p),u=m.px==null?null:(m.px-p.avgEntry)*p.qty;
 return '<b>'+pfEsc(h.h)+'</b> '+pfEsc(p.symbol)+'<br>Open qty '+pfQty(p.qty)+' · avg entry '+pfNum(p.avgEntry,2)+'<br>Mark '+pfNum(m.px,2)+' · unrealized '+pfMoney(u,true)+'<br>Realized so far '+pfMoney(p.realizedNet,true)+'<br>Status Open · held '+pfDur(Date.now()-p.openedAt);
}
function pfShowPop(h,e){
 let p=$('pfPop');if(!p){p=document.createElement('div');p.id='pfPop';p.className='pfpop';$('stack').appendChild(p);}
 p.innerHTML='<button class="mini" id="pfPopX" aria-label="Close">×</button>'+pfPopHtml(h);p.style.display='block';
 const s=$('stack').getBoundingClientRect();p.style.left=Math.max(4,Math.min(s.width-p.offsetWidth-4,e.clientX-s.left+12))+'px';p.style.top=Math.max(4,Math.min(s.height-p.offsetHeight-4,e.clientY-s.top+12))+'px';
 $('pfPopX').onclick=ev=>{ev.stopPropagation();p.style.display='none';};
}
function pfWireChart(){
 $('stack').addEventListener('click',e=>{
  const p=$('pfPop');if(e.target.closest&&e.target.closest('#pfPop'))return;
  const r=$('chart').getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  if(my<0||my>r.height||mx<0||mx>r.width-PAD_R+PAD_R){if(p)p.style.display='none';return;}
  let best=null,bd=16;
  pf.hits.forEach(h=>{const d=h.kind==='fill'?Math.hypot(h.x-mx,h.y-my):(mx<=r.width-PAD_R?Math.abs(h.y-my)*2:999);if(d<bd){bd=d;best=h;}});
  if(best)pfShowPop(best,e);else if(p)p.style.display='none';
 });
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('pfPop'))$('pfPop').style.display='none';});
}
/* ---- order-form extras: protective levels and stop-loss orders ---- */
function pfPlanFromForm(){
 const g=id=>$(id).value===''?null:Number($(id).value),pl={stop:g('planStop'),tp1:g('planTp1'),tp2:g('planTp2'),tp3:g('planTp3')};
 return pl.stop==null&&pl.tp1==null&&pl.tp2==null&&pl.tp3==null?null:pl;
}
function pfSyncOrderForm(){
 const t=$('orderType').value;$('stopPriceWrap').style.display=t==='stop'?'flex':'none';
 $('limitPriceWrap').style.display=t==='limit'?'flex':'none';
 $('planBox').classList.add('on');
}
function pfUseSignal(){
 const n=$('planNote');
 if(!(typeof sigValid==='function'&&sigValid())){n.textContent='No ETI signal is loaded for '+$('orderSymbol').value+' yet.';return;}
 const L=sig.chart.levels;
 if(L.direction!==1){n.textContent='The latest ETI setup is SELL/short. ETI spot trading is long-only, so there are no long levels to copy.';return;}
 $('planStop').value=L.stopLoss;$('planTp1').value=L.targets[0]!=null?L.targets[0]:'';$('planTp2').value=L.targets[1]!=null?L.targets[1]:'';$('planTp3').value=L.targets[2]!=null?L.targets[2]:'';
 n.textContent='Copied the ETI engine levels (entry '+fp(L.entry)+'). They apply to BUY orders only.';
}
function pfInit(){
 pf.env=pfEnvOfBroker();$('pfEnv').value=pf.env;
 $('pfEnv').onchange=()=>{pf.env=$('pfEnv').value;pf.state=null;pf.closedRows=null;pfRender();pfLoad();};
 $('orderBroker').addEventListener('change',()=>{const e=pfEnvOfBroker();if(e!==pf.env){pf.env=e;pf.state=null;pf.closedRows=null;pfRender();pfLoad();}});
 $('pfAllOrders').onchange=()=>{pf.allOrders=$('pfAllOrders').checked;pfRenderOrders();};
 $('pfSync').onclick=async()=>{$('pfSync').disabled=true;await pfCall('/api/portfolio/sync',{environment:pf.env});$('pfSync').disabled=false;pfKick();};
 $('pfReconcile').onclick=async()=>{$('pfReconcile').disabled=true;const {r,d}=await pfCall('/api/portfolio/reconcile',{environment:pf.env});$('pfReconcile').disabled=false;if(!r.ok)alert(d.message||d.error||'Reconcile failed');pfKick();};
 ['pfFSymbol','pfFFrom','pfFTo','pfFStrategy','pfFResult','pfFSource'].forEach(id=>{$(id).addEventListener('input',()=>{clearTimeout(pfFTimer);pfFTimer=setTimeout(pfApplyFilters,300);});});
 $('pfFClear').onclick=()=>{['pfFSymbol','pfFFrom','pfFTo','pfFStrategy','pfFResult','pfFSource'].forEach(id=>{$(id).value='';});pfApplyFilters();};
 $('portfolioPanel').addEventListener('click',e=>{const t=e.target;if(!t.dataset)return;if(t.dataset.cancel)pfCancel(t.dataset.cancel);else if(t.dataset.close)pfClose(t.dataset.close);else if(t.dataset.levels)pfOpenLevels(t.dataset.levels);});
 $('orderType').addEventListener('change',pfSyncOrderForm);pfSyncOrderForm();
 $('planFromSignal').onclick=pfUseSignal;$('planClear').onclick=()=>{['planStop','planTp1','planTp2','planTp3'].forEach(id=>{$(id).value='';});};
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)pfKick();});
 window.addEventListener('online',pfKick);window.addEventListener('offline',()=>pfSetStatus('off','Offline'));
 setInterval(()=>{const c=candles.length?candles[candles.length-1][4]:null;if(c!==pf.lastPx){pf.lastPx=c;if(pf.state&&!pf.state.disabled&&pf.state.positions){pfRenderKpis();pfRenderPositions();}}},1000);
 pfWireChart();setTimeout(pfLoad,800);
}
`;
