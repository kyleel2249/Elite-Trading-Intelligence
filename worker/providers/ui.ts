/** /providers page: provider status, data freshness and the coverage matrix. textContent only. */
const CSS = `:root{--bg:#0b0f17;--card:#121a27;--line:#223048;--fg:#e6edf7;--mut:#8da0bb;--ok:#2fd18b;--warn:#f0b429;--bad:#ff6b6b;--acc:#4da3ff}
@media (prefers-color-scheme:light){:root{--bg:#f4f7fb;--card:#fff;--line:#d5deeb;--fg:#122033;--mut:#52637d;--ok:#0a8f5b;--warn:#a86b00;--bad:#c0392b;--acc:#1763c7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:20px}h2{font-size:16px;margin:0 0 10px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}.mut{color:var(--mut)}a{color:var(--acc)}
.s{font-weight:700}.s.ok{color:var(--ok)}.s.degraded,.s.stale,.s.unknown{color:var(--warn)}.s.down,.s.uncovered{color:var(--bad)}.s.covered{color:var(--ok)}.s.unconfigured,.s.unverified{color:var(--mut)}
button{padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;cursor:pointer}button:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}`;
const JS = `(function(){
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function ago(s){if(s==null)return 'never';if(s<90)return s+'s ago';if(s<5400)return Math.round(s/60)+' min ago';return Math.round(s/3600)+' h ago'}
function draw(j){var pb=document.getElementById('prov');pb.textContent='';j.providers.forEach(function(p){var tr=el('tr');tr.appendChild(el('td',null,p.label));var t=el('td');t.appendChild(el('span','s '+p.state,p.state));tr.appendChild(t);
 tr.appendChild(el('td',null,ago(p.freshness.ageSec)+(p.freshness.latencyMs!=null?' ('+p.freshness.latencyMs+' ms)':'')));
 tr.appendChild(el('td',null,Object.keys(p.capabilities).map(function(k){var c=p.capabilities[k];return k+' ['+c.level+', '+c.delivery+']'}).join('; ')));
 tr.appendChild(el('td','mut',p.missing.length?'needs '+p.missing.join(', '):(p.freshness.lastError||p.limits)));pb.appendChild(tr)});
 var cb=document.getElementById('cov');cb.textContent='';Object.keys(j.coverage).forEach(function(k){var c=j.coverage[k],tr=el('tr');tr.appendChild(el('td',null,k));var t=el('td');t.appendChild(el('span','s '+c.status,c.status));tr.appendChild(t);tr.appendChild(el('td','mut',c.providers.map(function(p){return p.id+' ('+p.state+')'}).join(', ')||'no adapter'));cb.appendChild(tr)});
 document.getElementById('gen').textContent='Updated '+new Date(j.generatedAt).toISOString().replace('T',' ').slice(0,19)+' UTC. '+j.note}
function load(){fetch('/api/providers/status',{credentials:'same-origin'}).then(function(r){return r.json()}).then(draw)}
document.getElementById('probe').addEventListener('click',function(){var m=document.getElementById('pm');m.textContent='Checking...';fetch('/api/providers/probe',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json().then(function(j){if(r.ok){draw(j);m.textContent='Done.'}else m.textContent=j.message||j.error})})});
load();setInterval(load,30000)})();`;
export const PROVIDERS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Data Providers</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body><main>
<h1>Data providers <span class="mut">- <a href="/">dashboard</a> - <a href="/account">account</a></span></h1>
<p class="mut" id="gen">Loading...</p>
<section class="card"><h2>Provider status and freshness</h2><div class="tw"><table><thead><tr><th>Provider</th><th>State</th><th>Last good response</th><th>Serves</th><th>Notes</th></tr></thead><tbody id="prov"></tbody></table></div><p><button id="probe">Check providers now</button> <span id="pm" class="mut" role="status" aria-live="polite"></span></p></section>
<section class="card"><h2>Coverage by data type</h2><div class="tw"><table><thead><tr><th>Data</th><th>Coverage</th><th>Providers</th></tr></thead><tbody id="cov"></tbody></table></div></section>
</main><script>${JS}</script></body></html>`;
