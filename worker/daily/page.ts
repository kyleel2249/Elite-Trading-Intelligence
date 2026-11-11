/**
 * ETI Daily Intelligence Report page (/daily). It renders only what /api/daily-report returns and shows an explicit error when the
 * report cannot be produced. All report text is inserted with textContent, never as HTML.
 * NOTE: this HTML lives in a template literal. Keep the embedded script free of backticks, dollar-brace sequences and backslashes.
 */
const CSS = `
:root{color-scheme:dark;--bg:#050914;--panel:rgba(14,24,48,.78);--line:rgba(56,189,248,.28);--txt:#e8f1ff;--mut:#8fa6c8;--cyan:#22d3ee;--green:#10d9a0;--red:#ff4d6d;--orange:#ff9f43;--gold:#f5c542}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}body{background:radial-gradient(1000px 500px at 10% -10%,#10224a 0,transparent 60%),var(--bg);color:var(--txt);font:14px/1.5 Inter,system-ui,Segoe UI,Roboto,sans-serif}
a{color:var(--cyan)}button{font:inherit;color:var(--txt);background:rgba(34,211,238,.12);border:1px solid var(--line);border-radius:10px;padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
header{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:20px;letter-spacing:1px}main{max-width:1100px;margin:0 auto;padding:16px 18px 60px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;margin:12px 0}
.card h2{margin:0 0 8px;font-size:15px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.card ul{margin:0;padding-left:18px}.card li{margin:3px 0;overflow-wrap:anywhere}.mut{color:var(--mut)}
.badge{font-size:11px;border-radius:999px;padding:1px 8px;border:1px solid var(--mut);color:var(--mut)}.badge.ok{border-color:var(--green);color:var(--green)}.badge.partial{border-color:var(--orange);color:var(--orange)}.badge.unavailable{border-color:var(--red);color:var(--red)}
.err{color:var(--orange);border:1px dashed rgba(255,159,67,.6);border-radius:10px;padding:10px;margin:12px 0}
.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:720px}th,td{padding:8px 6px;border-bottom:1px solid rgba(99,102,241,.25);text-align:left;vertical-align:top;font-size:13px}th{color:var(--mut)}
.BUY{color:var(--green);font-weight:700}.SELL{color:var(--red);font-weight:700}.NO{color:var(--mut);font-weight:700}
.verdict{font-size:18px;font-weight:700}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const BODY = `
<header>
 <div><h1>ETI GLOBAL MARKET INTELLIGENCE</h1><div class="mut" id="when">Loading the daily report…</div></div>
 <div><button id="refresh">Refresh report</button> <a href="/api/daily-report?format=markdown" id="md">Markdown</a> · <a href="/api/daily-report" id="js">JSON</a> · <a href="/command">Command Centre</a></div>
</header>
<main id="main" aria-live="polite"></main>
`;

const JS = `
var $=function(id){return document.getElementById(id)};
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function show(msg){var m=$('main');m.textContent='';m.appendChild(el('div','err',msg));}
function render(r){
 var m=$('main');m.textContent='';
 $('when').textContent=r.dateTimeUtc+' · generated '+r.generatedAt.slice(11,19)+' UTC'+(r.cache?(r.cache.hit?' · cached '+r.cache.ageSeconds+' s':' · fresh'):'');
 var v=el('div','card');v.appendChild(el('div','verdict','Final market-readiness verdict: '+r.finalVerdict.label));v.appendChild(el('div','mut',r.finalVerdict.summary));v.appendChild(el('div','mut',r.tradingDay.note));m.appendChild(v);
 var t=el('div','card');t.appendChild(el('h2',null,'Opportunity table'));var sc=el('div','scroll');var tb=el('table');
 var hr=el('tr');['Asset','Direction','Setup','Risk','ETI verdict'].forEach(function(h){hr.appendChild(el('th',null,h));});tb.appendChild(hr);
 r.opportunities.forEach(function(o){var tr=el('tr');var a=el('td',null,o.asset);a.appendChild(el('div','mut',o.instrument));tr.appendChild(a);tr.appendChild(el('td',o.direction==='BUY'?'BUY':o.direction==='SELL'?'SELL':'NO',o.direction));tr.appendChild(el('td',null,o.setup));tr.appendChild(el('td',null,o.risk));tr.appendChild(el('td',null,o.verdict));tb.appendChild(tr);});
 sc.appendChild(tb);t.appendChild(sc);m.appendChild(t);
 r.sections.forEach(function(s){var c=el('section','card');var h=el('h2',null,s.number+'. '+s.title);h.appendChild(el('span','badge '+s.status,s.status));c.appendChild(h);var ul=el('ul');s.lines.forEach(function(l){ul.appendChild(el('li',null,l.trim()));});c.appendChild(ul);m.appendChild(c);});
 var q=el('div','card');q.appendChild(el('h2',null,'Data quality'));var u=el('ul');u.appendChild(el('li',null,'Economic calendar: '+r.dataQuality.calendar));r.dataQuality.assets.forEach(function(a){u.appendChild(el('li',null,a.asset+': '+a.status+(a.note?' ('+a.note+')':'')));});
 u.appendChild(el('li',null,'Subrequest budget: '+r.dataQuality.budget.used+' of '+r.dataQuality.budget.limit+' used'+(r.dataQuality.budget.deferred.length?'; deferred: '+r.dataQuality.budget.deferred.join(', '):'')));q.appendChild(u);m.appendChild(q);
 var d=el('div','card mut');r.disclaimers.forEach(function(x){d.appendChild(el('p',null,x));});m.appendChild(d);
}
async function load(refresh){
 var b=$('refresh');b.disabled=true;b.textContent='Loading…';
 try{
  var ctl=new AbortController(),tm=setTimeout(function(){ctl.abort();},45000);
  var res=await fetch('/api/daily-report'+(refresh?'?refresh=1':''),{cache:'no-store',signal:ctl.signal});clearTimeout(tm);
  var j=await res.json().catch(function(){return null;});
  if(!res.ok||!j)throw new Error(j&&(j.error||j.detail)?String(j.error||'')+' '+String(j.detail||''):'HTTP '+res.status);
  render(j);
 }catch(e){show('The report is unavailable: '+(e.name==='AbortError'?'timed out after 45 s':e.message)+'. No figures are shown because none were produced.');}
 b.disabled=false;b.textContent='Refresh report';
}
$('refresh').onclick=function(){load(true);};
load(false);
`;

export function dailyPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Global Market Intelligence: Daily Report</title><style>${CSS}</style></head><body>${BODY}<script>${JS}</script></body></html>`;
}
