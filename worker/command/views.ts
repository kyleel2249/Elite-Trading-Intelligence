/**
 * Phase 2 views for the command centre: Portfolio (the event-sourced ledger at /api/portfolio/*) and Market Scanner
 * (the universe leaderboard at /api/omnisignal/universe). They are composed onto the base page by exact-marker replacement;
 * if a marker ever disappears from page.ts, composition throws and the tests fail instead of shipping a half-built page.
 * Same rules as page.ts: no backticks, dollar-brace sequences or backslashes inside the script text.
 */
import { commandPage } from "./page.ts";

const NAV_PORTFOLIO_OLD = `<a class="item soon" aria-disabled="true" title="Not built yet">Portfolio <em>soon</em></a>`;
const NAV_SCANNER_OLD = `<a class="item soon" aria-disabled="true" title="Not built yet">Market Scanner <em>soon</em></a>`;

const BODY = `
<section class="view" id="v-portfolio">
 <div class="card" style="margin-bottom:14px"><div class="row"><b>Ledger</b><div class="seg" id="pfEnv"></div><input id="pfToken" type="password" autocomplete="off" placeholder="ETI execution token (kept in memory only)" style="min-width:240px"><button id="pfGo">Load</button><button id="pfRecon">Reconcile</button><button id="pfCsv">Export closed trades (CSV)</button></div><div class="foot" id="pfNote">Every figure comes from the event-sourced ledger. Live trading is disabled, so there is no live ledger to show.</div></div>
 <div class="grid">
  <section class="card c12"><h3>Portfolio summary <span id="pfBadge" class="sev MEDIUM">--</span></h3><div class="body" id="b-pf"></div><div class="foot" id="f-pf"></div></section>
  <section class="card c7"><h3>Equity curve</h3><div class="body" id="b-pfcurve"></div></section>
  <section class="card c5"><h3>Alerts &amp; anomalies</h3><div class="body scroll" id="b-pfanom"></div></section>
  <section class="card c7"><h3>Open positions</h3><div class="body scroll" id="b-pfpos"></div></section>
  <section class="card c5"><h3>Open orders</h3><div class="body scroll" id="b-pford"></div></section>
  <section class="card c12"><h3>Closed trades <small>ledger history</small></h3><div class="body scroll" id="b-pfhist"></div><div class="foot" id="f-pfhist"></div></section>
 </div>
</section>
<section class="view" id="v-scanner">
 <div class="grid">
  <section class="card c12"><h3>Market Scanner <small>universe leaderboard, ranked by evidence quality</small></h3>
   <div class="row"><input id="scanTok" type="password" autocomplete="off" placeholder="ETI execution token (needed only to refresh a batch)" style="min-width:260px"><button id="scanRefresh">Refresh one batch</button><span class="mut">A refresh spends market-data requests; the scheduled job normally does this.</span></div>
   <div class="body" id="b-scan"></div><div class="foot" id="f-scan"></div></section>
 </div>
</section>
`;

const JS = `
VIEWS.push('portfolio','scanner');
var PF={env:'internal_paper'};
function ageStr(ms){if(ms==null||!isFinite(ms))return '\u2014';var m=Math.round(ms/60000);return m<90?m+' min':(m/60).toFixed(1)+' h';}
function money(v,d){return v==null?'\u2014':fmt(v,d==null?2:d);}
function pnlc(v){return v==null?'mut':v>=0?'pos':'neg';}
function pctv(x){return x==null?'\u2014':(x*100).toFixed(1)+'%';}
function kp(label,val,cls,sub){return '<div class="kpi"><small>'+esc(label)+'</small><b class="'+(cls||'')+'">'+val+'</b>'+(sub?'<small>'+sub+'</small>':'')+'</div>';}
function pfEnvBtns(){var o=[['internal_paper','Internal paper (simulated)'],['exchange_testnet','Exchange testnet']];$('pfEnv').innerHTML=o.map(function(e){return '<button data-pe="'+e[0]+'" class="'+(PF.env===e[0]?'on':'')+'">'+e[1]+'</button>';}).join('');$('pfEnv').querySelectorAll('button').forEach(function(b){b.onclick=function(){PF.env=b.getAttribute('data-pe');pfEnvBtns();LOADERS.portfolio();};});}
function pfq(){return 'environment='+encodeURIComponent(PF.env);}
function pfErr(e){var m=e.message;if(m==='unauthorized')return new Error('token rejected: enter a valid ETI execution token');if(m==='environment_scope_mismatch')return new Error('this ledger needs its own session; use the execution token');return e;}
function pfEmpty(msg){['b-pf','b-pfcurve','b-pfanom','b-pfpos','b-pford'].forEach(function(id){$(id).innerHTML='<div class="empty">'+esc(msg)+'</div>';});}
function drawCurve(pts){
 var cv=$('pfc');if(!cv)return;var dpr=window.devicePixelRatio||1,r=cv.getBoundingClientRect();cv.width=r.width*dpr;cv.height=r.height*dpr;var x=cv.getContext('2d');x.scale(dpr,dpr);var w=r.width,h=r.height;x.clearRect(0,0,w,h);
 var lo=Infinity,hi=-Infinity,t0=pts[0].t,t1=pts[pts.length-1].t;pts.forEach(function(p){lo=Math.min(lo,p.equity);hi=Math.max(hi,p.equity);});var pad=(hi-lo)*0.1||1;lo-=pad;hi+=pad;
 var px=function(t){return t1===t0?0:(t-t0)/(t1-t0)*(w-8)+4;},py=function(v){return 10+(hi-v)/(hi-lo)*(h-24);};
 x.strokeStyle='rgba(99,102,241,.2)';for(var i=0;i<4;i++){var y=10+i*(h-24)/3;x.beginPath();x.moveTo(0,y);x.lineTo(w,y);x.stroke();}
 var up=pts[pts.length-1].equity>=pts[0].equity;x.strokeStyle=up?'#10d9a0':'#ff4d6d';x.lineWidth=2;x.beginPath();pts.forEach(function(p,i){if(i)x.lineTo(px(p.t),py(p.equity));else x.moveTo(px(p.t),py(p.equity));});x.stroke();
 x.fillStyle='#8fa6c8';x.font='11px sans-serif';x.fillText(fmt(hi,2),4,10);x.fillText(fmt(lo,2),4,h-4);
}
async function loadPf(){
 if(!S.token){pfEmpty('Enter the ETI execution token above to load the ledger. No figure is shown without a real ledger response.');return {source:'not loaded'};}
 var r;try{r=await api('/api/portfolio/state?'+pfq(),authHdr());}catch(e){throw pfErr(e);}
 var d=r.data;
 if(d.disabled||d.unavailable){pfEmpty(d.message||'unavailable');return {ms:r.ms,source:d.label};}
 var b=d.balances||{},p=d.pnl||{},s=d.stats||{};
 $('pfBadge').textContent=d.simulated?'SIMULATED':'EXCHANGE TESTNET';$('pfNote').textContent='Source: '+(d.source||'ledger')+'. '+((d.sync&&d.sync.consistency)||'');
 var h='<div class="kpis">'+kp('Equity ('+esc(b.currency||'')+')',money(b.equity))+kp('Cash',money(b.cash))+kp('Available',money(b.available))+kp('Position value',money(b.positionValue))+kp('Exposure',b.exposurePct==null?'\u2014':b.exposurePct.toFixed(1)+'%')
  +kp('Daily P/L',money(p.daily),pnlc(p.daily))+kp('Total P/L',money(p.total),pnlc(p.total),p.totalPct==null?'':esc(Number(p.totalPct).toFixed(2))+'%')+kp('Realised (net)',money(p.realizedNet),pnlc(p.realizedNet))+kp('Unrealised',money(p.unrealized),pnlc(p.unrealized))+kp('Fees',money(p.fees))+'</div>';
 h+='<div class="kpis" style="margin-top:10px">'+kp('Closed trades',esc(s.trades==null?'\u2014':s.trades),'',esc(s.wins)+' wins / '+esc(s.losses)+' losses')+kp('Win rate',pctv(s.winRate))+kp('Profit factor',s.profitFactor==null?'\u2014':fmt(s.profitFactor,2))+kp('Avg win',money(s.avgWin),'pos')+kp('Avg loss',money(s.avgLoss),'neg')+kp('Best / worst',money(s.bestTrade)+' / '+money(s.worstTrade))+'</div>';
 if((s.trades||0)<30)h+='<div class="foot">Fewer than 30 closed trades: win rate and profit factor are not statistically meaningful yet.</div>';
 if(d.marksStale&&d.marksStale.length)h+='<div class="err" style="margin-top:8px">Stale prices for: '+esc(d.marksStale.join(', '))+'. Position values and P/L for these symbols use the last known mark.</div>';
 var rc=d.recon;h+='<div class="foot">Reconciliation: '+(rc?(rc.ok?'last check passed':'last check found '+esc(rc.problems.length)+' problem(s)')+' ('+esc(utc(new Date(rc.checkedAt)))+', '+esc(rc.source)+')':'not run yet')+'. '+esc(d.eventCount)+' ledger events.</div>';
 $('b-pf').innerHTML=h;
 var pts=(d.curve||[]).filter(function(c){return isFinite(c.equity);});
 $('b-pfcurve').innerHTML=pts.length>=2?'<div class="chart" style="height:240px"><canvas id="pfc" aria-label="Equity curve"></canvas></div><div class="foot">'+pts.length+' points, '+esc(utc(new Date(pts[0].t)))+' to '+esc(utc(new Date(pts[pts.length-1].t)))+'</div>':'<div class="empty">Not enough equity history yet (needs at least two points).</div>';
 if(pts.length>=2)drawCurve(pts);
 var al=(d.alerts||[]).map(function(a){return '<tr><td><span class="sev HIGH">'+esc(a.kind)+'</span></td><td>'+esc(a.message)+'</td></tr>';}).join('');
 var an=(d.anomalies||[]).slice().reverse().map(function(a){return '<tr><td class="mut">'+esc(utc(new Date(a.at)))+'</td><td>'+esc(a.kind)+': '+esc(a.detail)+'</td></tr>';}).join('');
 $('b-pfanom').innerHTML=al||an?'<table>'+al+an+'</table>':'<div class="empty">No alerts or anomalies recorded.</div>';
 var ps=d.positions||[];
 $('b-pfpos').innerHTML=ps.length?'<table><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Unrealised</th><th>Stop / TPs</th><th>Held</th></tr>'+ps.map(function(x){var lv=x.levels||{};return '<tr><td>'+esc(x.symbol)+'</td><td>'+fmt(x.qty,6)+'</td><td>'+money(x.avgEntry,4)+'</td><td>'+(x.markPrice==null?'\u2014':money(x.markPrice,4))+(x.markStale?' <span class="sev HIGH">stale</span>':'')+'</td><td class="'+pnlc(x.unrealized)+'">'+money(x.unrealized)+(x.unrealizedPct==null?'':' ('+x.unrealizedPct.toFixed(2)+'%)')+'</td><td class="mut">'+(lv.stop==null?'no stop':money(lv.stop,4))+' / '+((lv.tp||[]).map(function(t,i){return t==null?'\u2014':money(t,4)+(lv.hit&&lv.hit[i]?' (hit)':'');}).join(', '))+'</td><td>'+ageStr(x.holdingMs)+'</td></tr>';}).join('')+'</table>':'<div class="empty">No open positions.</div>';
 var os=d.openOrders||[];
 $('b-pford').innerHTML=os.length?'<table><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Status</th></tr>'+os.map(function(o){return '<tr><td>'+esc(o.symbol)+'</td><td class="'+(o.side==='buy'?'pos':'neg')+'">'+esc(o.side)+'</td><td>'+esc(o.type)+(o.limitPrice!=null?' @ '+money(o.limitPrice,4):'')+'</td><td>'+fmt(o.qty,6)+(o.filledQty?' ('+fmt(o.filledQty,6)+' filled)':'')+'</td><td>'+esc(o.status)+'</td></tr>';}).join('')+'</table>':'<div class="empty">No open orders.</div>';
 return {ms:r.ms,source:d.label+(d.cached?' (cached)':'')};
}
async function loadPfHist(){
 if(!S.token){$('b-pfhist').innerHTML='<div class="empty">Enter the token above to load closed trades.</div>';return {source:'not loaded'};}
 var r;try{r=await api('/api/portfolio/history?'+pfq(),authHdr());}catch(e){throw pfErr(e);}
 var t=r.data.trades||[];
 $('b-pfhist').innerHTML=t.length?'<table><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Net P/L</th><th>Result</th><th>Strategy</th><th>Held</th><th>Closed (UTC)</th></tr>'+t.map(function(x){return '<tr><td>'+esc(x.symbol)+'</td><td>'+money(x.entryPrice,4)+'</td><td>'+money(x.exitPrice,4)+'</td><td>'+fmt(x.qty,6)+'</td><td class="'+(x.unknownFees?'mut':pnlc(x.net))+'">'+(x.unknownFees?'fees unknown':money(x.net))+'</td><td>'+esc(x.result)+'</td><td class="mut">'+esc(x.strategy||'\u2014')+'</td><td>'+ageStr(x.holdingMs)+'</td><td>'+esc(utc(new Date(x.exitAt)))+'</td></tr>';}).join('')+'</table>':'<div class="empty">No closed trades in this ledger yet.</div>';
 return {ms:r.ms,source:r.data.count+' of '+r.data.total+' trades'};
}
async function pfRecon(){
 if(!S.token){openModal('Reconcile','<div class="empty">Enter the execution token first.</div>');return;}
 openModal('Ledger reconciliation','<div class="mut">Running\u2026</div>');
 try{var r=await api('/api/portfolio/reconcile',{method:'POST',headers:Object.assign({'content-type':'application/json'},bearer()),credentials:'same-origin',body:JSON.stringify({environment:PF.env})});var c=r.data.reconciliation||{};$('mb').innerHTML='<div class="row"><span class="pill"><i class="dot '+(c.ok?'ok':'bad')+'"></i>'+(c.ok?'Reconciled: no problems':'PROBLEMS FOUND ('+esc((c.problems||[]).length)+')')+'</span><span class="mut">source '+esc(c.source)+'</span></div>'+((c.problems||[]).length?'<ul>'+c.problems.map(function(p){return '<li>'+esc(p)+'</li>';}).join('')+'</ul>':'')+jsonBox(c);}
 catch(e){$('mb').innerHTML='<div class="err">Reconciliation failed: '+esc(pfErr(e).message)+'</div>';}
}
async function pfCsv(){
 if(!S.token){openModal('Export','<div class="empty">Enter the execution token first.</div>');return;}
 try{var res=await fetch('/api/portfolio/history?'+pfq()+'&format=csv',{headers:bearer(),credentials:'same-origin',cache:'no-store'});if(!res.ok)throw new Error('HTTP '+res.status);var blob=await res.blob();var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='eti-closed-trades-'+PF.env+'.csv';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);}
 catch(e){openModal('Export failed','<div class="err">'+esc(e.message)+'</div>');}
}
async function loadScan(){
 var r=await api('/api/omnisignal/universe?limit=30');var d=r.data,c=d.coverage||{};
 var h='<div class="kpis">'+kp('Universe',esc(c.universeSize))+kp('Fresh',esc(c.fresh),'pos')+kp('Stale',esc(c.stale),c.stale?'neg':'')+kp('Never analysed',esc(c.neverAnalysed))+kp('Errors',esc(c.errors),c.errors?'neg':'')+kp('Oldest result',ageStr(c.oldestAgeMs))+kp('Actionable',esc(d.actionable))+'</div>';
 h+='<div class="foot">Universe built '+esc(c.builtAt||'never')+(c.strategy?' \u00b7 strategy '+esc(c.strategy):'')+'. The 1,000 to 2,000 market scan every 10 minutes target is not met: ETI currently tracks '+esc(c.universeSize)+' liquidity-filtered symbols and analyses them in rotating batches, so only the fresh count above is current.</div>';
 var rows=d.leaderboard||[];
 h+=rows.length?'<div class="scroll" style="margin-top:8px;max-height:420px"><table><tr><th>#</th><th>Symbol</th><th>Decision</th><th>Dir</th><th>Opportunity</th><th>Validation</th><th>Confidence</th><th>R:R to TP3</th><th>Agreement</th><th>Liquidity</th></tr>'+rows.map(function(x){return '<tr><td>'+esc(x.rank==null?'\u2014':x.rank)+'</td><td><b>'+esc(x.symbol)+'</b></td><td>'+esc(x.decision)+'</td><td class="'+(x.direction==='LONG'?'pos':x.direction==='SHORT'?'neg':'mut')+'">'+esc(x.direction||'\u2014')+'</td><td>'+esc(x.opportunityScore==null?'\u2014':x.opportunityScore)+'</td><td>'+esc(x.validationScore==null?'\u2014':x.validationScore)+'</td><td>'+esc(x.confidence==null?'\u2014':x.confidence)+'</td><td>'+esc(x.riskRewardToTP3==null?'\u2014':x.riskRewardToTP3)+'</td><td class="mut">'+esc(x.agreement||'\u2014')+'</td><td class="mut">'+esc(x.liquidity||'\u2014')+'</td></tr>';}).join('')+'</table></div>':'<div class="empty" style="margin-top:8px">The leaderboard is empty: no symbols have been analysed yet. The scheduled scan fills it over time.</div>';
 h+='<div class="foot">'+esc(d.note||'')+' Analysis only: this scanner never submits orders.</div>';
 $('b-scan').innerHTML=h;feed('universe scanner',true,r.ms,rows.length);
 return {ms:r.ms,source:'universe leaderboard'};
}
async function scanRefresh(){
 var tok=$('scanTok').value||S.token;if(!tok){openModal('Refresh scanner batch','<div class="empty">Enter the ETI execution token first. Refreshing spends market-data requests.</div>');return;}
 openModal('Refresh scanner batch','<div class="mut">Analysing the next batch\u2026</div>');
 try{var r=await api('/api/omnisignal/universe/refresh?strategy=intraday',{method:'POST',headers:{Authorization:'Bearer '+tok}});var d=r.data;$('mb').innerHTML='<div class="row"><span class="pill">Analysed: <b>'+esc((d.analysed||[]).join(', ')||'none')+'</b></span><span class="pill">Errors: <b>'+esc((d.errors||[]).length)+'</b></span><span class="mut">'+r.ms+' ms</span></div>'+((d.errors||[]).length?'<div class="err" style="margin-top:8px">'+esc(d.errors.join(', '))+'</div>':'')+(d.universeError?'<div class="err" style="margin-top:8px">Universe refresh error: '+esc(d.universeError)+'</div>':'');run('scan',loadScan);}
 catch(e){$('mb').innerHTML='<div class="err">Refresh failed: '+esc(e.message)+'</div>';feed('universe scanner',false,0,0,e.message);}
}
/* Updated for the in-process safeguards engine (the external risk gateway was removed). These declarations replace the earlier ones of the same name. */
function sgRows(d){var sg=d.safeguards||{};return sg;}
async function loadHealth(){
 var rs=await Promise.allSettled([api('/api/system/health'),api('/api/execution/status'),api('/api/futures/status'),api('/api/readiness/status'),api('/api/market/diag?symbol='+S.symbol)]);
 var h='<table>';var ms=0;
 var r=rs[0];if(r.status==='fulfilled'){ms=r.value.ms;h+=hrow('Cloudflare Worker','ok','status '+esc(r.value.data.status)+' \u00b7 '+r.value.ms+' ms');}else h+=hrow('Cloudflare Worker','bad',r.reason.message);
 r=rs[1];if(r.status==='fulfilled'){var d=r.value.data,sg=sgRows(d);
  h+=hrow('Execution gateway','ok','mode '+d.mode+' \u00b7 live trading '+(d.live_trading_enabled?'ON':'off')+' \u00b7 live available: '+yn(d.live_trading_available));
  var sgOk=sg.valid_order_checks===true&&sg.duplicate_protection===true&&sg.balance_check===true&&sg.holdings_check===true;
  h+=hrow('In-process safeguards',sg.engine?(sgOk?'ok':'warn'):'warn',sg.engine?('engine '+sg.engine+' \u00b7 order checks '+yn(sg.valid_order_checks)+' \u00b7 balance '+yn(sg.balance_check)+' \u00b7 holdings '+yn(sg.holdings_check)+' \u00b7 duplicate protection '+yn(sg.duplicate_protection)+(sg.duplicate_window_seconds?' ('+sg.duplicate_window_seconds+' s)':'')+' \u00b7 max order qty '+(sg.max_order_quantity==null?'not reported':sg.max_order_quantity)):'not reported');
  h+=hrow('Rejection audit',sg.rejection_audit===true?'ok':'warn',sg.rejection_audit===true?'rejected orders are logged':'rejected orders are not being logged');
  h+=hrow('Execution audit log',d.audit_log_configured===true?'ok':'warn',d.audit_log_configured===true?'configured':(d.audit_log_configured===false?'not configured':'not reported'));
  h+=hrow('Kill switch',d.kill_switch?'bad':'ok',d.kill_switch?'ACTIVE: execution blocked':'inactive');
  h+=hrow('Transfers',d.transfers===false?'ok':'warn',d.transfers===false?'disabled':yn(d.transfers));
  h+=hrow('Alpaca paper',d.alpaca_paper_configured===true?'ok':'warn',d.alpaca_paper_configured===true?'credentials configured (not connection-tested here)':'not configured');
  h+=hrow('Binance testnet',d.binance_testnet_configured===true?'ok':'warn',d.binance_testnet_configured===true?'credentials configured (not connection-tested here)':'not configured');
 }else h+=hrow('Execution gateway','bad',r.reason.message);
 r=rs[2];if(r.status==='fulfilled'){var f=r.value.data;h+=hrow('Futures testnet gateway',f.enabled?'ok':'warn',(f.enabled?'enabled':'disabled')+' \u00b7 mode '+f.mode+' \u00b7 live futures '+(f.live_futures?'ON':'off'));}else h+=hrow('Futures testnet gateway','bad',r.reason.message);
 r=rs[3];if(r.status==='fulfilled'){var m=r.value.data.markets||{};['crypto','forex','equities'].forEach(function(k){var v=m[k]&&m[k].priceData;h+=hrow(k.charAt(0).toUpperCase()+k.slice(1)+' price data',String(v).indexOf('connected')===0?'ok':'warn',v);});}else h+=hrow('Readiness engine','bad',r.reason.message);
 r=rs[4];if(r.status==='fulfilled'){h+=hrow('Market providers (diagnostics)','ok','diagnostic endpoint reachable \u00b7 '+r.value.ms+' ms');D.diag=r.value.data;}else h+=hrow('Market providers (diagnostics)','bad',r.reason.message);
 h+='</table>';$('b-health').innerHTML=h;D.health=true;return {ms:ms,source:'Worker status endpoints'};
}
async function loadRisk(){
 var rs=await Promise.allSettled([api('/api/execution/status'),api('/api/futures/status')]);if(rs[0].status==='rejected')throw new Error(rs[0].reason.message);
 var d=rs[0].value.data,f=rs[1].status==='fulfilled'?rs[1].value.data:null,sg=sgRows(d);
 var rows=[['Execution mode',d.mode],['Live trading enabled',d.live_trading_enabled],['Live trading available',d.live_trading_available],['Readiness gate',d.readiness_gate],['Kill switch',d.kill_switch],['Safeguards engine',sg.engine],['Valid-order checks',sg.valid_order_checks],['Balance check',sg.balance_check],['Holdings check (spot SELL needs an existing holding)',sg.holdings_check],['Duplicate-order protection',sg.duplicate_protection],['Duplicate window (seconds)',sg.duplicate_window_seconds],['Maximum order quantity',sg.max_order_quantity],['Rejection audit',sg.rejection_audit],['Audit log configured',d.audit_log_configured],['Withdrawal permissions enabled',d.withdrawal_permissions],['Transfers enabled',d.transfers],['Alpaca paper configured',d.alpaca_paper_configured],['Binance testnet configured',d.binance_testnet_configured],['Internal paper ledger available',d.internal_paper_available],['Automatic sessions',d.auto_sessions]];
 if(f){rows.push(['Futures testnet enabled',f.enabled],['Futures credentials configured',f.credentials_configured],['Futures caps configured',f.caps_configured],['Futures hard leverage cap',f.max_leverage_hard_cap],['Live futures',f.live_futures]);}
 var show=function(v){return v===true?'yes':v===false?'no':(v==null?'not reported':String(v));};
 $('b-risk').innerHTML='<table>'+rows.map(function(x){return '<tr><td>'+esc(x[0])+'</td><td><b>'+esc(show(x[1]))+'</b></td></tr>';}).join('')+'</table><div class="foot">Read-only view of the in-process safeguards. They run on the server for every order; this page cannot change or bypass them, and no button here can enable live trading.</div>';
 return {ms:rs[0].value.ms,source:'execution status endpoints'};
}
async function autoStatus(){
 var ex=S.exec||null;var h='<table><tr><td>Environment</td><td><b>'+(ex?(ex.live_trading_enabled?'LIVE SWITCH ON':'PAPER / TESTNET ONLY'):'unknown (status unavailable)')+'</b></td></tr><tr><td>Live trading available</td><td>'+(ex?yn(ex.live_trading_available):'unknown')+'</td></tr></table>';
 if(S.token){try{var r=await api('/api/paper/status',authHdr());var sc=r.data.scheduler||{};h+='<table><tr><td>Paper auto-execute</td><td><b>'+(sc.autoExecute?'ON':'OFF')+'</b></td></tr><tr><td>Scheduled symbols</td><td>'+esc((sc.symbols||[]).join(', ')||'none')+'</td></tr><tr><td>Last scheduled run</td><td>'+esc(sc.lastRun?JSON.stringify(sc.lastRun):'none recorded')+'</td></tr></table>';}catch(e){h+='<div class="err">Paper status unavailable: '+esc(e.message)+'</div>';}}
 else h+='<div class="empty">Enter the execution token on the Trading Dashboard to see auto-execute state.</div>';
 openModal('Auto Trade status',h+'<div class="foot">Auto-trading is configured on the server and cannot be switched on from this page. No dashboard control can enable live trading.</div>');
}
LOADERS.portfolio=function(){pfEnvBtns();run('pf',loadPf);run('pfhist',loadPfHist);};
LOADERS.scanner=function(){run('scan',loadScan);};
$('pfGo').onclick=function(){S.token=$('pfToken').value||S.token;if($('token'))$('token').value=S.token;LOADERS.portfolio();};
$('pfRecon').onclick=pfRecon;$('pfCsv').onclick=pfCsv;$('scanRefresh').onclick=scanRefresh;
window.addEventListener('resize',function(){});
(function(){var h=(location.hash||'').slice(1);if(h==='portfolio'||h==='scanner')showView(h);})();
`;

function swap(html: string, old: string, neu: string): string {
  if (!html.includes(old)) throw new Error("command page composition failed: marker not found: " + old.slice(0, 60));
  return html.replace(old, () => neu);
}

export function commandPageFull(): string {
  let h = commandPage();
  h = swap(h, NAV_PORTFOLIO_OLD, `<a class="item" data-view="portfolio" href="#portfolio">Portfolio</a>`);
  h = swap(h, NAV_SCANNER_OLD, `<a class="item" data-view="scanner" href="#scanner">Market Scanner</a>`);
  h = swap(h, `</main>\n<div class="qa"`, BODY + `</main>\n<div class="qa"`);
  const i = h.lastIndexOf("</script>");
  if (i < 0) throw new Error("command page composition failed: script end not found");
  return h.slice(0, i) + JS + h.slice(i);
}
