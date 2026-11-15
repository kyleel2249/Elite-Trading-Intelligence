/**
 * /profit: automatic profit management dashboard. Data comes only from /api/profit/*. Rendered with textContent (no HTML injection).
 * Shows realized net profit, what is still pending confirmation, what is excluded and why, capital-protection checks, the allocation
 * recommendation, the expense forecast and downloadable reports.
 */
import { withMotion } from "../ui/motion.ts";

const BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ETI Profit Management</title>
<style>
:root{--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--green:#21d69a;--red:#ff637d;--blue:#56a8ff;--amber:#ffc247}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 55%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}
header{padding:18px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:22px;margin:0}
main{padding:20px 4vw 48px;max-width:1400px;margin:auto}a{color:var(--blue);text-decoration:none}nav a{margin-left:14px;font-size:13px}.mut{color:var(--muted)}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}
.panel{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--panel);min-width:0;margin-bottom:16px}h2{font-size:15px;margin:0 0 12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}.tile{border:1px solid var(--line);border-radius:12px;padding:14px;background:rgba(8,13,22,.55)}
.tile b{display:block;font-size:22px;margin-top:6px;overflow-wrap:anywhere}.tile span{font-size:12px;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;overflow-wrap:anywhere}th{color:var(--muted);font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}select,button,input{background:#0b1422;color:#eaf2ff;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}button{cursor:pointer}button:focus-visible,select:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.banner{border:1px solid var(--amber);color:var(--amber);border-radius:10px;padding:10px 12px;margin-bottom:14px}.note{font-size:12px;color:var(--muted);margin-top:8px}
.wrap{overflow-x:auto}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header><div><h1>Profit management</h1><div class="mut">Realized, confirmed, net of fees. Never unrealized.</div></div>
<nav><a href="/">Home</a><a href="/treasury">Treasury</a><a href="/company">Company</a><a href="/journal">Journal</a><a href="/wallet/chain">Wallet</a></nav></header>
<main>
<div class="row"><label>Books <select id="env"><option value="simulated">Simulated (paper/testnet)</option><option value="actual">Actual funds</option></select></label>
<label>Report period <input id="period" value="" placeholder="YYYY-Qn, YYYY-MM or all" size="18"></label>
<button id="run" type="button">Recognise and allocate now</button><button id="refresh" type="button">Refresh</button>
<a id="md" href="#">Report (Markdown)</a><a id="csv" href="#">Report (CSV)</a></div>
<div id="banner" class="banner" hidden></div><div id="msg" class="note" role="status"></div>
<section class="panel"><h2>Realized results</h2><div class="grid" id="tiles"></div></section>
<section class="panel"><h2>Capital protection</h2><div class="wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody id="checks"></tbody></table></div><div id="hold" class="note"></div></section>
<section class="panel"><h2>Distributable profit and recommendation</h2><div id="rec" class="note"></div><div class="wrap"><table><thead><tr><th>Account</th><th>Amount</th><th>Reason</th></tr></thead><tbody id="alloc"></tbody></table></div></section>
<section class="panel"><h2>Balances</h2><div class="grid" id="bal"></div></section>
<section class="panel"><h2>Expense forecast</h2><div id="fc" class="note"></div><div class="wrap"><table><thead><tr><th>Month</th><th>Low</th><th>Base</th><th>High</th></tr></thead><tbody id="fcrows"></tbody></table></div></section>
<section class="panel"><h2>Excluded from profit <span class="mut">(not counted)</span></h2><div class="wrap"><table><thead><tr><th>Reason</th><th>Trades</th></tr></thead><tbody id="ex"></tbody></table></div>
<div class="note">Open positions, resting orders, unknown outcomes, unconfirmed fees, hand-typed trades and results inside the confirmation window are never used for allocation.</div></section>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)},E=$("env");
function usd(c){if(c==null)return"-";var n=Number(c)/100;return(n<0?"-":"")+"$"+Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild)}
function cell(tr,t,cls){var td=document.createElement("td");td.textContent=t;if(cls)td.className=cls;tr.appendChild(td)}
function tile(host,label,val,cls){var d=document.createElement("div");d.className="tile";var s=document.createElement("span");s.textContent=label;var b=document.createElement("b");b.textContent=val;if(cls)b.className=cls;d.appendChild(s);d.appendChild(b);host.appendChild(d)}
function say(t,bad){var m=$("msg");m.textContent=t;m.className="note "+(bad?"bad":"")}
function get(path){return fetch(path,{credentials:"same-origin",headers:{accept:"application/json"}}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||j.error||("HTTP "+r.status));return j})})}
function period(){return $("period").value.trim()||""}
function links(){var q="environment="+E.value+(period()?"&period="+encodeURIComponent(period()):"");$("md").href="/api/profit/report?"+q+"&format=md";$("csv").href="/api/profit/report?"+q+"&format=csv"}
function render(s){
 var b=$("banner");if(s.environment==="actual"){b.hidden=false;b.textContent="Actual funds: this page only reports and recommends. Real profit is recorded through the treasury's three-person batch workflow."}else{b.hidden=false;b.textContent="SIMULATED books: paper and testnet results only. Not real money."}
 var t=$("tiles");clear(t);var r=s.realized,p=s.pending;
 tile(t,"Realized net (recognised + confirmed)",usd(r.netCents),r.netCents<0?"bad":"ok");tile(t,"Gross",usd(r.grossCents));tile(t,"Fees and commissions",usd(r.feesCents));
 tile(t,"Closed trades",String(r.trades)+" ("+r.wins+" W / "+r.losses+" L)");tile(t,"Profit factor",r.profitFactor==null?"n/a":r.profitFactor.toFixed(2));
 tile(t,"Confirmed, not yet posted",usd(p.netCents)+" / "+p.trades+" trades");tile(t,"Distributable now",usd(s.distributableCents),s.distributableCents>0?"ok":"");
 var c=$("checks");clear(c);s.protection.checks.forEach(function(k){var tr=document.createElement("tr");cell(tr,k.name);cell(tr,k.met?"OK":"NOT MET",k.met?"ok":"bad");cell(tr,k.detail);c.appendChild(tr)});
 $("hold").textContent=s.protection.hold?("Distributions on hold: "+s.protection.reason):"No hold in effect.";$("hold").className="note "+(s.protection.hold?"warn":"");
 $("rec").textContent=s.recommendation.note;var a=$("alloc");clear(a);s.recommendation.allocations.forEach(function(x){var tr=document.createElement("tr");cell(tr,x.account);cell(tr,usd(x.cents));cell(tr,x.reason);a.appendChild(tr)});
 var bl=$("bal");clear(bl);if(s.balances){var bk=s.balances.buckets;Object.keys(bk).forEach(function(k){tile(bl,k.replace(/_/g," "),usd(bk[k]))})}
 var ex=$("ex");clear(ex);var keys=Object.keys(s.excludedByReason);if(!keys.length){var tr0=document.createElement("tr");cell(tr0,"Nothing excluded");cell(tr0,"0");ex.appendChild(tr0)}keys.forEach(function(k){var tr=document.createElement("tr");cell(tr,k.replace(/_/g," "));cell(tr,String(s.excludedByReason[k]));ex.appendChild(tr)});
 if(s.notes&&s.notes.length)say(s.notes.join(" "));else say("Updated "+new Date(s.at).toLocaleTimeString()+".");
}
function forecast(f){$("fc").textContent=f.method+". Average "+usd(f.monthlyAverageCents)+"/month over "+f.historyMonths+" month(s). Runway "+(f.runwayMonths==null?"n/a":f.runwayMonths+" months")+". "+f.note;var b=$("fcrows");clear(b);f.months.forEach(function(m){var tr=document.createElement("tr");cell(tr,m.month);cell(tr,usd(m.lowCents));cell(tr,usd(m.baseCents));cell(tr,usd(m.highCents));b.appendChild(tr)})}
function load(){links();say("Loading...");get("/api/profit/status?environment="+E.value).then(render).catch(function(e){say(e.message,true)});get("/api/profit/forecast?environment="+E.value+"&months=3").then(forecast).catch(function(){})}
$("refresh").onclick=load;E.onchange=load;$("period").onchange=links;
$("run").onclick=function(){if(E.value!=="simulated"){say("Actual-funds books are never posted automatically.",true);return}say("Running...");fetch("/api/profit/run",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({environment:"simulated"})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.message||j.error);return j})}).then(function(j){say(j.blocked?("Blocked: "+j.blocked):("Done: "+((j.recognised||[]).length)+" batch(es) recognised"+(j.allocation?", allocated "+usd(j.allocation.totalCents):"")+"."),!!j.blocked);load()}).catch(function(e){say(e.message,true)})};
load();
})();
</script></body></html>`;

export const profitPage = (): string => withMotion(BODY);
