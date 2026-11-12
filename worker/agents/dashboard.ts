/** ETI Agent Intelligence Center. Static page; every value shown comes from the live /api/agents endpoints (rendered with textContent, never innerHTML). */
export const DASHBOARD_HTML = `<!doctype html>
<html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>ETI Agent Intelligence Center</title>
<style>
:root{--bg:#0e1116;--card:#161b22;--fg:#e6edf3;--mut:#8b949e;--bd:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--acc:#58a6ff}
@media(prefers-color-scheme:light){:root{--bg:#f6f8fa;--card:#fff;--fg:#1f2328;--mut:#656d76;--bd:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--acc:#0969da}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;padding:12px;max-width:1200px;margin:auto}
h1{font-size:20px;margin:4px 0}h2{font-size:15px;margin:18px 0 8px}.mut{color:var(--mut)}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
input,select,button{background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:6px;padding:8px;font:inherit;min-height:40px}button{cursor:pointer}button:hover{border-color:var(--acc)}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mut);gap:2px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px;overflow:hidden}.badge{display:inline-block;padding:1px 8px;border-radius:10px;border:1px solid var(--bd);font-size:12px;margin-right:4px}
.bullish,.ok{color:var(--ok);border-color:var(--ok)}.bearish,.error{color:var(--bad);border-color:var(--bad)}.insufficient_data,.no_data{color:var(--warn);border-color:var(--warn)}
.bar{height:6px;background:var(--bd);border-radius:3px;margin:6px 0}.bar>i{display:block;height:100%;background:var(--acc);border-radius:3px}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{border-bottom:1px solid var(--bd);padding:4px;text-align:left;vertical-align:top;word-break:break-word}
details{margin-top:6px}summary{cursor:pointer;color:var(--acc)}.big{font-size:22px;font-weight:700}ul{margin:4px 0;padding-left:18px}.wrap{overflow-x:auto}
</style></head><body>
<h1>ETI Agent Intelligence Center</h1>
<div class='mut'>Every value below is read from the live backend. Agents run <b>on demand</b> (no background jobs exist); auto-refresh is a client-side timer that re-runs the analysis. Analytical only: paper/testnet execution is separate and token-gated.</div>
<h2>Controls</h2>
<div class='row'>
<label>Symbol<input id='symbol' value='BTCUSDT' size='10'></label>
<label>Interval<select id='interval'><option>5m</option><option>15m</option><option selected>1h</option><option>4h</option><option>1d</option></select></label>
<label>Benchmark (optional)<input id='bench' placeholder='ETHUSDT' size='10'></label>
<label>Equity USD (optional)<input id='equity' type='number' min='0' placeholder='10000' size='10'></label>
<label>Auto-refresh<select id='every'><option value='30'>30 s</option><option value='60' selected>60 s</option><option value='120'>120 s</option></select></label>
<button id='run'>Run analysis</button><button id='start'>Start auto</button><button id='pause'>Pause</button><button id='resume'>Resume</button><button id='stop'>Stop</button>
<span>State: <b id='state'>idle</b> &middot; <span id='last' class='mut'>not run yet</span></span></div>
<div id='err' class='card' style='display:none;border-color:var(--bad)'></div>
<h2>Commander decision</h2><div id='decision' class='card mut'>No analysis has been run in this session.</div>
<h2>Agents</h2><div id='agents' class='grid'></div>
<h2>Risk Manager checks</h2><div id='risk' class='card wrap mut'>Risk Manager has not evaluated a proposal yet.</div>
<h2>Data providers</h2><div id='prov' class='card wrap mut'>Run an analysis to see provider health.</div>
<h2>Agent-to-agent messages</h2><div id='msgs' class='card wrap mut'>None yet.</div>
<h2>Auditor</h2><div id='audit' class='card mut'>Loading&hellip;</div>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined&&x!==null)e.textContent=String(x);return e}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function fmt(v){if(typeof v==='number')return Number.isInteger(v)?String(v):String(Number(v.toPrecision(5)));return v===null||v===undefined?'-':String(v)}
function api(u,o){return fetch(u,o).then(function(r){return r.json().catch(function(){return {}}).then(function(j){j._status=r.status;return j})})}
var roster=[],timer=null,busy=false,paused=false;
function setState(s){$('state').textContent=s}
function badge(t,c){return el('span','badge '+(c||t),t)}
function table(head,rows){var t=el('table'),h=el('tr');head.forEach(function(x){h.appendChild(el('th',null,x))});t.appendChild(h);rows.forEach(function(r){var tr=el('tr');r.forEach(function(c){tr.appendChild(el('td',null,c))});t.appendChild(tr)});return t}
function agentCard(a,r){var c=el('div','card'),h=el('div');h.appendChild(el('b',null,a.number+'. '+a.name));c.appendChild(h);
if(r){var b=el('div');b.appendChild(badge(r.status));b.appendChild(badge(r.stance));b.appendChild(el('span','mut','confidence '+fmt(r.confidence)));c.appendChild(b);
var bar=el('div','bar'),i=el('i');i.style.width=Math.round(r.confidence*100)+'%';bar.appendChild(i);c.appendChild(bar);c.appendChild(el('div',null,r.summary));
if(r.missingInputs&&r.missingInputs.length){c.appendChild(el('div','mut','Missing: '+r.missingInputs.join('; ')))}
if(r.warnings&&r.warnings.length){var u=el('ul');r.warnings.forEach(function(w){u.appendChild(el('li','mut',w))});c.appendChild(u)}
if(r.evidence&&r.evidence.length){var d=el('details');d.appendChild(el('summary',null,'Evidence ('+r.evidence.length+')'));d.appendChild(table(['Item','Value','Note'],r.evidence.map(function(e){return [e.label,fmt(e.value),e.note||'']})));c.appendChild(d)}
c.appendChild(el('div','mut','as of '+r.generatedAt))}else{c.appendChild(badge('not run','no_data'))}
var m=el('div','mut',a.mandate);m.style.marginTop='6px';c.appendChild(m);if(a.externalDataRequired){c.appendChild(el('div','mut','Needs: '+a.externalDataRequired))}return c}
function renderAgents(reports){var g=$('agents');clear(g);var by={};(reports||[]).forEach(function(r){by[r.agent]=r});roster.forEach(function(a){g.appendChild(agentCard(a,by[a.id]))})}
function renderDecision(res){var d=res.decision,n=$('decision');clear(n);n.className='card';
var h=el('div');h.appendChild(el('span','big',d.action));h.appendChild(el('span','mut',' confidence '+fmt(d.confidence)+' (heuristic, not a probability)'));n.appendChild(h);
if(d.vetoedBy){var v=el('div','error badge','VETOED BY '+d.vetoedBy.toUpperCase());n.appendChild(v)}
n.appendChild(el('div','mut','Agreement '+fmt(d.consensus.agreement)+' | coverage '+fmt(d.consensus.coverage)+' | participating: '+d.consensus.participating.join(', ')));
var u=el('ul');d.rationale.forEach(function(x){u.appendChild(el('li',null,x))});n.appendChild(u);
if(d.disagreements.length){n.appendChild(el('b',null,'Disagreements'));d.disagreements.forEach(function(x){var b=el('div','card');b.appendChild(el('div',null,x.topic+': '+x.explanation));b.appendChild(el('div','mut','Resolution: '+x.resolution));b.appendChild(table(['Agent','Stance','Conf','Reason'],x.positions.map(function(p){return [p.agent,p.stance,fmt(p.confidence),p.reason]})));n.appendChild(b)})}
if(d.proposal){var p=d.proposal;n.appendChild(el('div','mut','Proposal: '+p.side+' @ '+fmt(p.entry)+' stop '+fmt(p.stop)+' targets '+p.targets.map(fmt).join(' / ')))}
if(d.risk&&d.risk.sizing){n.appendChild(el('div','mut','Risk-approved size: '+fmt(d.risk.sizing.quantity)+' units, notional $'+fmt(d.risk.sizing.notionalUsd)+', risk $'+fmt(d.risk.sizing.riskUsd)))}}
function renderRisk(res){var n=$('risk');clear(n);if(!res.risk){n.textContent='No proposal reached the Risk Manager (no directional consensus).';return}n.className='card wrap';n.appendChild(el('div',null,'Decision: '+res.risk.decision.toUpperCase()));n.appendChild(table(['Check','Passed','Detail'],res.risk.checks.map(function(c){return [c.id,c.passed?'yes':'NO ('+c.severity+')',c.detail]})))}
function renderProviders(res){var n=$('prov');clear(n);n.className='card wrap';var rows=(res.providers||[]).map(function(p){return [p.provider,p.ok?'ok':'FAILED',fmt(p.latencyMs)+' ms',p.items===undefined?'':p.items,p.detail||'']});var q=res.dataQuality||{};rows.unshift(['market:'+q.provider,'ok','', q.candles+' candles','book: '+q.orderBook+'; cross-check: '+q.priceCrossCheck]);Object.keys(q.failures||{}).forEach(function(k){rows.push(['market:'+k,'FAILED','','',q.failures[k]])});n.appendChild(table(['Provider','Status','Latency','Items','Detail'],rows))}
function renderMsgs(res){var n=$('msgs');clear(n);n.className='card wrap';n.appendChild(table(['#','From','To','Type','Payload (truncated)'],res.messages.map(function(m){return [m.seq,m.from,m.to,m.type,JSON.stringify(m.payload).slice(0,160)]})))}
function showErr(t){var e=$('err');e.style.display='block';e.textContent=t}
function run(){if(busy)return;busy=true;setState('running');$('err').style.display='none';
var body={symbol:$('symbol').value.trim().toUpperCase(),interval:$('interval').value},b=$('bench').value.trim(),eq=parseFloat($('equity').value);
if(b)body.benchmark=b.toUpperCase();if(isFinite(eq)&&eq>0)body.account={equityUsd:eq};
return api('/api/agents/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(res){
if(res.error){showErr('Backend error: '+res.error+(res.detail?' ('+JSON.stringify(res.detail)+')':''));return}
renderAgents(res.reports);renderDecision(res);renderRisk(res);renderProviders(res);renderMsgs(res);$('last').textContent='last run '+res.generatedAt}).catch(function(e){showErr('Request failed: '+e)}).then(function(){busy=false;setState(timer?'auto-refresh':paused?'paused':'idle')})}
function stopTimer(){if(timer){clearInterval(timer);timer=null}}
function startTimer(){stopTimer();timer=setInterval(run,parseInt($('every').value,10)*1000);paused=false;run()}
$('run').onclick=run;$('start').onclick=startTimer;
$('pause').onclick=function(){stopTimer();paused=true;setState('paused')};
$('resume').onclick=function(){if(paused)startTimer()};
$('stop').onclick=function(){stopTimer();paused=false;setState('stopped')};
api('/api/agents').then(function(r){roster=r.agents||[];renderAgents([]);var a=$('audit');clear(a);var s=r.auditSummary;
if(!s||!s.resolved){a.textContent='No resolved recorded decisions yet, so there is no measured performance to show. Record decisions with an authorised request and call GET /api/agents/audit.';return}
a.appendChild(el('div',null,s.resolved+' resolved decisions; win rate '+(s.winRate*100).toFixed(0)+'% (95% CI '+(s.winRateCi95[0]*100).toFixed(0)+'-'+(s.winRateCi95[1]*100).toFixed(0)+'%); avg R '+fmt(s.avgR)));
a.appendChild(table(['Agent','n','Accuracy','Flag'],Object.keys(s.agentAccuracy).map(function(k){var x=s.agentAccuracy[k];return [k,x.n,fmt(x.accuracy),x.flag]})))}).catch(function(e){showErr('Could not load roster: '+e)});
})();
</script></body></html>`;
