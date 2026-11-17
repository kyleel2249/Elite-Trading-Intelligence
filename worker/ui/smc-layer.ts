/** Live-chart Smart Money Concepts overlay. Uses the same read-only SMC engine as ETI analysis. */
export const SMC_LAYER_CSS = `<style id="eti-smc-css">
.eti-smc-bar{display:flex;gap:7px 12px;align-items:center;flex-wrap:wrap;margin:0 0 8px;padding:8px 10px;border:1px solid #2a3b54;border-radius:9px;background:rgba(7,16,29,.92);font-size:11px;color:#b7c8dc}
.eti-smc-bar label{display:inline-flex;align-items:center;gap:5px;min-height:24px;cursor:pointer}
.eti-smc-bar input{width:auto;margin:0;accent-color:#56a8ff}
.eti-smc-bar output{font-variant-numeric:tabular-nums;color:#eaf2ff}
.eti-smc-bar .smc-error{color:#ffb18f}
@media(max-width:700px){.eti-smc-bar{gap:6px;padding:7px}.eti-smc-bar label{min-height:32px}}
</style>`;
export const SMC_LAYER_JS = String.raw`<script id="eti-smc-js">
(function(){
"use strict";
try{
if(typeof drawChart!=="function"||typeof candles==="undefined"||typeof chartScale==="undefined"||typeof getJson!=="function"||!document.getElementById("chart")||!document.getElementById("stack"))return;
var cv=document.getElementById("chart"),stack=document.getElementById("stack"),state={blocks:true,mitigated:false,pools:true,events:true,sweeps:true},data=null,busy=false,key="",lastAt=0,error="",FUT=typeof FUTURE==="number"?FUTURE:14;
var bar=document.createElement("div");bar.className="eti-smc-bar";bar.setAttribute("role","group");bar.setAttribute("aria-label","Smart Money Concepts chart overlays");
bar.innerHTML='<label><input type="checkbox" data-smc="blocks" checked> Order blocks</label><label><input type="checkbox" data-smc="mitigated"> Show mitigated OBs</label><label><input type="checkbox" data-smc="pools" checked> Liquidity pools</label><label><input type="checkbox" data-smc="events" checked> BOS / CHoCH</label><label><input type="checkbox" data-smc="sweeps" checked> Liquidity sweeps</label><output id="etiSmcStatus" aria-live="polite">Loading SMC…</output><span class="smc-error" id="etiSmcError"></span>';
stack.parentNode.insertBefore(bar,stack);
function el(id){return bar.querySelector("#"+id);}
function tf(){var e=document.getElementById("interval");return e?e.value:"1h";}
function marketKey(){var s=document.getElementById("symbol");return (s?s.value:"")+"|"+tf()+"|"+(typeof mkt==="function"?mkt():"");}
function slot(t){var lo=0,hi=candles.length;while(lo<hi){var mid=(lo+hi)>>1;if(Number(candles[mid][0])<Number(t))lo=mid+1;else hi=mid;}if(lo<candles.length&&Number(candles[lo][0])===Number(t))return lo;return Math.max(0,Math.min(candles.length-1,lo-1));}
function renderStatus(){
 var out=el("etiSmcStatus"),err=el("etiSmcError");
 if(out)out.textContent=!data?"SMC unavailable":data.status!=="ready"?(data.reason||"Waiting for closed candles"):(data.structure.trend.toUpperCase()+" · "+data.orderBlocks.length+" OB · "+data.liquidityPools.length+" pools · "+data.liquiditySweeps.length+" sweeps");
 if(err)err.textContent=error?" · "+error:"";
}
async function load(force){
 var k=marketKey(),now=Date.now();if(busy||(!force&&k===key&&now-lastAt<60000))return;
 if(k!==key)data=null;
 key=k;lastAt=now;busy=true;error="";renderStatus();
 try{
  var sym=(document.getElementById("symbol")||{}).value||"BTCUSDT";
  var url="/api/analysis/smc?symbol="+encodeURIComponent(sym)+"&timeframe="+encodeURIComponent(tf())+(typeof mkt==="function"?mkt():"");
  var response=await getJson(url),next=response&&response.data;if(!next||!next.status)throw new Error("Invalid SMC response");
  data=next;
 }catch(e){error=e&&e.message?e.message:"SMC request failed";}
 finally{busy=false;renderStatus();try{drawChart();}catch(_){try{paint();}catch(__){}}}
}
function paint(){
 if(!data||data.status!=="ready"||!candles.length)return;
 var s=chartScale,ctx=cv.getContext("2d");if(!s||!ctx||!(s.hi>s.lo)||!s.plotW)return;
 var step=s.plotW/(candles.length+FUT),top=s.top,bot=s.bot;
 function py(v){return bot-(v-s.lo)/(s.hi-s.lo)*(bot-top);}
 function px(t){return slot(t)*step;}
 ctx.save();ctx.beginPath();ctx.rect(0,top,s.plotW,bot-top);ctx.clip();
 if(state.blocks&&Array.isArray(data.orderBlocks)){
  var blocks=data.orderBlocks.filter(function(o){return !o.invalidated&&(state.mitigated||!o.mitigated);});
  ctx.globalCompositeOperation="destination-over";
  blocks.forEach(function(o){
   var x0=px(o.time),y1=py(o.high),y2=py(o.low),y=Math.min(y1,y2),h=Math.max(1,Math.abs(y2-y1));
   if(y+h<top||y>bot||x0>s.plotW)return;
   var col=o.kind==="bullish"?"33,214,154":"255,99,125";
   ctx.fillStyle="rgba("+col+","+(o.mitigated?".055":".13")+")";ctx.fillRect(x0,y,s.plotW-x0,h);
   ctx.strokeStyle="rgba("+col+","+(o.mitigated?".35":".85")+")";ctx.lineWidth=1.2;ctx.setLineDash(o.mitigated?[2,4]:[5,3]);ctx.strokeRect(x0+.5,y+.5,Math.max(1,s.plotW-x0-1),Math.max(1,h-1));ctx.setLineDash([]);
  });
  ctx.globalCompositeOperation="source-over";
  ctx.font="bold 10px system-ui,sans-serif";ctx.textAlign="left";ctx.textBaseline="top";
  blocks.slice(-7).forEach(function(o){
   var x=Math.max(3,px(o.time)+4),y=py(o.high)+3;if(y>=top&&y<=bot) {ctx.fillStyle=o.kind==="bullish"?"#21d69a":"#ff637d";ctx.fillText((o.kind==="bullish"?"BULLISH":"BEARISH")+" ORDER BLOCK · "+(o.mitigated?"MITIGATED":"FRESH")+" · 50% "+Number(o.mean).toPrecision(7)+" · "+o.touches+" touches",x,y);}
  });
 }
 if(state.pools&&Array.isArray(data.liquidityPools)){
  ctx.save();ctx.font="10px system-ui,sans-serif";ctx.textAlign="right";
  data.liquidityPools.slice().sort(function(a,b){return Math.abs(a.price-data.currentPrice)-Math.abs(b.price-data.currentPrice);}).slice(0,8).forEach(function(p){
   var y=py(p.price);if(y<top||y>bot)return;
   var buy=p.side==="buy_side";ctx.strokeStyle=buy?"rgba(255,99,125,.65)":"rgba(86,168,255,.7)";ctx.fillStyle=buy?"#ff9baa":"#83bdff";ctx.lineWidth=1;ctx.setLineDash([2,5]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(s.plotW,y);ctx.stroke();ctx.setLineDash([]);
   ctx.fillText((buy?"BUY-SIDE":"SELL-SIDE")+" LIQUIDITY · "+p.touches+" touches · "+Number(p.price).toPrecision(7),s.plotW-5,Math.max(top+10,Math.min(bot-3,y-4)));
  });ctx.restore();
 }
 if(state.events&&data.structure&&Array.isArray(data.structure.events)){
  ctx.font="bold 10px system-ui,sans-serif";ctx.textAlign="left";ctx.textBaseline="middle";
  data.structure.events.slice(-8).forEach(function(e){
   var x=px(e.time),y=py(e.level);if(x<0||x>s.plotW||y<top||y>bot)return;
   var bull=e.direction==="bullish";ctx.fillStyle=bull?"#21d69a":"#ff637d";ctx.strokeStyle=ctx.fillStyle;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(s.plotW,y);ctx.stroke();ctx.setLineDash([]);
   ctx.fillText(e.type+" "+(bull?"↑":"↓")+" "+Number(e.level).toPrecision(7),Math.min(s.plotW-120,x+4),Math.max(top+8,Math.min(bot-8,y+(bull?-9:9))));
  });
 }
 if(state.sweeps&&Array.isArray(data.liquiditySweeps)){
  ctx.font="bold 10px system-ui,sans-serif";ctx.textAlign="left";ctx.textBaseline="bottom";
  data.liquiditySweeps.slice(-8).forEach(function(w){
   var x=px(w.time),y=py(w.level);if(x<0||x>s.plotW||y<top||y>bot)return;
   ctx.fillStyle="#f5bd62";ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();
   ctx.fillText((w.side==="buy_side"?"BUY-SIDE":"SELL-SIDE")+" SWEEP",Math.min(s.plotW-95,x+6),Math.max(top+10,Math.min(bot-3,y-6)));
  });
 }
 ctx.restore();
}
bar.addEventListener("change",function(e){var k=e.target&&e.target.getAttribute("data-smc");if(!k)return;state[k]=!!e.target.checked;try{drawChart();}catch(_){}});
["symbol","interval","symMarket"].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener("change",function(){key="";load(true);});});
var original=drawChart;drawChart=function(){var r=original.apply(this,arguments);try{paint();}catch(_){}load(false);return r;};
if(typeof window!=="undefined")window.etiSmc={state:function(){return {status:data&&data.status,trend:data&&data.structure&&data.structure.trend,error:error};},refresh:function(){return load(true);}};
load(true);setInterval(function(){load(false);},60000);
}catch(e){if(window.console)console.warn("ETI SMC overlay unavailable",e&&e.message);}
})();
</script>`;
export function withSmcLayer(page: string): string {
  if (!page.includes('id="stack"') || !page.includes('id="chart"') || !page.includes("function drawChart")) return page;
  return page.replace("</head>", SMC_LAYER_CSS + "</head>").replace("</body>", SMC_LAYER_JS + "</body>");
}
