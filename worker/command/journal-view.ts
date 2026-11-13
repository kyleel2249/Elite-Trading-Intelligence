/**
 * Phase 3 views: Trade Journal and Analytics, backed by the append-only, hash-chained journal at /api/journal/*.
 * Everything shown comes from that API. Notes written here are persisted server-side as new journal entries (nothing is edited or deleted).
 * Composed onto the page by exact-marker replacement; composition throws if a marker is missing. Script rules as in page.ts:
 * no backticks, dollar-brace sequences or backslashes in the cooked script text.
 */
const NAV_JOURNAL_OLD = `<a class="item soon" aria-disabled="true" title="Not built yet">Trade Journal <em>soon</em></a>`;
const NAV_ANALYTICS_OLD = `<a class="item soon" aria-disabled="true" title="Not built yet">Analytics <em>soon</em></a>`;

const BODY = `
<section class="view" id="v-journal">
 <div class="card" style="margin-bottom:14px"><div class="row"><b>Journal</b>
  <select id="jStatus" aria-label="Status"><option value="">All trades</option><option value="closed">Closed</option><option value="open">Open</option><option value="analysed">Analysed only</option><option value="refused">Refused</option></select>
  <input id="jSymbol" placeholder="Symbol" style="width:120px"><button id="jApply">Apply</button><button id="jSync">Sync from ledger</button><button id="jVerify">Verify chain</button><button id="jCsv">Export CSV</button></div>
  <div class="foot">Append-only and hash-chained: entries are never edited or deleted. A correction is a new note that references the original entry.</div></div>
 <div class="grid">
  <section class="card c12"><h3>Journal summary <span id="jChain" class="sev MEDIUM">--</span></h3><div class="body" id="b-jsum"></div><div class="foot" id="f-jsum"></div></section>
  <section class="card c12"><h3>Insights <small>generated from the recorded trades, never from opinion</small></h3><div class="body" id="b-jins"></div></section>
  <section class="card c12"><h3>Trades</h3><div class="body scroll" id="b-jtrades"></div><div class="foot" id="f-jtrades"></div></section>
 </div>
</section>
<section class="view" id="v-analytics">
 <div class="grid">
  <section class="card c12"><h3>Performance analytics <small>from the journal</small></h3><div class="body" id="b-anal"></div><div class="foot" id="f-anal"></div></section>
  <section class="card c6"><h3>By strategy</h3><div class="body scroll" id="b-abs"></div></section>
  <section class="card c6"><h3>By symbol</h3><div class="body scroll" id="b-absym"></div></section>
  <section class="card c4"><h3>By environment</h3><div class="body scroll" id="b-abenv"></div></section>
  <section class="card c4"><h3>By weekday (UTC)</h3><div class="body scroll" id="b-abwd"></div></section>
  <section class="card c4"><h3>By hour (UTC)</h3><div class="body scroll" id="b-abhr"></div></section>
  <section class="card c12"><h3>Prediction quality <small>did analysed signals hit TP1 before their stop?</small></h3><div class="body" id="b-apred"></div></section>
 </div>
</section>
`;

const JS = `
/* ---- automatic cookie session (HttpOnly: this page never sees or stores the credential) ---- */
var SESSION='__session__';
var AUTH={mode:'pending'};
function bearer(){return S.token&&S.token!==SESSION?{Authorization:'Bearer '+S.token}:{};}
function authHdr(){var b=bearer();return {headers:b,credentials:'same-origin'};}
async function startAuth(){
 try{
  var r=await fetch('/api/auth/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'paper'})});
  var d=await r.json().catch(function(){return {};});
  if(r.ok){AUTH.mode='auto';if(!S.token)S.token=SESSION;var wait=Math.max(5000,(d.refreshAfter||0)-Date.now());setTimeout(startAuth,Math.min(wait,3600000));}
  else{AUTH.mode='manual';}
 }catch(e){AUTH.mode='manual';}
 try{if(LOADERS[S.view])LOADERS[S.view]();}catch(e){}
}
VIEWS.push('journal','analytics');
var JR={status:'',symbol:''};
function jrReady(){return !!S.token||AUTH.mode==='auto';}
function jrNeed(id){$(id).innerHTML='<div class="empty">'+(AUTH.mode==='manual'?'Automatic sessions are off. Paste the execution token on the Trading Dashboard.':'Waiting for a session. If this persists, check the Session indicator at the top.')+' No figure is shown without a real journal response.</div>';}
function jrErr(e){return e.message==='unauthorized'?new Error('not authorised: no valid session or token'):e;}
function jrApi(path,opt){return api(path,opt||authHdr());}
function jrPost(path,body){return api(path,{method:'POST',headers:Object.assign({'content-type':'application/json'},bearer()),body:JSON.stringify(body||{})});}
function pct1(x){return x==null?'\u2014':(x*100).toFixed(1)+'%';}
function mny(v){return v==null?'\u2014':fmt(v,2);}
function dur(ms){if(ms==null)return '\u2014';var m=Math.round(ms/60000);return m<90?m+' min':m<2880?(m/60).toFixed(1)+' h':(m/1440).toFixed(1)+' d';}
async function loadJsum(){
 if(!jrReady()){jrNeed('b-jsum');$('b-jins').innerHTML='';return {source:'not loaded'};}
 var r;try{r=await jrApi('/api/journal/summary');}catch(e){throw jrErr(e);}
 var d=r.data,st=d.stats||{},p=st.performance||{},o=st.orders||{},v=d.verification||{},dq=st.dataQuality||{};
 $('jChain').textContent=v.ok?'CHAIN VERIFIED':'CHAIN PROBLEM';$('jChain').className='sev '+(v.ok?'LOW':'CRITICAL');
 var iv=p.winRateInterval;
 var h='<div class="kpis">'+kp('Entries',esc(st.entries))+kp('Trades',esc(st.trades))+kp('Closed',esc(p.closed))+kp('Win rate',pct1(p.winRate),'',iv?'95% range '+pct1(iv[0])+' to '+pct1(iv[1]):'')+kp('Net P/L',mny(p.netPnl),pnlc(p.netPnl))+kp('Profit factor',p.profitFactor==null?'\u2014':fmt(p.profitFactor,2))+kp('Expectancy / trade',mny(p.expectancy),pnlc(p.expectancy))+kp('Average R',p.avgR==null?'\u2014':fmt(p.avgR,2),'','from '+esc(p.rSample)+' trades with a stop')+kp('Max drawdown',mny(p.maxDrawdown),'neg')+kp('Streaks (W / L)',esc(p.maxWinStreak)+' / '+esc(p.maxLossStreak))+kp('Avg holding',dur(p.avgHoldingMs))+kp('Fees',mny(p.fees),'',p.feesUnknownTrades?esc(p.feesUnknownTrades)+' trade(s) with unknown fees':'')+'</div>';
 h+='<div class="kpis" style="margin-top:10px">'+kp('Orders',esc(o.total))+kp('Executed',esc(o.executed))+kp('Open',esc(o.open))+kp('Refused by safeguards',esc(o.refused))+kp('Broker rejected',esc(o.brokerRejected))+kp('Outcome unknown',esc(o.outcomeUnknown),o.outcomeUnknown?'neg':'')+kp('Cancelled / expired',esc(o.cancelled)+' / '+esc(o.expired))+kp('Analysed only',esc(o.analysedOnly))+'</div>';
 if(dq.sampleWarning)h+='<div class="err" style="margin-top:8px">'+esc(dq.sampleWarning)+'</div>';
 h+='<div class="foot">Chain: '+(v.ok?esc(v.entries)+' entries verified':'verification failed: '+esc(JSON.stringify(v.problems||v)))+(v.head?' \u00b7 head '+esc(String(v.head).slice(0,12))+'\u2026':'')+' \u00b7 storage '+esc(v.storage||'unknown')+(v.note?' \u00b7 '+esc(v.note):'')+'. Data quality: '+esc(dq.anomalies)+' anomalies, '+esc(dq.manualTrades)+' manual trades.</div>';
 $('b-jsum').innerHTML=h;
 var ins=d.insights||[];
 $('b-jins').innerHTML=ins.length?'<table>'+ins.map(function(i){return '<tr><td><span class="sev '+(i.severity==='action'?'HIGH':i.severity==='warning'?'MEDIUM':'LOW')+'">'+esc(i.severity)+'</span></td><td><b>'+esc(i.title)+'</b><div class="mut">'+esc(i.detail)+'</div></td></tr>';}).join('')+'</table>':'<div class="empty">No insights yet. They appear once there are enough closed trades to say something honest.</div>';
 return {ms:r.ms,source:'journal summary'};
}
async function loadJtrades(){
 if(!jrReady()){jrNeed('b-jtrades');return {source:'not loaded'};}
 var q='limit=200'+(JR.status?'&status='+encodeURIComponent(JR.status):'')+(JR.symbol?'&symbol='+encodeURIComponent(JR.symbol):'');
 var r;try{r=await jrApi('/api/journal/trades?'+q);}catch(e){throw jrErr(e);}
 var t=r.data.trades||[];D.journalTrades=t;
 $('b-jtrades').innerHTML=t.length?'<table><tr><th>First seen (UTC)</th><th>Symbol</th><th>Env / origin</th><th>Strategy</th><th>Side</th><th>Status</th><th>Entry</th><th>Exit</th><th>Net P/L</th><th>R</th><th>Result</th><th>Held</th><th></th></tr>'+t.map(function(x){return '<tr><td>'+esc(utc(new Date(x.firstAt)))+'</td><td><b>'+esc(x.symbol||'\u2014')+'</b></td><td class="mut">'+esc(x.environment||'\u2014')+' / '+esc(x.origin||'\u2014')+'</td><td class="mut">'+esc(x.strategy||'\u2014')+'</td><td class="'+(x.side==='buy'||x.side==='BUY'?'pos':x.side?'neg':'mut')+'">'+esc(x.side||'\u2014')+'</td><td>'+esc(x.status)+'</td><td>'+(x.entryPrice==null?'\u2014':fmt(x.entryPrice,4))+'</td><td>'+(x.exitPrice==null?'\u2014':fmt(x.exitPrice,4))+'</td><td class="'+(x.feesKnown===false?'mut':pnlc(x.net))+'">'+(x.net==null?'\u2014':(x.feesKnown===false?mny(x.net)+' (fees unknown)':mny(x.net)))+'</td><td>'+(x.r==null?'\u2014':fmt(x.r,2))+'</td><td>'+esc(x.result||'\u2014')+'</td><td>'+dur(x.holdingMs)+'</td><td><button data-jt="'+esc(x.tradeId)+'">Open</button></td></tr>';}).join('')+'</table>':'<div class="empty">No trades match. The journal records executed, refused and analysed orders automatically as they happen.</div>';
 $('b-jtrades').querySelectorAll('button[data-jt]').forEach(function(b){b.onclick=function(){openTrade(b.getAttribute('data-jt'));};});
 return {ms:r.ms,source:t.length+' trades'};
}
async function openTrade(id){
 openModal('Trade '+id,'<div class="mut">Loading\u2026</div>');
 try{var r=await jrApi('/api/journal/trades/'+encodeURIComponent(id));var d=r.data,t=d.trade||{},es=d.entries||[];
  var plan=t.plan||{};
  var h='<div class="kpis">'+kp('Symbol',esc(t.symbol||'\u2014'))+kp('Status',esc(t.status))+kp('Strategy',esc(t.strategy||'\u2014'))+kp('Decision',esc(t.decision||'\u2014'),'',t.confidence==null?'':'confidence '+esc(t.confidence))+kp('Net P/L',mny(t.net),pnlc(t.net))+kp('R',t.r==null?'\u2014':fmt(t.r,2))+'</div>';
  if(plan.stop!=null||(plan.targets||[]).length)h+='<div class="foot">Plan: stop '+esc(plan.stop==null?'none':plan.stop)+' \u00b7 targets '+esc((plan.targets||[]).join(', ')||'none')+(plan.entryZone?' \u00b7 entry zone '+esc(plan.entryZone.join(' to ')):'')+'</div>';
  if((t.reasons||[]).length)h+='<b>Reasons recorded</b><ul>'+t.reasons.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>';
  h+='<b>Timeline</b><div class="scroll" style="max-height:260px"><table><tr><th>Time (UTC)</th><th>Kind</th><th>Detail</th><th>Entry id</th></tr>'+es.map(function(e){var dd='';try{dd=JSON.stringify(e.data);}catch(x){dd='';}return '<tr><td>'+esc(utc(new Date(e.at)))+'</td><td>'+esc(e.kind)+'</td><td class="mut">'+esc(dd.length>220?dd.slice(0,220)+'\u2026':dd)+'</td><td class="mut">'+esc(String(e.id||'').slice(0,10))+'</td></tr>';}).join('')+'</table></div>';
  h+='<div style="margin-top:10px"><b>Add a note</b> <span class="mut">(saved to the journal as a new entry)</span><div class="row" style="margin-top:6px"><textarea id="jnText" rows="3" style="flex:1;min-width:240px;background:rgba(5,9,20,.8);color:#e8f1ff;border:1px solid var(--line);border-radius:8px;padding:8px" placeholder="What did you see, what did you learn?"></textarea></div><div class="row" style="margin-top:6px"><input id="jnTags" placeholder="tags, comma separated" style="min-width:200px"><select id="jnCorr" aria-label="Corrects entry"><option value="">Corrects nothing</option>'+es.map(function(e){return '<option value="'+esc(e.id)+'">Corrects '+esc(e.kind)+' '+esc(String(e.id||'').slice(0,8))+'</option>';}).join('')+'</select><button id="jnSave">Save note</button></div><div id="jnMsg" class="foot"></div></div>';
  $('mb').innerHTML=h;
  $('jnSave').onclick=async function(){var text=$('jnText').value.trim();if(!text){$('jnMsg').textContent='Write something first.';return;}$('jnMsg').textContent='Saving\u2026';
   try{var body={tradeId:id,text:text,tags:$('jnTags').value.split(',').map(function(s){return s.trim();}).filter(Boolean)};if($('jnCorr').value)body.corrects=$('jnCorr').value;await jrPost('/api/journal/note',body);await openTrade(id);var m=$('jnMsg');if(m)m.textContent='Saved to the journal '+utc();run('jtrades',loadJtrades);}catch(e){$('jnMsg').textContent='Could not save: '+e.message;}};
 }catch(e){$('mb').innerHTML='<div class="err">Could not load the trade: '+esc(jrErr(e).message)+'</div>';}
}
async function jrVerify(){
 openModal('Verify the journal chain','<div class="mut">Verifying every entry hash\u2026</div>');
 try{var r=await jrApi('/api/journal/verify');var v=r.data.verification||r.data;$('mb').innerHTML='<div class="row"><span class="pill"><i class="dot '+(v.ok?'ok':'bad')+'"></i>'+(v.ok?'Chain verified':'CHAIN PROBLEM')+'</span><span class="mut">'+esc(v.entries)+' entries \u00b7 '+r.ms+' ms</span></div>'+jsonBox(v);}
 catch(e){$('mb').innerHTML='<div class="err">Verification unavailable: '+esc(jrErr(e).message)+'</div>';}
}
async function jrSync(){
 openModal('Sync from the ledger','<div class="mut">Backfilling journal entries from the ledger\u2026</div>');
 try{var r=await jrPost('/api/journal/sync',{});$('mb').innerHTML='<div class="mut">Idempotent: entries already in the journal are not duplicated.</div>'+jsonBox(r.data);loadJournalAll();}
 catch(e){$('mb').innerHTML='<div class="err">Sync failed: '+esc(jrErr(e).message)+'</div>';}
}
async function jrCsv(){
 try{var res=await fetch('/api/journal/export?format=csv',{headers:bearer(),credentials:'same-origin',cache:'no-store'});if(!res.ok)throw new Error('HTTP '+res.status);var blob=await res.blob();var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='eti-journal.csv';document.body.appendChild(a);a.click();setTimeout(function(){URL.revokeObjectURL(a.href);a.remove();},500);}
 catch(e){openModal('Export failed','<div class="err">'+esc(e.message)+'</div>');}
}
function grpTable(rows,label){
 if(!rows||!rows.length)return '<div class="empty">No closed trades to group yet.</div>';
 return '<table><tr><th>'+esc(label)+'</th><th>Trades</th><th>Win rate</th><th>Net</th><th>Expectancy</th><th>Profit factor</th></tr>'+rows.map(function(g){return '<tr><td><b>'+esc(g.key)+'</b></td><td>'+esc(g.trades)+(g.trades<10?' <span class="mut" title="fewer than 10 trades">*</span>':'')+'</td><td>'+pct1(g.winRate)+'</td><td class="'+pnlc(g.net)+'">'+mny(g.net)+'</td><td class="'+pnlc(g.expectancy)+'">'+mny(g.expectancy)+'</td><td>'+(g.profitFactor==null?'\u2014':fmt(g.profitFactor,2))+'</td></tr>';}).join('')+'</table><div class="foot">* fewer than 10 trades: not a meaningful sample.</div>';
}
async function loadAnalytics(){
 if(!jrReady()){jrNeed('b-anal');['b-abs','b-absym','b-abenv','b-abwd','b-abhr','b-apred'].forEach(function(i){$(i).innerHTML='';});return {source:'not loaded'};}
 var r;try{r=await jrApi('/api/journal/stats');}catch(e){throw jrErr(e);}
 var s=r.data,p=s.performance||{},pr=s.predictions||{},dq=s.dataQuality||{};
 $('b-anal').innerHTML='<div class="kpis">'+kp('Closed trades',esc(p.closed))+kp('Win rate',pct1(p.winRate))+kp('Net P/L',mny(p.netPnl),pnlc(p.netPnl))+kp('Profit factor',p.profitFactor==null?'\u2014':fmt(p.profitFactor,2))+kp('Expectancy',mny(p.expectancy),pnlc(p.expectancy))+kp('Payoff ratio',p.payoffRatio==null?'\u2014':fmt(p.payoffRatio,2))+kp('Largest win / loss',mny(p.largestWin)+' / '+mny(p.largestLoss))+kp('Max drawdown',mny(p.maxDrawdown),'neg')+'</div>'+(dq.sampleWarning?'<div class="err" style="margin-top:8px">'+esc(dq.sampleWarning)+'</div>':'')+(s.truncated?'<div class="foot">The journal is larger than one analysis window: figures cover the most recent entries only.</div>':'');
 $('b-abs').innerHTML=grpTable(s.byStrategy,'Strategy');$('b-absym').innerHTML=grpTable(s.bySymbol,'Symbol');$('b-abenv').innerHTML=grpTable(s.byEnvironment,'Environment');$('b-abwd').innerHTML=grpTable(s.byWeekday,'Day');$('b-abhr').innerHTML=grpTable(s.byHourUtc,'Hour');
 var cal=pr.calibration||[],ps=pr.byStrategy||[];
 $('b-apred').innerHTML='<div class="kpis">'+kp('Analyses recorded',esc(pr.total))+kp('Evaluated',esc(pr.evaluated))+kp('Hit rate',pct1(pr.hitRate),'',esc(pr.hits)+' hit / '+esc(pr.misses)+' missed')+kp('Pending',esc(pr.pending))+kp('Inconclusive',esc(pr.inconclusive))+'</div>'
  +(cal.length?'<div class="row" style="align-items:flex-start;margin-top:8px"><div style="flex:1;min-width:260px"><b>Calibration</b><table><tr><th>Score bucket</th><th>Evaluated</th><th>Hit rate</th></tr>'+cal.map(function(c){return '<tr><td>'+esc(c.bucket)+'</td><td>'+esc(c.evaluated)+'</td><td>'+pct1(c.hitRate)+'</td></tr>';}).join('')+'</table></div><div style="flex:1;min-width:260px"><b>By strategy</b><table><tr><th>Strategy</th><th>Evaluated</th><th>Hit rate</th></tr>'+ps.map(function(c){return '<tr><td>'+esc(c.key)+'</td><td>'+esc(c.evaluated)+'</td><td>'+pct1(c.hitRate)+'</td></tr>';}).join('')+'</table></div></div>':'<div class="empty" style="margin-top:8px">No analysed signals have been evaluated yet. Each recorded analysis is checked against later prices.</div>')
  +'<div class="foot">A high evidence score is a ranking, not a probability. Calibration shows whether higher scores really hit more often.</div>';
 return {ms:r.ms,source:'journal statistics'};
}
function loadJournalAll(){run('jsum',loadJsum);run('jtrades',loadJtrades);}
LOADERS.journal=loadJournalAll;
LOADERS.analytics=function(){run('anal',loadAnalytics);};
$('jApply').onclick=function(){JR.status=$('jStatus').value;JR.symbol=$('jSymbol').value.trim().toUpperCase();run('jtrades',loadJtrades);};
$('jSync').onclick=jrSync;$('jVerify').onclick=jrVerify;$('jCsv').onclick=jrCsv;
(function(){var h=(location.hash||'').slice(1);if(h==='journal'||h==='analytics')showView(h);})();
startAuth();
`;

function swap(html: string, old: string, neu: string): string {
  if (!html.includes(old)) throw new Error("journal view composition failed: marker not found: " + old.slice(0, 60));
  return html.replace(old, () => neu);
}

export function addJournal(page: string): string {
  let h = swap(page, NAV_JOURNAL_OLD, `<a class="item" data-view="journal" href="#journal">Trade Journal</a>`);
  h = swap(h, NAV_ANALYTICS_OLD, `<a class="item" data-view="analytics" href="#analytics">Analytics</a>`);
  h = swap(h, `</main>\n<div class="qa"`, BODY + `</main>\n<div class="qa"`);
  const i = h.lastIndexOf("</script>");
  if (i < 0) throw new Error("journal view composition failed: script end not found");
  return h.slice(0, i) + JS + h.slice(i);
}
