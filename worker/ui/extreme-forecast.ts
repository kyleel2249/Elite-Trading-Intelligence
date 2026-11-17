export const EXTREME_FORECAST_CSS = `<style id="eti-extreme-forecast-css">
.eti-extreme-forecast{margin:8px 0 10px;padding:12px 14px;border:1px solid rgba(80,150,210,.35);border-radius:10px;background:rgba(9,22,39,.88);color:#e8f1fb;font:12px/1.5 system-ui,sans-serif}
.eti-extreme-forecast .ef-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.eti-extreme-forecast .ef-title{font-size:13px;font-weight:750;letter-spacing:.02em}
.eti-extreme-forecast .ef-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;color:#b8c9dc}
.eti-extreme-forecast button{border:1px solid #47627f;background:#152a43;color:#eaf4ff;border-radius:6px;padding:4px 9px;cursor:pointer}
.eti-extreme-forecast label{display:inline-flex;align-items:center;gap:5px}
.eti-extreme-forecast .ef-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.eti-extreme-forecast .ef-card{min-width:0;padding:9px 10px;border-radius:7px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08)}
.eti-extreme-forecast .ef-label{color:#9fb4cc;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.eti-extreme-forecast .ef-value{font-size:16px;font-weight:750;overflow-wrap:anywhere}
.eti-extreme-forecast .ef-sub{color:#b6c7da;font-size:11px}
.eti-extreme-forecast .ef-high{color:#ff8b9b}.eti-extreme-forecast .ef-low{color:#4edbb4}
.eti-extreme-forecast .ef-note{margin-top:8px;color:#9eb2c9;font-size:10px}
.eti-extreme-forecast .ef-error{color:#ffb18f}
@media(max-width:720px){.eti-extreme-forecast .ef-grid{grid-template-columns:1fr}.eti-extreme-forecast .ef-value{font-size:15px}}
</style>`;

export const EXTREME_FORECAST_JS = `<script id="eti-extreme-forecast-js">
(function(){
'use strict';
var cv=document.getElementById('chart'),stack=document.getElementById('stack');
if(!cv||!stack||typeof drawChart!=='function'||typeof getJson!=='function')return;
var panel=document.createElement('section');
panel.className='eti-extreme-forecast';
panel.setAttribute('role','region');
panel.setAttribute('aria-label','Bybit next 24-hour high and low forecast');
panel.innerHTML='<div class="ef-head"><div class="ef-title">24H HIGH / LOW PATTERN FORECAST <span style="color:#8fb8df">· BYBIT</span></div><div class="ef-controls"><label><input id="efVisible" type="checkbox" checked> Chart levels</label><button id="efRefresh" type="button">Refresh forecast</button><span id="efUpdated" class="ef-sub">Waiting for market data…</span></div></div><div id="efBody" class="ef-grid"><div class="ef-card">Loading historical high/low patterns…</div></div><div class="ef-note" id="efNote">Statistical estimate, not a trade signal or guaranteed price. Historical hit rates are not forward probabilities.</div>';
stack.parentNode.insertBefore(panel,stack);
var visible=true,data=null,busy=false,lastKey='',lastAt=0,error='',orig=drawChart;
function el(id){return panel.querySelector('#'+id);}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function money(v){var n=Number(v);return Number.isFinite(n)?n.toLocaleString(undefined,{maximumFractionDigits:n>=100?4:8}):'—';}
function utc(v){var d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString(undefined,{timeZone:'UTC',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})+' UTC':'—';}
function key(){return (document.getElementById('symbol')||{}).value+'|'+(typeof mkt==='function'?mkt():'');}
function render(){
 var body=el('efBody'),stamp=el('efUpdated');
 if(!data||data.status!=='ready'||!data.forecast){
  body.innerHTML='<div class="ef-card ef-error">'+esc(error||data&&data.reason||'Forecast is not available yet. No values are fabricated.')+'</div>';
  var note=el('efNote'),b=data.backtest||{},m=data.marketContext||{},parts=[];
  if(b.status==='ready')parts.push('Rolling 24H backtest · '+b.sampleCount+' completed windows: high level hit '+b.highPriceHitRatePct+'%, low level hit '+b.lowPriceHitRatePct+'%, high timing hit '+b.highTimeWindowHitRatePct+'%, low timing hit '+b.lowTimeWindowHitRatePct+'%.');
  else parts.push('Rolling 24H backtest: '+(b.reason||'not enough completed windows yet')+'.');
  if(m.trend)parts.push('Market context: '+m.trend+' · 24H momentum '+(m.momentum24hPct==null?'—':m.momentum24hPct+'%')+' · 7D momentum '+(m.momentum7dPct==null?'—':m.momentum7dPct+'%')+' · ATR '+(m.atr14Pct==null?'—':m.atr14Pct+'%')+' · volatility '+m.volatilityRegime+' · volume ratio '+(m.volumeVs20DayAverage==null?'—':m.volumeVs20DayAverage+'×')+'.');
  parts.push('Historical hit rates are not probabilities for the next 24 hours. Statistical estimate, not a trade signal or guaranteed price; timing windows are approximate to ±60 minutes.');
  if(note)note.textContent=parts.join(' ');
  stamp.textContent=error?'Last update failed':'History check';
  return;
 }
 var f=data.forecast,o=data.observed,h=f.high,l=f.low,c=f.confidence;
 body.innerHTML=
 '<div class="ef-card"><div class="ef-label ef-high">Estimated next 24H high</div><div class="ef-value ef-high">'+money(h.price)+'</div><div class="ef-sub">Expected: '+utc(h.time.expectedAt)+'</div><div class="ef-sub">Timing window: '+utc(h.time.windowStart)+' – '+utc(h.time.windowEnd)+'</div><div class="ef-sub">Historical range: '+money(h.range.low)+' – '+money(h.range.high)+' ('+h.excursionPct+'% median rise)</div></div>'+
 '<div class="ef-card"><div class="ef-label ef-low">Estimated next 24H low</div><div class="ef-value ef-low">'+money(l.price)+'</div><div class="ef-sub">Expected: '+utc(l.time.expectedAt)+'</div><div class="ef-sub">Timing window: '+utc(l.time.windowStart)+' – '+utc(l.time.windowEnd)+'</div><div class="ef-sub">Historical range: '+money(l.range.low)+' – '+money(l.range.high)+' ('+l.excursionPct+'% median fall)</div></div>'+
 '<div class="ef-card"><div class="ef-label">Pattern consistency</div><div class="ef-value">'+c.score+'/100</div><div class="ef-sub">'+esc(c.label)+'</div><div class="ef-sub">Completed days: '+esc(data.history.timeSampleDays)+' hourly / '+esc(data.history.priceSampleDays)+' daily</div><div class="ef-sub">Observed current 24H: H '+money(o.high24h)+' · L '+money(o.low24h)+'</div></div>';
 stamp.textContent='Updated '+utc(data.generatedAt)+(error?' · stale data':'');
}
async function load(force){
 var k=key(),now=Date.now();
 if(busy||(!force&&k===lastKey&&now-lastAt<300000))return;
 lastKey=k;lastAt=now;busy=true;error='';
 try{
  var symbol=(document.getElementById('symbol')||{}).value||'BTCUSDT';
  var query='/api/analysis/extremes?symbol='+encodeURIComponent(symbol)+(typeof mkt==='function'?mkt():'');
  var response=await getJson(query),next=response&&response.data;
  if(!next||!next.status)throw new Error('The Bybit forecast endpoint returned an invalid response.');
  data=next;error='';
 }catch(e){error=(e&&e.message)||'Forecast request failed';}
 finally{busy=false;render();try{paint();}catch(_){}}
}
function paint(){
 if(!visible||!data||data.status!=='ready'||!data.forecast)return;
 var s=chartScale;if(!s||!(s.hi>s.lo)||!s.plotW)return;
 var x=cv.getContext('2d');if(!x)return;
 var top=s.top,bot=s.bot;
 function line(item,label,color){
  var raw=bot-(item.price-s.lo)/(s.hi-s.lo)*(bot-top);
  var y=Math.max(top+8,Math.min(bot-8,raw));
  x.save();x.strokeStyle=color;x.fillStyle=color;x.lineWidth=1.6;x.setLineDash([7,4]);
  x.beginPath();x.moveTo(0,y);x.lineTo(s.plotW,y);x.stroke();x.setLineDash([]);
  x.font='bold 11px system-ui,sans-serif';x.textAlign='right';
  var off=raw<top||raw>bot?' · OFF-SCALE':'';
  x.fillText(label+' '+money(item.price)+off,s.plotW-6,Math.max(top+12,Math.min(bot-4,y-5)));
  x.restore();
 }
 line(data.forecast.high,'24H HIGH','#ff8196');
 line(data.forecast.low,'24H LOW','#38d7ae');
}
el('efVisible').addEventListener('change',function(e){visible=!!e.target.checked;try{drawChart();}catch(_){}});
el('efRefresh').addEventListener('click',function(){load(true);});
['symbol','symMarket','interval'].forEach(function(id){var e=document.getElementById(id);if(e)e.addEventListener('change',function(){lastKey='';load(true);});});
drawChart=function(){var r=orig.apply(this,arguments);try{paint();}catch(_){}load(false);return r;};
if(typeof window!=='undefined')window.etiExtremeForecast={state:function(){return {visible:visible,status:data&&data.status,forecast:data&&data.forecast,error:error};},refresh:function(){return load(true);}};
load(true);
setInterval(function(){load(false);},300000);
})();
</script>`;

export function withExtremeForecastLayer(page: string): string {
  if (!page.includes('id="chart"') || !page.includes("</body>")) return page;
  return page
    .replace("</head>", EXTREME_FORECAST_CSS + "</head>")
    .replace("</body>", EXTREME_FORECAST_JS + "</body>");
}
