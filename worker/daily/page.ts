/**
 * /daily: read-only viewer for the stored ETI daily intelligence report (GET /api/daily-report/latest).
 * Rendered with textContent only, so report text can never inject markup. Contains no template-literal interpolation.
 */
export function dailyPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ETI Daily Intelligence Report</title>
<style>
:root{color-scheme:dark light;--bg:#0b1118;--fg:#e8eef6;--mut:#8fa1b5;--card:#121b26;--line:#233245;--ok:#21d69a;--warn:#ffb08c}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fb;--fg:#0f1722;--mut:#50627a;--card:#fff;--line:#d5dde8;--ok:#0a8f66;--warn:#b4532a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:.2rem 0}.mut{color:var(--mut)}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:12px 0}
h2{font-size:1.05rem;margin:0 0 6px}ul{margin:6px 0 0;padding-left:20px}.ok{color:var(--ok)}.partial,.unavailable{color:var(--warn)}
table{width:100%;border-collapse:collapse;display:block;overflow-x:auto}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;white-space:nowrap}
</style></head><body><main>
<h1 id="t">ETI Daily Intelligence Report</h1><p class="mut" id="m">Loading the latest stored report…</p><div id="r"></div>
<p class="mut">Analytical information only. Not financial advice; no order is placed from this page.</p>
</main><script>
(function(){
function el(tag,text,cls){var e=document.createElement(tag);if(text!=null)e.textContent=String(text);if(cls)e.className=cls;return e}
fetch('/api/daily-report/latest',{credentials:'same-origin'}).then(function(r){return r.json().then(function(d){return {r:r,d:d}})}).then(function(x){
 var m=document.getElementById('m'),root=document.getElementById('r'),rep=x.d&&(x.d.report||x.d);
 if(!x.r.ok||!rep||!rep.sections){m.textContent=(x.d&&(x.d.message||x.d.error))||'No stored report is available yet.';return}
 m.textContent='Generated '+(rep.dateTimeUtc||rep.generatedAt||'')+' (UTC)';
 rep.sections.forEach(function(s){var sec=el('section');var h=el('h2',s.number+'. '+s.title+' ');h.appendChild(el('span','['+s.status+']',s.status));sec.appendChild(h);
  var ul=el('ul');(s.lines||[]).forEach(function(l){ul.appendChild(el('li',l))});sec.appendChild(ul);root.appendChild(sec)});
 if(rep.opportunities&&rep.opportunities.length){var sec=el('section');sec.appendChild(el('h2','Opportunities'));var t=el('table'),keys=Object.keys(rep.opportunities[0]);
  var hr=el('tr');keys.forEach(function(k){hr.appendChild(el('th',k))});t.appendChild(hr);
  rep.opportunities.forEach(function(o){var tr=el('tr');keys.forEach(function(k){var v=o[k];tr.appendChild(el('td',v==null?'':(typeof v==='object'?JSON.stringify(v):v)))});t.appendChild(tr)});sec.appendChild(t);root.appendChild(sec)}
}).catch(function(e){document.getElementById('m').textContent='Could not load the report: '+e.message});
})();
</script></body></html>`;
}
