/** /journal: ETI AUTONOMOUS TRADE JOURNAL dashboard. Everything is rendered with textContent (no HTML injection). No template-literal interpolation inside. */
export function journalPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ETI Autonomous Trade Journal</title>
<style>
:root{color-scheme:dark light;--bg:#0b1118;--fg:#e8eef6;--mut:#8fa1b5;--card:#121b26;--line:#233245;--ok:#21d69a;--bad:#ff7b7b;--warn:#ffb08c;--acc:#5aa9ff}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fb;--fg:#0f1722;--mut:#50627a;--card:#fff;--line:#d5dde8;--ok:#0a8f66;--bad:#c0392b;--warn:#b4532a;--acc:#1f6fd1}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:14px}
h1{font-size:1.4rem;margin:.2rem 0}h2{font-size:1.05rem;margin:0 0 8px}.mut{color:var(--mut)}.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.c{border:1px solid var(--line);border-radius:8px;padding:8px}.c b{display:block;font-size:1.15rem}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:5px 8px;text-align:left;white-space:nowrap;font-size:.9rem}tr.t{cursor:pointer}tr.t:hover{background:rgba(90,169,255,.08)}
input,select,button,textarea{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:6px 8px;max-width:100%}button{cursor:pointer;background:var(--acc);color:#fff;border-color:var(--acc)}button.s{background:transparent;color:var(--fg);border-color:var(--line)}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:6px 0}label{display:flex;flex-direction:column;font-size:.8rem;color:var(--mut);gap:2px}
.tl{border-left:2px solid var(--line);margin:8px 0 0 6px;padding-left:12px}.tl div{margin:6px 0}a{color:var(--acc)}
</style></head><body><main>
<h1>ETI Autonomous Trade Journal</h1>
<p class="mut">Permanent, append-only record of every analysis, order and trade ETI makes, including losses, cancellations, refusals and misses, plus trades you record yourself. Entries are hash-chained: nothing can be changed or removed without it showing. Paper and testnet only; no live orders. <a href="/">Dashboard</a></p>
<p id="msg" class="mut" role="status">Loading…</p>
<section><h2>Integrity</h2><p id="ver" class="mut">Not yet checked.</p><div class="row"><button id="bver" class="s">Verify chain now</button><button id="bsync" class="s">Sync missing records</button>
<a href="/api/journal/export?format=csv">Trades CSV</a><a href="/api/journal/export?format=csv&view=entries">Entries CSV</a><a href="/api/journal/export?format=json">Full JSON</a></div></section>
<section><h2>Performance</h2><p id="warn" class="warn"></p><div class="cards" id="cards"></div></section>
<section><h2>Order outcomes</h2><div class="cards" id="ord"></div><p id="reasons" class="mut"></p></section>
<section><h2>Prediction accuracy</h2><div class="cards" id="pred"></div></section>
<section><h2>What the journal has learned (suggestions only)</h2><ul id="ins"></ul></section>
<section><h2>Trades</h2><div class="row">
<label>Status<select id="fs"><option value="">all</option><option>closed</option><option>open</option><option>filled</option><option>resting</option><option>rejected</option><option>broker_rejected</option><option>outcome_unknown</option><option>cancelled</option><option>expired</option><option>analysed</option></select></label>
<label>Result<select id="fr"><option value="">all</option><option>win</option><option>loss</option><option>breakeven</option></select></label>
<label>Symbol<input id="fy" size="10"></label><label>Strategy<input id="fg" size="12"></label><button id="bf">Apply</button></div>
<div class="tw"><table><thead><tr><th>Last event</th><th>Symbol</th><th>Status</th><th>Origin</th><th>Strategy</th><th>Net P&amp;L</th><th>Result</th><th>Trade id</th></tr></thead><tbody id="tb"></tbody></table></div></section>
<section id="det" hidden><h2 id="dt">Trade</h2><div id="dm" class="mut"></div><div class="tl" id="tl"></div>
<div class="row"><label>Add a note<input id="nt" size="50" maxlength="2000"></label><button id="bn">Add note</button></div><p class="mut">Notes are new entries. Nothing already recorded is edited.</p></section>
<section><h2>Record a trade manually</h2><form id="mf"><div class="row">
<label>Symbol<input name="symbol" required placeholder="BTCUSDT" size="10"></label><label>Side<select name="side"><option>buy</option><option>sell</option></select></label>
<label>Quantity<input name="quantity" required type="number" step="any" min="0" size="8"></label><label>Entry price<input name="entryPrice" required type="number" step="any" min="0"></label>
<label>Exit price (if closed)<input name="exitPrice" type="number" step="any" min="0"></label><label>Fees (if known)<input name="fees" type="number" step="any" min="0"></label>
<label>Stop<input name="stop" type="number" step="any"></label><label>Strategy<input name="strategy" size="12"></label><label>Reason / notes<input name="reason" size="30" maxlength="1000"></label><button>Record</button></div></form>
<p class="mut">Profit and loss is computed from your entry and exit; it is never typed in.</p></section>
<p class="mut">Analytical record only. Not financial advice. Past results do not guarantee future results.</p>
</main><script>
(function(){
function el(t,x,c){var e=document.createElement(t);if(x!=null)e.textContent=String(x);if(c)e.className=c;return e}
function $(i){return document.getElementById(i)}
function api(p,o){return fetch(p,Object.assign({credentials:'same-origin',headers:{'content-type':'application/json'}},o||{})).then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.message||d.error||('HTTP '+r.status));return d})})}
function money(v){return v==null?'n/a':(v>=0?'+':'')+Number(v).toFixed(2)}
function pct(v){return v==null?'n/a':(v*100).toFixed(1)+'%'}
function num(v,d){return v==null?'n/a':Number(v).toFixed(d==null?2:d)}
function card(root,l,v,c){var d=el('div',null,'c');d.appendChild(el('span',l,'mut'));d.appendChild(el('b',v,c));root.appendChild(d)}
var cur=null;
function load(){
 $('msg').textContent='Loading…';
 api('/api/journal/summary').then(function(d){
  var s=d.stats,p=s.performance,v=d.verification;
  $('ver').textContent=(v.ok?'Chain intact: ':'CHAIN PROBLEM: ')+v.entries+' entries, storage '+v.storage+'. '+(v.note||'')+(d.lastSync?' Last sync '+new Date(d.lastSync.at).toISOString()+'.':'');$('ver').className=v.ok?'ok':'bad';
  $('warn').textContent=s.dataQuality.sampleWarning||'';
  var c=$('cards');c.textContent='';
  card(c,'Closed trades',p.closed);card(c,'Win rate',pct(p.winRate));card(c,'Net P&L',money(p.netPnl),p.netPnl>=0?'ok':'bad');card(c,'Expectancy / trade',money(p.expectancy));card(c,'Profit factor',num(p.profitFactor));
  card(c,'Payoff ratio',num(p.payoffRatio));card(c,'Max drawdown',num(p.maxDrawdown));card(c,'Max loss streak',p.maxLossStreak);card(c,'Avg R (known risk)',p.avgR==null?'n/a':num(p.avgR)+' ('+p.rSample+')');card(c,'Trades w/ unknown fees',p.feesUnknownTrades);
  var o=$('ord');o.textContent='';var q=s.orders;card(o,'Executed',q.executed);card(o,'Resting',q.open);card(o,'Refused by safeguards',q.refused);card(o,'Rejected by broker',q.brokerRejected);card(o,'Outcome unknown',q.outcomeUnknown);card(o,'Cancelled',q.cancelled);card(o,'Expired',q.expired);card(o,'Analysed, no order',q.analysedOnly);
  $('reasons').textContent=q.refusalReasons.length?'Top refusal reasons: '+q.refusalReasons.map(function(r){return r.reason+' ('+r.count+')'}).join('; '):'';
  var pr=$('pred');pr.textContent='';var x=s.predictions;card(pr,'BUY/SELL predictions',x.total);card(pr,'Evaluated',x.evaluated);card(pr,'Hits',x.hits,'ok');card(pr,'Misses',x.misses,'bad');card(pr,'Hit rate',pct(x.hitRate));card(pr,'Pending',x.pending);card(pr,'Inconclusive',x.inconclusive);
  var ul=$('ins');ul.textContent='';(d.insights||[]).forEach(function(i){var li=el('li');li.appendChild(el('b',i.title+' '));li.appendChild(el('span','['+i.severity+'] '+i.detail,i.severity==='action'?'warn':'mut'));ul.appendChild(li)});
  if(!(d.insights||[]).length)ul.appendChild(el('li','No insights yet.','mut'));
  $('msg').textContent=s.entries+' journal entries, '+s.trades+' tracked trades.';
  return trades();
 }).catch(function(e){$('msg').textContent='Could not load the journal: '+e.message;$('msg').className='bad'})
}
function trades(){
 var q=new URLSearchParams();[['status','fs'],['result','fr'],['symbol','fy'],['strategy','fg']].forEach(function(m){var v=$(m[1]).value.trim();if(v)q.set(m[0],v)});
 return api('/api/journal/trades?'+q.toString()).then(function(d){
  var tb=$('tb');tb.textContent='';
  d.trades.forEach(function(t){var tr=el('tr',null,'t');tr.tabIndex=0;
   [new Date(t.lastAt).toISOString().replace('T',' ').slice(0,19),t.symbol||'',t.status,t.origin,t.strategy||'',money(t.net),t.result||'',t.tradeId].forEach(function(v,i){var td=el('td',v);if(i===5&&t.net!=null)td.className=t.net>=0?'ok':'bad';tr.appendChild(td)});
   var open=function(){detail(t.tradeId)};tr.addEventListener('click',open);tr.addEventListener('keydown',function(e){if(e.key==='Enter')open()});tb.appendChild(tr)});
  if(!d.trades.length)tb.appendChild(el('tr',null)).appendChild(el('td','No trades match.','mut'));
 })
}
function detail(id){
 api('/api/journal/trades/'+encodeURIComponent(id)).then(function(d){
  cur=id;$('det').hidden=false;$('dt').textContent='Trade '+id;var t=d.trade;
  $('dm').textContent=[t.symbol,t.status,t.environment,t.strategy,t.entryPrice!=null?'entry '+t.entryPrice:'',t.exitPrice!=null?'exit '+t.exitPrice:'',t.net!=null?'net '+money(t.net):'',t.feesKnown?'':'fees unknown'].filter(Boolean).join(' | ');
  var tl=$('tl');tl.textContent='';t.timeline.forEach(function(e){var dv=el('div');dv.appendChild(el('span',new Date(e.at).toISOString().replace('T',' ').slice(0,19)+'  ','mut'));dv.appendChild(el('span',e.summary));dv.appendChild(el('span','  ['+e.kind+', '+e.source+']','mut'));tl.appendChild(dv)});
  $('det').scrollIntoView();
 }).catch(function(e){$('msg').textContent=e.message})
}
$('bf').addEventListener('click',function(){trades()});
$('bver').addEventListener('click',function(){api('/api/journal/verify').then(function(v){$('ver').textContent=(v.ok?'Chain intact: ':'CHAIN PROBLEM: ')+v.checked+' entries checked. '+v.note;$('ver').className=v.ok?'ok':'bad'}).catch(function(e){$('msg').textContent=e.message})});
$('bsync').addEventListener('click',function(){$('msg').textContent='Syncing…';api('/api/journal/sync',{method:'POST',body:'{}'}).then(function(r){$('msg').textContent='Sync added '+r.added+' entries ('+r.predictionsEvaluated+' predictions evaluated)'+(r.errors.length?'; problems: '+r.errors.join(', '):'')+'.';load()}).catch(function(e){$('msg').textContent=e.message})});
$('bn').addEventListener('click',function(){var t=$('nt').value.trim();if(!cur||!t)return;api('/api/journal/note',{method:'POST',body:JSON.stringify({tradeId:cur,text:t})}).then(function(){$('nt').value='';detail(cur)}).catch(function(e){$('msg').textContent=e.message})});
$('mf').addEventListener('submit',function(ev){ev.preventDefault();var f=new FormData($('mf')),b={};f.forEach(function(v,k){if(v!=='')b[k]=v});
 api('/api/journal/manual',{method:'POST',body:JSON.stringify(b)}).then(function(r){$('msg').textContent='Recorded '+r.entry.tradeId;$('mf').reset();load()}).catch(function(e){$('msg').textContent='Not recorded: '+e.message})});
load();
})();
</script></body></html>`;
}
