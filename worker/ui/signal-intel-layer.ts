/** Live-chart signal intelligence: Ichimoku cloud, Supertrend, Fibonacci, non-repainting BUY/SELL markers, plan levels, estimated liquidation zones and an explanatory dashboard panel.
 *  Visual and read-only: it fetches /api/analysis/signal-intel and never submits an order. */
export const SIGNAL_INTEL_CSS = `<style id="eti-sig-css">
.eti-sig-bar{display:flex;gap:7px 12px;align-items:center;flex-wrap:wrap;margin:0 0 8px;padding:8px 10px;border:1px solid #2a3b54;border-radius:9px;background:rgba(7,16,29,.94);font-size:11px;color:#b7c8dc}
.eti-sig-bar label{display:inline-flex;align-items:center;gap:5px;min-height:24px;cursor:pointer}
.eti-sig-bar input{width:auto;margin:0;accent-color:#56a8ff}
.eti-sig-bar output{font-variant-numeric:tabular-nums;color:#eaf2ff}
.eti-sig-bar .sig-error{color:#ffb18f}
.eti-sig-panel{margin:14px 0;padding:14px;border:1px solid #2a3b54;border-radius:12px;background:rgba(7,16,29,.94);color:#cfdcec;font-size:12px;line-height:1.5}
.eti-sig-panel h3{margin:0 0 8px;font-size:14px;color:#eaf2ff}
.eti-sig-panel h4{margin:12px 0 5px;font-size:12px;color:#8fc5ff;text-transform:uppercase;letter-spacing:.05em}
.eti-sig-head{display:flex;gap:10px 16px;align-items:center;flex-wrap:wrap}
.eti-sig-pill{display:inline-block;padding:3px 11px;border-radius:999px;font-weight:800;font-size:13px}
.eti-sig-buy{background:rgba(33,214,154,.18);color:#21d69a}.eti-sig-sell{background:rgba(255,99,125,.18);color:#ff8fa1}.eti-sig-wait{background:rgba(145,167,193,.18);color:#c3d2e4}
.eti-sig-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.eti-sig-panel table{width:100%;border-collapse:collapse}.eti-sig-panel td,.eti-sig-panel th{padding:3px 6px;border-bottom:1px solid #1d2c42;text-align:left;vertical-align:top}
.eti-sig-up{color:#21d69a}.eti-sig-down{color:#ff8fa1}.eti-sig-mut{color:#91a7c1}
.eti-sig-note{margin-top:10px;color:#91a7c1;font-size:11px}
@media(max-width:700px){.eti-sig-bar{gap:6px;padding:7px}.eti-sig-bar label{min-height:32px}.eti-sig-panel{padding:10px}}
</style>`;
export const SIGNAL_INTEL_JS = String.raw`<script id="eti-sig-js">
(function(){
"use strict";
try{
if(typeof drawChart!=="function"||typeof candles==="undefined"||typeof chartScale==="undefined"||typeof getJson!=="function"||!document.getElementById("chart")||!document.getElementById("stack"))return;
var cv=document.getElementById("chart"),stack=document.getElementById("stack"),state={signals:true,ichimoku:true,supertrend:true,fib:false,plan:true,liquidation:false},data=null,busy=false,key="",lastAt=0,error="",FUT=typeof FUTURE==="number"?FUTURE:14;
var bar=document.createElement("div");bar.className="eti-sig-bar";bar.setAttribute("role","group");bar.setAttribute("aria-label","Signal intelligence chart overlays");
bar.innerHTML='<strong>Signal Intelligence</strong><label><input type="checkbox" data-sig="signals" checked> BUY / SELL</label><label><input type="checkbox" data-sig="ichimoku" checked> Ichimoku</label><label><input type="checkbox" data-sig="supertrend" checked> Supertrend</label><label><input type="checkbox" data-sig="fib"> Fibonacci</label><label><input type="checkbox" data-sig="plan" checked> Entry / SL / TP</label><label><input type="checkbox" data-sig="liquidation"> Est. liquidation zones</label><output id="etiSigStatus" aria-live="polite">Loading signal intelligence…</output><span class="sig-error" id="etiSigError"></span>';
stack.parentNode.insertBefore(bar,stack);
var panel=document.createElement("section");panel.className="eti-sig-panel";panel.id="etiSignalPanel";panel.setAttribute("aria-live","polite");panel.textContent="Loading signal intelligence…";
var anchor=document.getElementById("institutionalPanel");if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(panel,anchor.nextSibling);else stack.parentNode.insertBefore(panel,stack.nextSibling);
function el(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];});}
function tf(){var e=el("interval");return e?e.value:"1h";}
function marketKey(){var s=el("symbol");return (s?s.value:"")+"|"+tf()+"|"+(typeof mkt==="function"?mkt():"");}
function num(v,d){return typeof v==="number"&&isFinite(v)?v.toFixed(d==null?2:d):"n/a";}
function dtMs(){var n=candles.length;return n>1?Number(candles[n-1][0])-Number(candles[n-2][0]):3600000;}
function slot(t){var n=candles.length,lo=0,hi=n;while(lo<hi){var mid=(lo+hi)>>1;if(Number(candles[mid][0])<Number(t))lo=mid+1;else hi=mid;}if(lo<n&&Number(candles[lo][0])===Number(t))return lo;if(lo>=n){var extra=Math.round((Number(t)-Number(candles[n-1][0]))/dtMs());return extra>0?n-1+extra:n-1;}return Math.max(0,lo-1);}
function renderStatus(){var o=el("etiSigStatus"),e=el("etiSigError");if(o)o.textContent=!data?"unavailable":data.status==="insufficient_history"?(data.reason||"Waiting for history"):(data.action+" · score "+num(data.score,0)+" · confidence "+data.confidence+" · "+data.regime.named.replace(/_/g," "));if(e)e.textContent=error?" · "+error:"";}
function renderPanel(){
if(!data){panel.textContent=error?"Signal intelligence unavailable: "+error:"Loading signal intelligence…";return;}
if(data.status==="insufficient_history"){panel.innerHTML="<h3>Signal Intelligence</h3><p>"+esc(data.reason)+"</p>";return;}
var cls=data.action==="BUY"?"eti-sig-buy":data.action==="SELL"?"eti-sig-sell":"eti-sig-wait",h="";
h+='<div class="eti-sig-head"><h3>Signal Intelligence · '+esc(data.symbol)+" "+esc(data.timeframe)+'</h3><span class="eti-sig-pill '+cls+'">'+esc(data.action)+'</span><span>Score <b>'+num(data.score,0)+'</b></span><span>Confidence <b>'+data.confidence+'</b>/100</span><span class="eti-sig-mut">'+esc(data.status)+"</span></div>";
h+="<p>"+esc(data.headline)+"</p>";
h+='<div class="eti-sig-grid"><div><h4>Regime</h4><div>'+esc(data.regime.named.replace(/_/g," "))+" · ADX "+num(data.regime.adx,1)+" · reading as "+esc(data.regime.mode)+'</div><div class="eti-sig-mut">'+esc((data.regime.reasons||[]).slice(0,2).join("; "))+"</div>";
h+="<h4>Multi-timeframe</h4><table>"+(data.mtf.timeframes.length?data.mtf.timeframes.map(function(t){return "<tr><td>"+esc(t.timeframe)+'</td><td class="'+(t.direction>0?"eti-sig-up":t.direction<0?"eti-sig-down":"eti-sig-mut")+'">'+(t.direction>0?"bullish":t.direction<0?"bearish":"neutral")+"</td><td>"+num(t.score,0)+"</td></tr>";}).join(""):'<tr><td class="eti-sig-mut">No other timeframes loaded</td></tr>')+"</table>";
h+='<div class="eti-sig-mut">Alignment '+(data.mtf.alignment==null?"n/a":Math.round(data.mtf.alignment*100)+"%")+"</div></div>";
h+="<div><h4>Evidence ("+data.fusion.votesAgree+"/"+data.fusion.votesTotal+" agree)</h4><table>"+data.votes.slice(0,12).map(function(v){return '<tr><td class="'+(v.direction>0?"eti-sig-up":v.direction<0?"eti-sig-down":"eti-sig-mut")+'">'+(v.direction>0?"▲":v.direction<0?"▼":"•")+"</td><td><b>"+esc(v.label)+'</b><div class="eti-sig-mut">'+esc(v.detail)+"</div></td></tr>";}).join("")+"</table></div>";
h+="<div><h4>Filters</h4><table>"+data.filters.map(function(f){return "<tr><td>"+(f.pass?'<span class="eti-sig-up">✓</span>':'<span class="eti-sig-down">'+(f.severity==="block"?"✗":"!")+"</span>")+"</td><td>"+esc(f.id.replace(/_/g," "))+'<div class="eti-sig-mut">'+esc(f.detail)+"</div></td></tr>";}).join("")+"</table></div>";
var p=data.plan,v=data.validation;
h+="<div><h4>Trade plan</h4>"+(p?"<table><tr><td>Entry</td><td>"+num(p.entry,4)+"</td></tr><tr><td>Stop</td><td>"+num(p.stop,4)+"</td></tr>"+p.targets.map(function(t,i){return "<tr><td>TP"+(i+1)+"</td><td>"+num(t.price,4)+' <span class="eti-sig-mut">R:R '+num(t.rewardRisk,2)+"</span></td></tr>";}).join("")+"<tr><td>Suggested risk</td><td>"+num(p.suggestedRiskPct,2)+'% of equity</td></tr></table><div class="eti-sig-mut">'+(p.actionable?"Plan passes every blocking filter.":"Shown for reference only: filters block this setup.")+"</div>":'<div class="eti-sig-mut">No directional setup.</div>');
h+="<h4>Walk-forward validation</h4>"+(v.n?"<div>"+v.wins+" wins / "+v.losses+" losses / "+v.expired+" expired over "+v.n+" signals ("+num(v.winRate*100,1)+"%"+(v.ci95?", 95% CI "+num(v.ci95.low*100,0)+"–"+num(v.ci95.high*100,0)+"%":"")+"), expectancy "+num(v.expectancyR,2)+"R after "+v.costBps+" bps costs.</div>":"")+'<div class="eti-sig-mut">'+esc(v.note)+"</div></div></div>";
var d=data.derivatives,o=data.orderflow,bits=[];
if(d&&d.openInterest&&d.openInterest.regime&&d.openInterest.regime!=="unknown")bits.push("Open interest: "+esc(String(d.openInterest.regime).replace(/_/g," "))+(d.openInterest.reading?" ("+esc(d.openInterest.reading)+")":""));
if(d&&d.funding&&d.funding.status==="available"&&d.funding.notes&&d.funding.notes.length)bits.push("Funding: "+esc(d.funding.notes.join("; ")));
if(o&&o.trades)bits.push("Tape delta "+num(o.deltaPct,1)+"% · book imbalance "+num(o.depthImbalance*100,1)+"% · spread "+num(o.spreadBps,1)+" bps");
h+='<div class="eti-sig-note">'+(bits.length?bits.join(" · ")+"<br>":"")+(d?esc(d.liquidationNote):"")+"<br>Confidence reflects evidence quality capped by walk-forward validation. It is not a probability of profit. Read-only: this panel never places an order. Markers use closed candles only and do not repaint.</div>";
var q=data.dataQuality;if(q&&q.failures&&Object.keys(q.failures).length)h+='<div class="eti-sig-note">Data gaps: '+esc(Object.keys(q.failures).map(function(k){return k+": "+q.failures[k];}).join("; "))+"</div>";
panel.innerHTML=h;}
async function load(force){var k=marketKey(),now=Date.now();if(busy||(!force&&k===key&&now-lastAt<60000))return;if(k!==key)data=null;key=k;lastAt=now;busy=true;error="";renderStatus();try{var sym=(el("symbol")||{}).value||"BTCUSDT",url="/api/analysis/signal-intel?symbol="+encodeURIComponent(sym)+"&timeframe="+encodeURIComponent(tf())+(typeof mkt==="function"?mkt():""),response=await getJson(url),next=response&&response.data;if(!next||!next.schema)throw new Error("Invalid signal response");data=next;}catch(e){error=e&&e.message?e.message:"request failed";}finally{busy=false;renderStatus();renderPanel();try{drawChart();}catch(_){}}}
function paint(){if(!data||data.status==="insufficient_history"||!data.chart||!candles.length)return;var s=chartScale,ctx=cv.getContext("2d");if(!s||!ctx||!(s.hi>s.lo)||!s.plotW)return;var step=s.plotW/(candles.length+FUT),top=s.top,bot=s.bot,c=data.chart;
function py(v){return bot-(v-s.lo)/(s.hi-s.lo)*(bot-top);}function px(t){return (slot(t)+.5)*step;}
ctx.save();ctx.beginPath();ctx.rect(0,top,s.plotW,bot-top);ctx.clip();
function line(pts,color,w,dash){ctx.strokeStyle=color;ctx.lineWidth=w;ctx.setLineDash(dash||[]);ctx.beginPath();var on=false;pts.forEach(function(p){if(p[1]==null){on=false;return;}var x=px(p[0]),y=py(p[1]);if(!on){ctx.moveTo(x,y);on=true;}else ctx.lineTo(x,y);});ctx.stroke();ctx.setLineDash([]);}
if(state.ichimoku&&c.ichimoku){var cloud=c.ichimoku.cloud.concat(c.ichimoku.future||[]);for(var i=1;i<cloud.length;i++){var a=cloud[i-1],b=cloud[i];if(a.a==null||a.b==null||b.a==null||b.b==null)continue;var bull=(a.a+b.a)>=(a.b+b.b);ctx.fillStyle=bull?"rgba(33,214,154,.13)":"rgba(255,99,125,.13)";ctx.beginPath();ctx.moveTo(px(a.t),py(a.a));ctx.lineTo(px(b.t),py(b.a));ctx.lineTo(px(b.t),py(b.b));ctx.lineTo(px(a.t),py(a.b));ctx.closePath();ctx.fill();}
line(cloud.map(function(p){return [p.t,p.a];}),"rgba(33,214,154,.55)",1,[]);line(cloud.map(function(p){return [p.t,p.b];}),"rgba(255,99,125,.55)",1,[]);line(c.ichimoku.tenkan,"#56a8ff",1.2);line(c.ichimoku.kijun,"#f5bd62",1.2);}
if(state.supertrend&&c.supertrend){var seg=[],cur=null;c.supertrend.forEach(function(p){if(p.v==null||p.dir===0){cur=null;return;}if(!cur||cur.dir!==p.dir){cur={dir:p.dir,pts:[]};seg.push(cur);}cur.pts.push([p.t,p.v]);});seg.forEach(function(g){line(g.pts,g.dir>0?"#21d69a":"#ff637d",1.8);});}
if(state.fib&&c.fibonacci){ctx.font="10px system-ui,sans-serif";ctx.textAlign="left";c.fibonacci.levels.forEach(function(l){var y=py(l.price);if(l.price==null||y<top||y>bot)return;ctx.strokeStyle="rgba(213,168,255,.65)";ctx.fillStyle="#d5a8ff";ctx.lineWidth=1;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(s.plotW,y);ctx.stroke();ctx.setLineDash([]);ctx.fillText("FIB "+l.ratio+" · "+Number(l.price).toPrecision(7),5,Math.max(top+10,y-3));});}
if(state.liquidation&&data.derivatives&&Array.isArray(data.derivatives.liquidationZones)){ctx.font="10px system-ui,sans-serif";ctx.textAlign="right";data.derivatives.liquidationZones.slice(0,8).forEach(function(z){var y=py(z.price);if(y<top||y>bot)return;var longs=z.side==="long_liquidations";ctx.strokeStyle=longs?"rgba(255,99,125,"+(0.25+0.5*z.strength)+")":"rgba(33,214,154,"+(0.25+0.5*z.strength)+")";ctx.fillStyle=longs?"#ff9baa":"#7ee8c3";ctx.lineWidth=1+2*z.strength;ctx.setLineDash([1,4]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(s.plotW,y);ctx.stroke();ctx.setLineDash([]);ctx.fillText("EST. "+(longs?"LONG":"SHORT")+" LIQ "+(z.leverages||[]).join("/")+"x · "+Number(z.price).toPrecision(7),s.plotW-5,Math.max(top+10,y-3));});}
if(state.plan&&data.plan){var p=data.plan,rows=[["ENTRY",p.entry,"#eaf2ff"],["SL",p.stop,"#ff637d"]].concat(p.targets.map(function(t,i){return ["TP"+(i+1),t.price,"#21d69a"];}));ctx.font="bold 10px system-ui,sans-serif";ctx.textAlign="right";rows.forEach(function(r){var y=py(r[1]);if(y<top||y>bot)return;ctx.strokeStyle=r[2];ctx.fillStyle=r[2];ctx.lineWidth=1.2;ctx.setLineDash(r[0]==="ENTRY"?[]:[6,3]);ctx.globalAlpha=p.actionable?1:.55;ctx.beginPath();ctx.moveTo(Math.max(0,s.plotW*0.62),y);ctx.lineTo(s.plotW,y);ctx.stroke();ctx.setLineDash([]);ctx.fillText(r[0]+" "+Number(r[1]).toPrecision(7)+(p.actionable?"":" (blocked)"),s.plotW-5,Math.max(top+10,Math.min(bot-3,y-4)));ctx.globalAlpha=1;});}
if(state.signals&&c.markers){ctx.font="bold 10px system-ui,sans-serif";ctx.textAlign="center";c.markers.forEach(function(m){var x=px(m.t),y=py(m.price);if(x<0||x>s.plotW||y<top||y>bot)return;var buy=m.dir>0,dy=buy?14:-14;ctx.fillStyle=buy?"#21d69a":"#ff637d";ctx.beginPath();ctx.moveTo(x,y+(buy?7:-7));ctx.lineTo(x-5,y+(buy?15:-15));ctx.lineTo(x+5,y+(buy?15:-15));ctx.closePath();ctx.fill();ctx.fillText(m.label,x,y+(buy?27:-20));});}
ctx.restore();}
bar.addEventListener("change",function(e){var k=e.target&&e.target.getAttribute("data-sig");if(!k)return;state[k]=!!e.target.checked;try{drawChart();}catch(_){}});
["symbol","interval","symMarket"].forEach(function(id){var e=el(id);if(e)e.addEventListener("change",function(){key="";load(true);});});
var original=drawChart;drawChart=function(){var r=original.apply(this,arguments);try{paint();}catch(_){}load(false);return r;};
if(typeof window!=="undefined")window.etiSignalIntel={state:function(){return {status:data&&data.status,action:data&&data.action,error:error,layers:state};},refresh:function(){return load(true);}};
load(true);setInterval(function(){load(false);},60000);
}catch(e){if(window.console)console.warn("ETI signal intelligence unavailable",e&&e.message);}
})();
</script>`;
export function withSignalIntelLayer(page: string): string {
  if (!page.includes('id="stack"') || !page.includes('id="chart"') || !page.includes("function drawChart")) return page;
  return page.replace("</head>", SIGNAL_INTEL_CSS + "</head>").replace("</body>", SIGNAL_INTEL_JS + "</body>");
}
