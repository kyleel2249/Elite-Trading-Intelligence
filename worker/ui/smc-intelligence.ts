/** Shared SMC confluence panel for ETI dashboard, live chart and Pro Terminal.
 * Read-only: consumes the existing confluence API; never places or authorizes orders.
 */
export const SMC_INTELLIGENCE_CSS = String.raw`<style id="eti-smc-intelligence-css">
.eti-smci{margin:12px 0;padding:12px;border:1px solid #273b52;border-radius:12px;background:linear-gradient(145deg,#0b1727,#101d30);color:#d9e6f5;font:12px/1.5 system-ui,sans-serif;box-sizing:border-box}
.eti-smci *{box-sizing:border-box}.eti-smci-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.eti-smci-title{font-size:14px;font-weight:800;letter-spacing:.04em}.eti-smci-controls{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.eti-smci button,.eti-smci select{background:#15283d;color:#d9e6f5;border:1px solid #344a63;border-radius:7px;padding:6px 9px;font:inherit}.eti-smci button{cursor:pointer}.eti-smci button:disabled{opacity:.5;cursor:wait}.eti-smci-state{color:#94aac3}.eti-smci-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:8px;margin-top:10px}.eti-smci-card{background:#132439;border:1px solid #223b56;border-radius:9px;padding:9px;min-width:0}.eti-smci-card small{display:block;color:#8fa8c3;font-size:10px;text-transform:uppercase;letter-spacing:.08em}.eti-smci-card strong{display:block;font-size:16px;overflow-wrap:anywhere;margin-top:3px}.eti-smci-bull{color:#27d6a0}.eti-smci-bear{color:#ff7189}.eti-smci-neutral{color:#c4d1e1}.eti-smci-meter{height:7px;background:#22364c;border-radius:10px;overflow:hidden;margin:8px 0}.eti-smci-meter span{display:block;height:100%;background:linear-gradient(90deg,#ff7189,#aab8c9,#27d6a0);width:50%;transition:width .2s}.eti-smci-columns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:9px}.eti-smci-section{border-top:1px solid #273b52;padding-top:8px;min-width:0}.eti-smci-section h4{margin:0 0 5px;font-size:11px;color:#9fb4cb;text-transform:uppercase;letter-spacing:.06em}.eti-smci-list{display:grid;gap:4px}.eti-smci-item{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dashed #263a50;padding:4px 0;overflow-wrap:anywhere}.eti-smci-item b{font-weight:650}.eti-smci-item span{color:#91a8c3;text-align:right}.eti-smci-conflict{color:#ffb77a;background:#34271d;border:1px solid #61452e;border-radius:7px;padding:7px;margin-top:7px}.eti-smci-foot{color:#8299b2;font-size:10px;margin-top:8px}.eti-smci[hidden]{display:none}
@media(max-width:800px){.eti-smci-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.eti-smci-columns{grid-template-columns:1fr}.eti-smci{padding:9px}.eti-smci-card strong{font-size:14px}}
</style>`;

export const SMC_INTELLIGENCE_JS = String.raw`<script id="eti-smc-intelligence-js">
(function(){
"use strict";
try{
if(document.getElementById("eti-smci"))return;
const $=id=>document.getElementById(id),root=document.createElement("section");
root.id="eti-smci";root.className="eti-smci";root.setAttribute("aria-label","Smart Money Concepts confluence intelligence");
root.innerHTML='<div class="eti-smci-head"><div><div class="eti-smci-title">SMC INTELLIGENCE</div><div class="eti-smci-state" id="eti-smci-state" aria-live="polite">Waiting for market data…</div></div><div class="eti-smci-controls"><select id="eti-smci-entry" aria-label="Entry timeframe"><option value="5m">5m entry</option><option value="15m" selected>15m entry</option><option value="1h">1h entry</option><option value="4h">4h entry</option></select><button id="eti-smci-refresh" type="button">Refresh</button></div></div><div class="eti-smci-grid"><div class="eti-smci-card"><small>Directional stance</small><strong id="eti-smci-stance" class="eti-smci-neutral">—</strong></div><div class="eti-smci-card"><small>Evidence score</small><strong id="eti-smci-score">—</strong><div class="eti-smci-meter"><span id="eti-smci-meter"></span></div></div><div class="eti-smci-card"><small>Data coverage</small><strong id="eti-smci-coverage">—</strong></div><div class="eti-smci-card"><small>Entry alignment</small><strong id="eti-smci-entry-state">—</strong></div></div><div class="eti-smci-columns"><div class="eti-smci-section"><h4>Directional evidence</h4><div id="eti-smci-evidence" class="eti-smci-list">Awaiting analysis</div></div><div class="eti-smci-section"><h4>Liquidity targets</h4><div id="eti-smci-targets" class="eti-smci-list">Awaiting analysis</div></div><div class="eti-smci-section"><h4>Zone confluence</h4><div id="eti-smci-overlaps" class="eti-smci-list">Awaiting analysis</div></div></div><div id="eti-smci-conflicts"></div><div class="eti-smci-foot">SMC scores summarize observable evidence, not trade probabilities. This panel is analysis-only and cannot place orders.</div>';
function text(id,v){const e=$(id);if(e)e.textContent=v==null?"—":String(v);}
function cls(d){return d==="bullish"?"eti-smci-bull":d==="bearish"?"eti-smci-bear":"eti-smci-neutral";}
function item(a,b){const d=document.createElement("div");d.className="eti-smci-item";const x=document.createElement("b"),y=document.createElement("span");x.textContent=a;y.textContent=b;d.append(x,y);return d;}
function list(id,rows,empty){const e=$(id);if(!e)return;e.replaceChildren();if(!rows||!rows.length){e.textContent=empty;return;}rows.forEach(r=>e.append(item(r[0],r[1])));}
function currentSymbol(){return (($("symbol")&&$("symbol").value)||($("tt-symbol")&&$("tt-symbol").value)||($("sym")&&$("sym").value)||"BTCUSDT").trim().toUpperCase();}
function timeframe(){const e=$("interval")||$("tt-interval");return e&&e.value||"15m";}
function provider(){const e=$("symVenue")||$("tt-venue")||$("venue")||$("ven");return e?(/bitget/i.test(e.value)?"bitget":"bybit"):$("tt-chart")?"bitget":"bybit";}
function market(){const e=$("symMarket")||$("tt-market")||$("mkt");return e?(/future|contract/i.test(e.value)?"futures":"spot"):$("tt-chart")?"futures":"spot";}
let busy=false,sequence=0;
async function refresh(){
 const seq=++sequence;busy=true;const btn=$("eti-smci-refresh");if(btn)btn.disabled=true;text("eti-smci-state","Analyzing closed candles · "+currentSymbol()+"…");
 try{
 const entry=$("eti-smci-entry")?.value||"15m",params=new URLSearchParams({symbol:currentSymbol(),entry,provider:provider(),market:market(),include:"detections"});
 const res=await fetch("/api/analysis/confluence?"+params.toString(),{cache:"no-store",signal:AbortSignal.timeout(20000)});if(!res.ok)throw new Error("Confluence API HTTP "+res.status);
 const d=await res.json();if(seq!==sequence)return;if(!d||typeof d.score!=="number")throw new Error(d?.detail||d?.error||"Invalid confluence response");
 const stance=d.stance||"neutral";text("eti-smci-stance",stance.toUpperCase());const se=$("eti-smci-stance");if(se)se.className=cls(stance);
 text("eti-smci-score",d.score.toFixed(1)+" / 100");text("eti-smci-coverage",Math.round((d.coverage||0)*100)+"% · "+(d.usedTimeframes||[]).length+" TF");
 text("eti-smci-entry-state",d.entry?.confirmed===true?"Aligned":d.entry?.confirmed===false?"Not aligned":"Unconfirmed");
 const meter=$("eti-smci-meter");if(meter)meter.style.width=Math.max(0,Math.min(100,(d.score+100)/2))+"%";
 list("eti-smci-evidence",(d.evidence||[]).filter(x=>x.points!==0).sort((a,b)=>Math.abs(b.points)-Math.abs(a.points)).slice(0,8).map(x=>[x.label+" · "+(x.timeframe||"aggregate"),(x.points>0?"+":"")+x.points.toFixed(1)+" pts · "+x.direction]),"No directional evidence");
 list("eti-smci-targets",(d.liquidityTargets||[]).slice(0,6).map(x=>[x.side.replace("_"," ").toUpperCase()+" · "+x.timeframe,Number(x.price).toPrecision(8)+" · "+x.distancePct+"%"]),"No nearby open liquidity targets reported");
 list("eti-smci-overlaps",(d.overlaps||[]).slice(0,5).map(x=>[x.direction.toUpperCase()+" overlap",Number(x.low).toPrecision(8)+" – "+Number(x.high).toPrecision(8)+" · "+x.members.map(m=>m.timeframe+" "+m.kind).join(" / ")]),"No cross-timeframe zone overlap");
 const c=$("eti-smci-conflicts");if(c){c.replaceChildren();if(d.conflicts?.length){const w=document.createElement("div");w.className="eti-smci-conflict";w.textContent="STRUCTURE CONFLICT · "+d.conflicts.join(" | ");c.append(w);}if(d.status==="insufficient"){const w=document.createElement("div");w.className="eti-smci-conflict";w.textContent="Insufficient or stale timeframe coverage. Treat the score as incomplete.";c.append(w);}}
 text("eti-smci-state",d.status==="ready"?"Updated "+new Date(d.asOf||Date.now()).toLocaleTimeString()+" · "+(d.staleTimeframes?.length||0)+" stale TF":"Analysis incomplete");
 }catch(e){if(seq===sequence)text("eti-smci-state","Unavailable · "+(e&&e.message||"analysis error")+" · existing chart data remains active");}
 finally{if(seq===sequence){busy=false;if(btn)btn.disabled=false;}}
}
function mount(){
 const terminal=$("tt-chart"),canvas=$("chart"),stack=$("stack"),pro=$("p-struct");
 let anchor=terminal||canvas||stack||pro;if(!anchor)return;
 if(terminal){const card=terminal.closest(".tt-chart-card")||terminal.parentElement;if(card&&card.parentElement)card.insertAdjacentElement("afterend",root);else terminal.insertAdjacentElement("afterend",root);}
 else if(canvas){const parent=canvas.parentElement||canvas;if(stack&&stack.parentElement===parent)stack.insertAdjacentElement("afterend",root);else parent.insertAdjacentElement("afterend",root);}
 else if(stack)stack.insertAdjacentElement("afterend",root);else if(pro)pro.insertAdjacentElement("afterend",root);
}
mount();$("eti-smci-refresh")?.addEventListener("click",refresh);$("eti-smci-entry")?.addEventListener("change",refresh);
["symbol","tt-symbol","interval","tt-interval","symVenue","symMarket","tt-venue","tt-market","sym","ven","mkt"].forEach(id=>$(id)?.addEventListener("change",refresh));
refresh();setInterval(refresh,60000);
}catch(e){if(window.console)console.warn("ETI SMC Intelligence mount failed",e&&e.message);}
})();
</script>`;