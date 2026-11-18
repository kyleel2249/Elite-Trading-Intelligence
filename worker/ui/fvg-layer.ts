/**
 * Fair Value Gap layer for the live chart. Layered on the dashboard page like the motion and chart-view layers, so the chart engine is untouched:
 *  - recomputes FVG zones from the chart's own candles on every redraw (so zones follow every live tick and extend/resolve in real time),
 *  - loads the next two higher timeframes (read-only market-data calls, refreshed every minute) and shows their gaps on the lower-timeframe chart,
 *    flagged with their timeframe, dashed borders and a confluence count (the "All timeframes" control of the intelligence layer loads every supported timeframe),
 *  - paints rectangles BEHIND the candles (destination-over), labels each zone, shows exact upper/lower prices and lets the viewer toggle zones,
 *    filter timeframes, show mitigated zones, recolour bullish/bearish gaps, and inspect any zone (click it, or use the zone list).
 * The detection code below is a hand-written mirror of worker/analysis/fvg.ts (a Worker cannot eval or stringify TypeScript); worker/fvg.test.ts
 * runs both over the same candles and requires identical zones. Pure presentation: no orders, no signals, no browser storage.
 * worker/ui/fvg-intel-layer.ts is injected right after this layer and builds on the hooks exposed here (window.etiFvg, window.etiFvgFilter).
 */
import { FVG_INTEL_CSS, FVG_INTEL_JS } from "./fvg-intel-layer.ts";

export const FVG_LAYER_CSS = `<style id="eti-fvg">
.fvgbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 8px;font-size:12px;color:var(--muted)}
.fvgbar label{display:inline-flex;gap:4px;align-items:center;cursor:pointer}
.fvgbar input[type=checkbox]{padding:0;width:auto}
.fvgbar input[type=color]{width:28px;height:22px;padding:0;border:1px solid var(--line);background:none;cursor:pointer}
.fvgbar button{padding:4px 10px;font-size:12px}
.fvgbar .fvgsum{font-variant-numeric:tabular-nums}
.fvgbar .fvgwarn{color:#ffb454}
.fvgpanel{margin:0 0 8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:#0b1422;font-size:12px;line-height:1.55}
.fvgpanel[hidden]{display:none}
.fvgpanel dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:2px 16px;margin:6px 0 0}
.fvgpanel dt{color:var(--muted);display:inline}.fvgpanel dd{display:inline;margin:0;font-variant-numeric:tabular-nums}
.fvgpanel .row{display:block}
.fvglist{margin:0 0 8px;font-size:12px}.fvglist summary{cursor:pointer;color:var(--muted)}
.fvglist ul{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.fvglist button{padding:3px 8px;font-size:12px}
</style>`;

export const FVG_LAYER_JS = String.raw`<script id="eti-fvg-js">
(function(){
try{
if(typeof drawChart!=='function'||typeof candles==='undefined'||typeof chartScale==='undefined'||!document.getElementById('chart')||!document.getElementById('stack'))return;
var RULES={minSizeAtr:0.15,maxAgeBars:200,confluenceOverlap:0.25,dedupeOverlap:0.8,defaultMaxZones:12};
var TFMS={'1m':60e3,'3m':180e3,'5m':300e3,'15m':900e3,'30m':1800e3,'1h':3600e3,'2h':7200e3,'4h':14400e3,'6h':21600e3,'8h':28800e3,'12h':43200e3,'1d':86400e3,'3d':259200e3,'1w':604800e3,'1M':31*86400e3};
var TFW={'1m':1,'3m':1.2,'5m':1.5,'15m':2,'30m':2.5,'1h':3,'2h':3.5,'4h':4,'6h':4.5,'8h':4.8,'12h':5,'1d':6,'3d':6.5,'1w':7,'1M':8};
var ORDER=['1m','5m','15m','1h','4h','1d','1w'];
function rnd(v,d){return isFinite(v)?Number(v.toFixed(d)):v;}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function atrSeries(rows,period){
 var n=rows.length,out=new Array(n),i;for(i=0;i<n;i++)out[i]=NaN;
 if(n<=period)return out;
 var tr=rows.map(function(r,i){return i===0?r[2]-r[3]:Math.max(r[2]-r[3],Math.abs(r[2]-rows[i-1][4]),Math.abs(r[3]-rows[i-1][4]));});
 var s=0;for(i=1;i<=period;i++)s+=tr[i];var v=s/period;out[period]=v;
 for(i=period+1;i<n;i++){v=(v*(period-1)+tr[i])/period;out[i]=v;}
 return out;
}
function closedCount(rows,ms,now){var n=rows.length;if(ms&&now!==undefined&&now!==null)while(n>0&&rows[n-1][0]+ms>now)n--;return n;}
function detect(rows,o){
 var minAtr=o.minSizeAtr!==undefined?o.minSizeAtr:RULES.minSizeAtr,maxAge=o.maxAgeBars!==undefined?o.maxAgeBars:RULES.maxAgeBars;
 var n=rows.length,closed=closedCount(rows,o.timeframeMs||TFMS[o.timeframe],o.now),atr=atrSeries(rows,14),out=[];
 var first=Math.max(2,o.window?closed-o.window:0);
 for(var i=first;i<closed;i++){
  var a=atr[i];if(!(a>0))continue;
  var c1=rows[i-2],c2=rows[i-1],c3=rows[i],dir=null,lower=0,upper=0;
  if(c1[2]<c3[3]){dir='bullish';lower=c1[2];upper=c3[3];}
  else if(c1[3]>c3[2]){dir='bearish';upper=c1[3];lower=c3[2];}
  if(!dir)continue;
  var size=upper-lower;if(size<minAtr*a)continue;
  var bull=dir==='bullish',mid=(upper+lower)/2;
  var maxPen=0,touches=0,inside=false,ceTouched=false,status='fresh',endIdx=-1;
  for(var k=i+1;k<n;k++){
   var r=rows[k];
   if(k-i>maxAge){status='expired';endIdx=k;break;}
   var touching=bull?r[3]<=upper:r[2]>=lower;
   var pen=touching?Math.min(1,(bull?upper-r[3]:r[2]-lower)/size):0;
   if(touching&&!inside)touches++;
   inside=touching;
   if(pen>maxPen)maxPen=pen;
   if(bull?r[3]<=mid:r[2]>=mid)ceTouched=true;
   if(bull?r[4]<lower:r[4]>upper){status='invalidated';maxPen=1;endIdx=k;break;}
   if(maxPen>=1){status='fully_mitigated';endIdx=k;break;}
  }
  if(endIdx<0)status=maxPen>0?'partially_mitigated':'fresh';
  var active=status==='fresh'||status==='partially_mitigated';
  var ageBars=(endIdx>=0?endIdx:n-1)-i;
  var body=bull?c2[4]-c2[1]:c2[1]-c2[4],dispAtr=body>0?body/a:0,vs=0,vc=0;
  for(var q=Math.max(0,i-21);q<=i-2;q++){vs+=rows[q][5];vc++;}
  var vm=vc?vs/vc:0,volRatio=vm>0?c2[5]/vm:1;
  var fresh=status==='fresh'?1:status==='partially_mitigated'?1-maxPen:0;
  var strength=clamp(Math.min(1,size/a/1.5)*30+Math.min(1,dispAtr/1.5)*25+clamp(volRatio-1,0,1)*15+fresh*20+clamp(1-ageBars/maxAge,0,1)*10,0,100);
  out.push({id:o.timeframe+':'+dir+':'+c2[0],timeframe:o.timeframe,direction:dir,upper:upper,lower:lower,mid:mid,sizeAbs:size,sizePct:rnd(size/c3[4]*100,4),sizeAtr:rnd(size/a,3),
   formationTime:c2[0],confirmTime:c3[0],formationIndex:i-1,formationPrice:c3[4],status:status,active:active,mitigationPct:rnd(maxPen*100,0),
   endTime:endIdx>=0?rows[endIdx][0]:null,touches:touches,ceTouched:ceTouched,ageBars:ageBars,
   remainingUpper:bull?upper-maxPen*size:upper,remainingLower:bull?lower:lower+maxPen*size,
   displacementAtr:rnd(dispAtr,3),volumeRatio:rnd(volRatio,3),freshness:rnd(fresh,3),strength:rnd(strength,0),confluence:[],relevance:0});
 }
 return out;
}
function overlapOf(a,b){return Math.min(a.upper,b.upper)-Math.max(a.lower,b.lower);}
function zoneDistance(z,p){return p>z.upper?p-z.upper:p<z.lower?z.lower-p:0;}
function analyze(chartTf,inputs,o){
 o=o||{};
 var chart=null;inputs.forEach(function(i){if(i.timeframe===chartTf)chart=i;});
 var last=chart&&chart.rows.length?chart.rows[chart.rows.length-1]:null;
 var price=o.price!==undefined?o.price:(last?last[4]:0),atr=o.atr||0;
 if(!(atr>0)&&chart){var s=atrSeries(chart.rows,14);for(var i=s.length-1;i>=0;i--)if(isFinite(s[i])){atr=s[i];break;}}
 if(!(atr>0))atr=price*0.01;
 var all=[];
 inputs.forEach(function(inp){all=all.concat(detect(inp.rows,{timeframe:inp.timeframe,now:o.now,minSizeAtr:o.minSizeAtr,maxAgeBars:o.maxAgeBars,window:o.window}));});
 var active=all.filter(function(z){return z.active;});
 all.forEach(function(z){
  if(!z.active)return;
  active.forEach(function(w){
   if(w===z||w.timeframe===z.timeframe||w.direction!==z.direction)return;
   var ov=overlapOf(z,w);if(ov<=0)return;
   var pct=ov/Math.min(z.sizeAbs,w.sizeAbs);
   if(pct>=RULES.confluenceOverlap)z.confluence.push({id:w.id,timeframe:w.timeframe,overlapPct:rnd(pct*100,0)});
  });
 });
 all.forEach(function(z){
  var prox=1/(1+zoneDistance(z,price)/(3*atr)),tfw=0.6+0.4*(TFW[z.timeframe]||1)/8;
  z.relevance=z.active?rnd(z.strength*tfw*prox+z.confluence.length*5,2):0;
 });
 var ranked=all.filter(function(z){return z.active;}).sort(function(a,b){return b.relevance-a.relevance||b.formationTime-a.formationTime;});
 var shown=[],max=o.maxZones!==undefined?o.maxZones:RULES.defaultMaxZones;
 for(var j=0;j<ranked.length;j++){
  var z=ranked[j];if(shown.length>=max)break;
  var dupe=shown.some(function(s){var ov=overlapOf(s,z);return s.direction===z.direction&&ov>0&&ov/Math.min(s.sizeAbs,z.sizeAbs)>=RULES.dedupeOverlap;});
  if(!dupe)shown.push(z);
 }
 if(o.includeInactive){
  all.filter(function(z){return !z.active;}).sort(function(a,b){return (b.endTime||0)-(a.endTime||0);}).forEach(function(z){if(shown.length<max)shown.push(z);});
 }
 var by={};active.forEach(function(z){var b=by[z.timeframe]||(by[z.timeframe]={active:0,bullish:0,bearish:0});b.active++;if(z.direction==='bullish')b.bullish++;else b.bearish++;});
 function pick(zs){return zs.sort(function(a,b){return b.relevance-a.relevance;})[0]||null;}
 var summary={active:active.length,unfilledActive:active.filter(function(z){return z.status==="fresh";}).length,partiallyFilledActive:active.filter(function(z){return z.status==="partially_mitigated";}).length,bullishActive:active.filter(function(z){return z.direction==='bullish';}).length,bearishActive:active.filter(function(z){return z.direction==='bearish';}).length,byTimeframe:by,
  nearestSupport:pick(active.filter(function(z){return z.direction==='bullish'&&z.lower<=price;})),nearestResistance:pick(active.filter(function(z){return z.direction==='bearish'&&z.upper>=price;})),
  inside:active.filter(function(z){return price>=z.lower&&price<=z.upper;}),confluentZones:active.filter(function(z){return z.confluence.length>0;}).length};
 return {chartTimeframe:chartTf,price:price,atr:atr,zones:shown,totalDetected:all.length,summary:summary,canTriggerTrade:false,all:all};
}

/* ---------- live state ---------- */
var FUT=(typeof FUTURE==='number'?FUTURE:14);
var st={on:true,labels:true,mitigated:false,tf:{},bull:'#21d69a',bear:'#ff637d'};
var DEF_BULL=st.bull,DEF_BEAR=st.bear,allTf=false;
var res=null,sigKey='',htf={key:'',rows:{},at:{},busy:{},err:{},ver:0},hits=[],selected=null,barTfs='';
var precisionState={key:'',at:0,busy:false,ids:Object.create(null),error:''};
var stack=document.getElementById('stack'),cv=document.getElementById('chart');
function esc2(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function price(v){return typeof fp==='function'?fp(v):String(rnd(v,4));}
function hexRgba(h,a){var m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);if(!m)return 'rgba(128,128,128,'+a+')';return 'rgba('+parseInt(m[1],16)+','+parseInt(m[2],16)+','+parseInt(m[3],16)+','+a+')';}
function curTf(){var e=document.getElementById('interval');return e?e.value:'';}
function marketKey(){var s=document.getElementById('symbol'),m=(typeof mkt==='function'?mkt():'');return (s?s.value:'')+'|'+m;}
function higher(tf){var i=ORDER.indexOf(tf);if(allTf)return ORDER.filter(function(t){return t!==tf;});return i<0?[]:ORDER.slice(i+1,i+3);}
var STATUS={fresh:'fresh',partially_mitigated:'partially mitigated',fully_mitigated:'fully mitigated',invalidated:'invalidated',expired:'expired'};

function loadHtf(){
 if(!st.on||typeof getJson!=='function')return;
 var key=marketKey(),tf=curTf();
 if(htf.key!==key){htf={key:key,rows:{},at:{},busy:{},err:{},ver:htf.ver+1};}
 higher(tf).forEach(function(h){
  if(htf.busy[h]||(htf.at[h]&&Date.now()-htf.at[h]<60000))return;
  htf.busy[h]=true;
  var sym=document.getElementById('symbol').value,k0=key;
  getJson('/api/market/klines?symbol='+encodeURIComponent(sym)+(typeof mkt==='function'?mkt():'')+'&interval='+encodeURIComponent(h)+'&limit=300').then(function(k){
   if(htf.key!==k0)return;
   var rows=k&&k.data;if(!Array.isArray(rows)||!rows.length)throw Error('no candles');
   htf.rows[h]=rows.map(function(v){return v.map(Number);});htf.at[h]=Date.now();htf.err[h]='';htf.ver++;
  }).catch(function(e){if(htf.key!==k0)return;htf.at[h]=Date.now()-30000;htf.err[h]=(e&&e.message)||'unavailable';}).then(function(){htf.busy[h]=false;sigKey='';try{drawChart();}catch(_){}});
 });
}

function compute(){
 var tf=curTf(),n=candles.length;
 if(!n||!TFMS[tf]){res=null;return;}
 var l=candles[n-1],now=Date.now();
 var key=[marketKey(),tf,n,l[0],l[2],l[3],l[4],Math.floor(now/TFMS[tf]),htf.ver,st.mitigated,allTf].join('|');
 if(key===sigKey)return;
 sigKey=key;
 var inputs=[{timeframe:tf,rows:candles}];
 higher(tf).forEach(function(h){if(htf.rows[h]&&htf.key===marketKey())inputs.push({timeframe:h,rows:htf.rows[h]});});
 res=analyze(tf,inputs,{now:now,includeInactive:st.mitigated});
 loadPrecision(tf);
}
function loadPrecision(tf){
 var sym=document.getElementById('symbol'),key=marketKey()+'|'+tf;
 if(!sym||precisionState.busy||(precisionState.key===key&&Date.now()-precisionState.at<60000))return;
 precisionState.key=key;precisionState.at=Date.now();precisionState.busy=true;
 var url='/api/analysis/fvg-precision?symbol='+encodeURIComponent(sym.value)+'&timeframe='+encodeURIComponent(tf);
 fetch(url,{headers:{'accept':'application/json'}}).then(function(r){if(!r.ok)throw Error('precision analysis HTTP '+r.status);return r.json();}).then(function(data){
  if(precisionState.key!==key)return;
  var ids=Object.create(null);(data.candidates||[]).forEach(function(c){if(c.highlight==='green'&&c.state==='qualified_fresh')ids[c.id]=c;});
  precisionState.ids=ids;precisionState.error='';try{drawChart();}catch(_){}
 }).catch(function(e){if(precisionState.key===key)precisionState.error=(e&&e.message)||'precision analysis unavailable';}).then(function(){precisionState.busy=false;});
}

function slotOf(t){var lo=0,hi=candles.length;while(lo<hi){var m=(lo+hi)>>1;if(candles[m][0]<t)lo=m+1;else hi=m;}return lo;}
function visible(z){
 if(st.tf[z.timeframe]===false)return false;
 var f=window.etiFvgFilter;
 if(typeof f==='function'){try{return f(z)!==false;}catch(_){return true;}}
 return true;
}

function paint(){
 hits=[];
 var s=chartScale;
 if(!st.on||!res||!s||!candles.length||!(s.hi>s.lo))return;
 var n=candles.length,step=s.plotW/(n+FUT),tf=curTf();
 function py(v){return s.bot-(v-s.lo)/(s.hi-s.lo)*(s.bot-s.top);}
 var x=cv.getContext('2d');
 x.save();x.beginPath();x.rect(0,s.top-6,s.plotW,s.bot-s.top+12);x.clip();
 var zs=res.zones.filter(visible),texts=[];
 zs.forEach(function(z){
  var i0=slotOf(z.formationTime),x0=i0>=n?s.plotW:i0*step,x1=s.plotW;
  if(!z.active){var ie=slotOf(z.endTime);if(ie>=n&&candles[n-1][0]<z.endTime)return;x1=(ie+1)*step;}
  if(x1<=x0)return;
  var yu=py(z.upper),yl=py(z.lower),y0=Math.min(yu,yl),h=Math.abs(yl-yu);
  if(y0+h<s.top-6||y0>s.bot+6)return;
  var qualified=!!precisionState.ids[z.id],col=qualified?'#35e879':(z.direction==='bullish'?st.bull:st.bear),own=z.timeframe===tf;
  var alpha=qualified?0.25:(z.active?(0.12+z.strength/100*0.14):0.06);
  x.globalCompositeOperation='destination-over';
  x.fillStyle=hexRgba(col,alpha);x.fillRect(x0,y0,x1-x0,Math.max(1,h));
  x.lineWidth=own?1.2:1.6;x.strokeStyle=hexRgba(col,z.active?0.85:0.4);x.setLineDash(own?(z.active?[]:[2,3]):[7,3]);
  x.strokeRect(x0+.5,y0+.5,Math.max(1,x1-x0-1),Math.max(1,h-1));x.setLineDash([]);
  if(z.active){x.strokeStyle=hexRgba(col,0.35);x.lineWidth=1;x.setLineDash([3,4]);x.beginPath();x.moveTo(x0,py(z.mid));x.lineTo(x1,py(z.mid));x.stroke();x.setLineDash([]);}
  x.globalCompositeOperation='source-over';
  hits.push({z:z,x0:x0,x1:x1,y0:y0,y1:y0+Math.max(1,h)});
  texts.push({z:z,x0:x0,x1:x1,y0:y0,h:h,col:col});
 });
 x.globalCompositeOperation='source-over';
 if(st.labels){
  x.font='10px Inter,system-ui,sans-serif';x.textBaseline='middle';
  texts.forEach(function(t,idx){
   var z=t.z,bull=z.direction==='bullish',lx=Math.max(t.x0+4,4);
   if(t.x1-lx<60||t.h<12||idx>=8)return;
   var q=precisionState.ids[z.id],head='FVG '+(bull?'▲ BULL ':'▼ BEAR ')+z.timeframe+' · '+STATUS[z.status]+(q?' · ETI QUALIFIED · ENTRY '+price(q.entry.price):'')+(z.confluence.length?' · MTF×'+(z.confluence.length+1):'');
   var badge=(q?'GREEN TRADE-ENTRY FVG · ':'FVG ')+(bull?'▲ BULL ':'▼ BEAR ')+z.timeframe+' · '+(z.status==='fresh'?'UNMITIGATED':z.status==='partially_mitigated'?'PARTIALLY FILLED':STATUS[z.status].toUpperCase())+' · '+z.mitigationPct+'% FILLED';
   x.fillStyle=hexRgba(t.col,1);x.textAlign='left';x.fillText(head,lx,t.y0+8);
   if(t.h>=26){x.fillStyle=hexRgba(t.col,0.85);x.fillText(badge+' · gap '+price(z.sizeAbs)+' ('+z.sizeAtr+' ATR) · formed @'+price(z.formationPrice),lx,t.y0+20);}
   if(t.h>=34&&t.x1-lx>240){x.textAlign='right';x.fillStyle=hexRgba(t.col,1);x.fillText(price(z.upper),t.x1-5,t.y0+8);x.fillText(price(z.lower),t.x1-5,t.y0+t.h-7);x.textAlign='left';}
  });
  x.textBaseline='alphabetic';x.textAlign='left';
 }
 x.restore();
}

/* ---------- controls ---------- */
var bar=document.createElement('div');bar.className='fvgbar';bar.setAttribute('role','group');bar.setAttribute('aria-label','Fair value gap controls');
var panel=document.createElement('div');panel.className='fvgpanel';panel.hidden=true;panel.setAttribute('role','region');panel.setAttribute('aria-label','Fair value gap details');
var list=document.createElement('details');list.className='fvglist';
stack.parentNode.insertBefore(bar,stack);stack.parentNode.insertBefore(panel,stack);stack.parentNode.insertBefore(list,stack);
bar.innerHTML='<label><input type="checkbox" id="fvgOn" checked> FVG zones</label><span id="fvgTfs" role="group" aria-label="Timeframes shown"></span><label><input type="checkbox" id="fvgLab" checked> Labels</label><label><input type="checkbox" id="fvgMit"> Show mitigated / expired</label><label>Bullish <input type="color" id="fvgBull" value="#21d69a" aria-label="Bullish gap colour"></label><label>Bearish <input type="color" id="fvgBear" value="#ff637d" aria-label="Bearish gap colour"></label><button type="button" id="fvgReset">Reset colours</button><span class="fvgsum" id="fvgSum" role="status" aria-live="off"></span><span class="fvgwarn" id="fvgWarn"></span>';
function $f(id){return bar.querySelector('#'+id);}
function redraw(){sigKey='';try{drawChart();}catch(_){}}
$f('fvgOn').onchange=function(){st.on=this.checked;if(st.on)loadHtf();else{hits=[];}redraw();};
$f('fvgLab').onchange=function(){st.labels=this.checked;redraw();};
$f('fvgMit').onchange=function(){st.mitigated=this.checked;redraw();};
$f('fvgBull').oninput=function(){st.bull=this.value;try{drawChart();}catch(_){}};
$f('fvgBear').oninput=function(){st.bear=this.value;try{drawChart();}catch(_){}};
$f('fvgReset').onclick=function(){st.bull=DEF_BULL;st.bear=DEF_BEAR;$f('fvgBull').value=DEF_BULL;$f('fvgBear').value=DEF_BEAR;try{drawChart();}catch(_){}};
function renderBar(){
 var tf=curTf(),tfs=[tf].concat(higher(tf)),sig=tfs.join(',');
 if(sig!==barTfs){
  barTfs=sig;var h='';
  tfs.forEach(function(t){h+='<label><input type="checkbox" data-tf="'+esc2(t)+'"'+(st.tf[t]===false?'':' checked')+'> '+esc2(t)+(t===tf?' (chart)':(TFMS[t]>TFMS[tf]?' (higher)':' (lower)'))+'</label> ';});
  $f('fvgTfs').innerHTML=h;
  Array.prototype.forEach.call($f('fvgTfs').querySelectorAll('input'),function(i){i.onchange=function(){st.tf[i.getAttribute('data-tf')]=i.checked;try{drawChart();}catch(_){}};});
 }
 var sm=res?res.summary:null;
 var txt=!st.on?'FVG zones hidden':!sm?'Waiting for candles…':sm.active+' active ('+sm.bullishActive+' bull / '+sm.bearishActive+' bear)'+(sm.confluentZones?' · '+sm.confluentZones+' in multi-timeframe confluence':'')+(sm.inside.length?' · price inside '+sm.inside.length:'');
 if($f('fvgSum').textContent!==txt)$f('fvgSum').textContent=txt;
 var errs=[];higher(tf).forEach(function(h){if(htf.err[h])errs.push(h+' unavailable ('+htf.err[h]+')');});
 var w=errs.length?'Higher-timeframe FVGs: '+errs.join(', '):'';if($f('fvgWarn').textContent!==w)$f('fvgWarn').textContent=w;
 var ids=res&&st.on?res.zones.filter(visible).map(function(z){return z.id+z.status+z.mitigationPct;}).join(';'):'';
 if(ids!==list.getAttribute('data-ids')){
  list.setAttribute('data-ids',ids);
  var zs=res&&st.on?res.zones.filter(visible):[];
  list.innerHTML='<summary>Zone list ('+zs.length+') — select a zone to inspect it</summary><ul>'+zs.map(function(z){return '<li><button type="button" data-id="'+esc2(z.id)+'">'+esc2(z.timeframe)+' '+(z.direction==='bullish'?'▲':'▼')+' '+esc2(price(z.lower))+'–'+esc2(price(z.upper))+' · '+esc2(STATUS[z.status])+'</button></li>';}).join('')+'</ul>';
  Array.prototype.forEach.call(list.querySelectorAll('button'),function(b){b.onclick=function(){select(b.getAttribute('data-id'));};});
 }
}
function dt(l,v){return '<div><dt>'+esc2(l)+': </dt><dd>'+esc2(v)+'</dd></div>';}
function select(id){
 selected=id;
 var z=null;if(res)res.zones.forEach(function(q){if(q.id===id)z=q;});
 if(!z){panel.hidden=true;return;}
 var bull=z.direction==='bullish';
 panel.hidden=false;
 panel.innerHTML='<strong style="color:'+esc2(bull?st.bull:st.bear)+'">FVG '+(bull?'▲ bullish':'▼ bearish')+' · '+esc2(z.timeframe)+(z.timeframe===curTf()?'':' (higher timeframe)')+'</strong> <button type="button" id="fvgClose" aria-label="Close zone details">Close</button><dl>'
  +dt('Upper',price(z.upper))+dt('Lower',price(z.lower))+dt('Midpoint (CE)',price(z.mid))+dt('Gap size',price(z.sizeAbs)+' · '+z.sizePct+'% · '+z.sizeAtr+' ATR')
  +dt('Formation price',price(z.formationPrice))+dt('Formed',new Date(z.formationTime).toLocaleString())+dt('Status',STATUS[z.status]+(z.active?' (active)':''))
  +dt('Mitigation',z.mitigationPct+'%'+(z.active&&z.mitigationPct?' — unfilled portion '+price(z.remainingLower)+'–'+price(z.remainingUpper):''))
  +dt('Touches',z.touches+(z.ceTouched?' (midpoint reached)':''))+dt('Age',z.ageBars+' bars')+dt('Strength',z.strength+'/100')+dt('Freshness',Math.round(z.freshness*100)+'%')
  +dt('Displacement',z.displacementAtr+' ATR body')+dt('Volume vs average',z.volumeRatio+'×')
  +dt('Confluence',z.confluence.length?z.confluence.map(function(c){return c.timeframe+' ('+c.overlapPct+'% overlap)';}).join(', '):'none')
  +(z.endTime?dt('Resolved',new Date(z.endTime).toLocaleString()):'')+'</dl><span class="row" style="color:var(--muted);margin-top:6px">A fair value gap is a descriptive price imbalance. It is never a trade signal by itself; ETI uses it only as one confluence input.</span>';
 panel.querySelector('#fvgClose').onclick=function(){selected=null;panel.hidden=true;};
}
cv.addEventListener('click',function(e){
 if(!st.on||!hits.length)return;
 var r=cv.getBoundingClientRect(),px=e.clientX-r.left,py2=e.clientY-r.top,found=null;
 for(var i=hits.length-1;i>=0;i--){var h=hits[i];if(px>=h.x0&&px<=h.x1&&py2>=h.y0&&py2<=h.y1){found=h.z;break;}}
 if(found)select(found.id);
});
document.addEventListener('click',function(e){var t=e.target;if(t&&t.closest&&t.closest('.cvbar'))setTimeout(function(){try{drawChart();}catch(_){}},0);});

/* ---------- hook into the chart ---------- */
var orig=drawChart;
drawChart=function(){
 orig.apply(this,arguments);
 try{
  if(st.on){loadHtf();compute();}
  paint();renderBar();
  if(selected&&!panel.hidden)select(selected);
 }catch(e){if(window.console)console.warn('FVG layer error',e);}
};
window.etiFvg={detect:detect,analyze:analyze,rules:RULES,tfms:TFMS,
 setAllTf:function(v){allTf=!!v;barTfs='';sigKey='';if(st.on)loadHtf();try{drawChart();}catch(_){}},
 state:function(){
  var rows={};rows[curTf()]=candles;
  if(htf.key===marketKey())Object.keys(htf.rows).forEach(function(t){if(t!==curTf())rows[t]=htf.rows[t];});
  return {on:st.on,zones:res?res.zones:[],hits:hits.length,hitsList:hits,all:res?res.all:[],rows:rows,market:marketKey(),tf:curTf(),colors:{bull:st.bull,bear:st.bear}};
 }};
drawChart();
}catch(e){if(window.console)console.warn('FVG layer unavailable',e);}
})();
</script>`;

/** Applies the FVG layer (and the unfilled-gap intelligence layer on top of it) to the dashboard page. A page without the expected markup is returned unchanged. */
export function withFvgLayer(page: string): string {
  if (!page.includes('id="stack"') || !page.includes('id="chart"') || !page.includes("</body>")) return page;
  return page.replace("</head>", FVG_LAYER_CSS + FVG_INTEL_CSS + "</head>").replace("</body>", FVG_LAYER_JS + FVG_INTEL_JS + "</body>");
}
