/**
 * Unfilled Fair Value Gap intelligence for the live chart. Layered on top of the FVG layer (worker/ui/fvg-layer.ts), which keeps owning detection,
 * rectangles, higher-timeframe loading and the existing controls. This layer adds, without replacing anything:
 *  - an explicit status badge on every drawn zone ("BULLISH FVG – UNFILLED", "BEARISH FVG – PARTIALLY FILLED", ...) with price boundaries,
 *    timeframe, percentage filled, gap size and formation time (as many segments as fit the zone),
 *  - a lifecycle that keeps the UNFILLED designation until the candle that filled the gap has CLOSED ("FILL PENDING CLOSE" in between),
 *  - an in-memory history registry: zones are keyed once (no duplicates), fill depth only grows, confirmed resolutions are locked (no repainting)
 *    and zones that scroll out of the candle window keep being tracked,
 *  - independent visibility controls (bullish / bearish / unfilled / partially filled / history / all timeframes / dashboard),
 *  - a dashboard of active bullish and bearish unfilled gaps, nearest gaps above and below price, and cross-market (spot / margin / futures) agreement.
 * The lifecycle, retracking, registry and dashboard code mirrors worker/analysis/fvg-intel.ts; worker/fvg-intel.test.ts requires identical results.
 * Pure presentation: no orders, no signals, no browser storage.
 */
export const FVG_INTEL_CSS = `<style id="eti-fvg-intel">
.fvgdash{border-left:3px solid #4aa3ff}
.fvgdash .chips{display:flex;flex-wrap:wrap;gap:6px 14px;margin:4px 0}
.fvgdash .chips span{font-variant-numeric:tabular-nums}
.fvgdash .muted{color:var(--muted)}
</style>`;

export const FVG_INTEL_JS = String.raw`<script id="eti-fvg-intel-js">
(function(){
try{
var F=window.etiFvg;
if(!F||typeof F.state!=='function'||typeof drawChart!=='function'||typeof candles==='undefined'||typeof chartScale==='undefined')return;
var cv=document.getElementById('chart'),stack=document.getElementById('stack');
if(!cv||!stack||!stack.parentNode)return;
var TFMS=F.tfms,MAXAGE=F.rules.maxAgeBars,MAXREC=600;
var S={bull:true,bear:true,unf:true,par:true,his:true,dash:true};
var reg={},lastAll=null;
var TEXT={unfilled:'UNFILLED',partially_filled:'PARTIALLY FILLED',filled_pending:'FILL PENDING CLOSE',filled:'FILLED',invalidated:'INVALIDATED',expired:'EXPIRED'};
function rnd(v,d){return isFinite(v)?Number(v.toFixed(d)):v;}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function curTf(){var e=document.getElementById('interval');return e?e.value:'';}
function px(v){return typeof fp==='function'?fp(v):String(rnd(v,4));}
function p2(n){return n<10?'0'+n:''+n;}
function fmtT(t){var d=new Date(t);return p2(d.getMonth()+1)+'-'+p2(d.getDate())+' '+p2(d.getHours())+':'+p2(d.getMinutes());}
function tw(x,t){try{var m=x.measureText(t);if(m&&typeof m.width==='number')return m.width;}catch(_){}return t.length*5.4;}
function hexRgba(h,a){var m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);if(!m)return 'rgba(128,128,128,'+a+')';return 'rgba('+parseInt(m[1],16)+','+parseInt(m[2],16)+','+parseInt(m[3],16)+','+a+')';}
function clone(z){var o={};for(var k in z)if(Object.prototype.hasOwnProperty.call(z,k))o[k]=z[k];return o;}

/* ---------- lifecycle (mirror of fvg-intel.ts) ---------- */
function formingOf(tf,now){
 var ms=TFMS[tf];if(!ms)return null;
 if(tf===curTf()){var l=candles[candles.length-1];return l&&l[0]+ms>now?l[0]:null;}
 return ms>86400e3?null:Math.floor(now/ms)*ms;
}
function life(z,fo){
 if(z.status==='fresh')return 'unfilled';
 if(z.status==='partially_mitigated')return 'partially_filled';
 if(z.status==='expired')return 'expired';
 var pend=fo!==null&&fo!==undefined&&z.endTime!==null&&z.endTime>=fo;
 if(pend)return 'filled_pending';
 return z.status==='fully_mitigated'?'filled':'invalidated';
}
function label(z,lc){return (z.direction==='bullish'?'BULLISH':'BEARISH')+' FVG – '+TEXT[lc];}
function terminal(lc){return lc==='filled'||lc==='invalidated'||lc==='expired';}
function lcOf(z){return life(z,formingOf(z.timeframe,Date.now()));}
function edges(z,pen){return z.direction==='bullish'?{u:z.upper-pen*z.sizeAbs,l:z.lower}:{u:z.upper,l:z.lower+pen*z.sizeAbs};}
function retrack(rec,rows,now){
 var z=clone(rec.zone),bull=z.direction==='bullish',ms=TFMS[z.timeframe]||0,pen=z.mitigationPct/100,end=null,status=z.status,ce=z.ceTouched;
 var last=rows.length?rows[rows.length-1][0]:rec.trackedThrough;
 for(var i=0;i<rows.length;i++){
  var r=rows[i];if(r[0]<rec.trackedThrough||r[0]<=z.confirmTime)continue;
  var touching=bull?r[3]<=z.upper:r[2]>=z.lower;
  if(touching){var p=Math.min(1,(bull?z.upper-r[3]:r[2]-z.lower)/z.sizeAbs);if(p>pen)pen=p;if(bull?r[3]<=z.mid:r[2]>=z.mid)ce=true;}
  var closed=!ms||r[0]+ms<=now;
  if(closed&&(bull?r[4]<z.lower:r[4]>z.upper)){status='invalidated';pen=1;end=r[0];break;}
  if(pen>=1){status='fully_mitigated';end=r[0];break;}
 }
 var age=ms?Math.max(0,Math.round(((end!==null?end:last)-z.confirmTime)/ms)):z.ageBars;
 if(end===null&&age>MAXAGE){status='expired';end=last;}
 if(end===null)status=pen>0?'partially_mitigated':'fresh';
 var e=edges(z,pen);
 z.status=status;z.active=status==='fresh'||status==='partially_mitigated';z.mitigationPct=rnd(pen*100,0);z.endTime=end;z.ceTouched=ce;z.ageBars=age;
 z.remainingUpper=e.u;z.remainingLower=e.l;z.freshness=status==='fresh'?1:status==='partially_mitigated'?rnd(1-pen,3):0;
 return z;
}

/* ---------- history registry (mirror of FvgRegistry) ---------- */
function prune(){
 var keys=Object.keys(reg);if(keys.length<=MAXREC)return;
 keys.sort(function(a,b){var x=reg[a],y=reg[b];return (Number(y.locked)-Number(x.locked))||(x.lastSeen-y.lastSeen);});
 for(var i=0;i<keys.length&&Object.keys(reg).length>MAXREC;i++)delete reg[keys[i]];
}
function update(st){
 var now=Date.now(),market=st.market,rows=st.rows||{},seen={},zs=st.all||[],k;
 for(var i=0;i<zs.length;i++){
  var z=zs[i],key=market+'|'+z.id;seen[key]=1;
  var prev=reg[key];
  if(prev&&prev.locked){prev.lastSeen=now;continue;}
  var zone=z;
  if(prev&&(z.status==='fresh'||z.status==='partially_mitigated')&&prev.zone.mitigationPct>z.mitigationPct){
   zone=clone(z);zone.status='partially_mitigated';zone.active=true;zone.mitigationPct=prev.zone.mitigationPct;zone.remainingUpper=prev.zone.remainingUpper;zone.remainingLower=prev.zone.remainingLower;
   zone.touches=Math.max(z.touches,prev.zone.touches);zone.ceTouched=z.ceTouched||prev.zone.ceTouched;zone.freshness=rnd(1-zone.mitigationPct/100,3);
  }
  var lcv=life(zone,formingOf(zone.timeframe,now)),rr=rows[zone.timeframe];
  reg[key]={key:key,market:market,zone:zone,lifecycle:lcv,firstSeen:prev?prev.firstSeen:now,lastSeen:now,trackedThrough:rr&&rr.length?rr[rr.length-1][0]:now,locked:terminal(lcv)};
 }
 for(k in reg){
  var rec=reg[k];if(rec.market!==market||seen[k]||rec.locked)continue;
  var r2=rows[rec.zone.timeframe];if(!r2||!r2.length)continue;
  var nz=retrack(rec,r2,now),l2=life(nz,formingOf(nz.timeframe,now));
  rec.zone=nz;rec.lifecycle=l2;rec.lastSeen=now;rec.trackedThrough=r2[r2.length-1][0];rec.locked=terminal(l2);
 }
 prune();
}
function records(market){var o=[];for(var k in reg)if(market===undefined||reg[k].market===market)o.push(reg[k]);return o;}

/* ---------- dashboard (mirror of summarizeFvgDashboard) ---------- */
function dashboard(recs,price){
 var d={bullishUnfilled:0,bearishUnfilled:0,bullishPartial:0,bearishPartial:0,bullishActive:0,bearishActive:0,inside:0,pending:0,history:0,byTimeframe:{},nearestAbove:null,nearestBelow:null},bA=Infinity,bB=Infinity;
 recs.forEach(function(r){
  var z=r.zone,bull=z.direction==='bullish';
  if(r.lifecycle==='filled_pending'){d.pending++;return;}
  if(r.lifecycle!=='unfilled'&&r.lifecycle!=='partially_filled'){d.history++;return;}
  if(r.lifecycle==='unfilled'){if(bull)d.bullishUnfilled++;else d.bearishUnfilled++;}else if(bull)d.bullishPartial++;else d.bearishPartial++;
  if(bull)d.bullishActive++;else d.bearishActive++;
  var b=d.byTimeframe[z.timeframe]||(d.byTimeframe[z.timeframe]={bullish:0,bearish:0});if(bull)b.bullish++;else b.bearish++;
  var dist=price>z.upper?price-z.upper:price<z.lower?z.lower-price:0;
  if(dist===0){d.inside++;return;}
  var br={id:z.id,timeframe:z.timeframe,direction:z.direction,upper:z.upper,lower:z.lower,lifecycle:r.lifecycle,filledPct:z.mitigationPct,distancePct:price>0?rnd(dist/price*100,3):0};
  if(price>z.upper){if(dist<bB){bB=dist;d.nearestBelow=br;}}else if(dist<bA){bA=dist;d.nearestAbove=br;}
 });
 return d;
}
function mkName(m){var p=String(m).split('|');return (p[1]||'default').replace(/^[&?]/,'');}
function mkSym(m){return String(m).split('|')[0];}
/* markets (spot / margin / futures) of the same symbol that show the same gap */
function syncedMarkets(rec){
 var out={},z=rec.zone;out[mkName(rec.market)]=1;
 for(var k in reg){
  var o=reg[k];if(o.market===rec.market||mkSym(o.market)!==mkSym(rec.market))continue;
  var w=o.zone;if(w.timeframe!==z.timeframe||w.direction!==z.direction||w.formationTime!==z.formationTime)continue;
  var ov=Math.min(z.upper,w.upper)-Math.max(z.lower,w.lower);
  if(ov>0&&ov/Math.min(z.sizeAbs,w.sizeAbs)>=0.5)out[mkName(o.market)]=1;
 }
 return Object.keys(out).sort();
}

/* ---------- visibility filter used by the FVG layer ---------- */
window.etiFvgFilter=function(z){
 var lc=lcOf(z);
 if(z.direction==='bullish'&&!S.bull)return false;
 if(z.direction==='bearish'&&!S.bear)return false;
 if(lc==='unfilled'&&!S.unf)return false;
 if((lc==='partially_filled'||lc==='filled_pending')&&!S.par)return false;
 if(terminal(lc)&&!S.his)return false;
 return true;
};

/* ---------- painting ---------- */
function slotOf(t){var lo=0,hi=candles.length;while(lo<hi){var m=(lo+hi)>>1;if(candles[m][0]<t)lo=m+1;else hi=m;}return lo;}
function pendingHits(st){
 var s=chartScale,out=[];
 if(!s||!candles.length||!(s.hi>s.lo))return out;
 var n=candles.length,FUT=(typeof FUTURE==='number'?FUTURE:14),step=s.plotW/(n+FUT),tf=curTf(),shown={};
 (st.hitsList||[]).forEach(function(h){shown[h.z.id]=1;});
 records(st.market).forEach(function(r){
  var z=r.zone;if(r.lifecycle!=='filled_pending'||z.timeframe!==tf||shown[z.id])return;
  if(!(S.par)||(z.direction==='bullish'?!S.bull:!S.bear))return;
  var i0=slotOf(z.formationTime),x0=i0>=n?s.plotW:i0*step,x1=s.plotW;if(x1<=x0)return;
  var yu=s.bot-(z.upper-s.lo)/(s.hi-s.lo)*(s.bot-s.top),yl=s.bot-(z.lower-s.lo)/(s.hi-s.lo)*(s.bot-s.top),y0=Math.min(yu,yl),h=Math.max(1,Math.abs(yl-yu));
  if(y0+h<s.top-6||y0>s.bot+6)continue2();
  out.push({z:z,x0:x0,x1:x1,y0:y0,y1:y0+h,pending:true});
  function continue2(){}
 });
 return out;
}
function paintBadges(st,list){
 var s=chartScale;if(!s||!list.length)return;
 var x=cv.getContext('2d'),col=st.colors||{bull:'#21d69a',bear:'#ff637d'};
 x.save();x.beginPath();x.rect(0,s.top-12,s.plotW,s.bot-s.top+24);x.clip();
 x.globalCompositeOperation='source-over';x.font='bold 10px Inter,system-ui,sans-serif';x.textBaseline='middle';x.textAlign='left';
 list.forEach(function(h,idx){
  if(idx>=10)return;
  var z=h.z,lc=lcOf(z),c=h.pending?'#ffb454':(z.direction==='bullish'?col.bull:col.bear);
  if(h.pending){
   x.fillStyle=hexRgba(c,0.08);x.fillRect(h.x0,h.y0,h.x1-h.x0,h.y1-h.y0);
   x.strokeStyle=hexRgba(c,0.8);x.lineWidth=1;x.setLineDash([4,3]);x.strokeRect(h.x0+.5,h.y0+.5,Math.max(1,h.x1-h.x0-1),Math.max(1,h.y1-h.y0-1));x.setLineDash([]);
  }
  var segs=[label(z,lc),px(z.lower)+' – '+px(z.upper),z.timeframe,z.mitigationPct+'% filled','gap '+px(z.sizeAbs)+' ('+z.sizePct+'%)','formed '+fmtT(z.formationTime)];
  var maxW=Math.max(60,h.x1-h.x0-8),txt=segs[0];
  for(var i=1;i<segs.length;i++){var t2=txt+' · '+segs[i];if(tw(x,t2)+10>maxW)break;txt=t2;}
  var w=Math.min(maxW,tw(x,txt)+10),bx=Math.max(h.x0+4,2),by=Math.max(h.y0-8,s.top+7);
  x.fillStyle='rgba(8,14,26,0.88)';x.fillRect(bx,by-7,w,14);
  x.strokeStyle=hexRgba(c,0.7);x.lineWidth=1;x.strokeRect(bx+.5,by-6.5,w-1,13);
  x.fillStyle=hexRgba(c,1);x.fillText(txt,bx+5,by);
 });
 x.restore();
}

/* ---------- controls and dashboard ---------- */
var bar=document.createElement('div');bar.className='fvgbar';bar.setAttribute('role','group');bar.setAttribute('aria-label','Fair value gap visibility');
var dash=document.createElement('div');dash.className='fvgpanel fvgdash';dash.setAttribute('role','region');dash.setAttribute('aria-label','Unfilled fair value gap dashboard');
stack.parentNode.insertBefore(bar,stack);stack.parentNode.insertBefore(dash,stack);
bar.innerHTML='<strong>FVG filters</strong><label><input type="checkbox" id="fvgiBull" checked> Bullish</label><label><input type="checkbox" id="fvgiBear" checked> Bearish</label><label><input type="checkbox" id="fvgiUnf" checked> Unfilled</label><label><input type="checkbox" id="fvgiPar" checked> Partially filled</label><label><input type="checkbox" id="fvgiHis" checked> History</label><label><input type="checkbox" id="fvgiAll"> All timeframes</label><label><input type="checkbox" id="fvgiDash" checked> Dashboard</label>';
function $i(id){return bar.querySelector('#'+id);}
function redraw(){try{drawChart();}catch(_){}}
$i('fvgiBull').onchange=function(){S.bull=this.checked;redraw();};
$i('fvgiBear').onchange=function(){S.bear=this.checked;redraw();};
$i('fvgiUnf').onchange=function(){S.unf=this.checked;redraw();};
$i('fvgiPar').onchange=function(){S.par=this.checked;redraw();};
$i('fvgiHis').onchange=function(){S.his=this.checked;redraw();};
$i('fvgiDash').onchange=function(){S.dash=this.checked;redraw();};
$i('fvgiAll').onchange=function(){if(F.setAllTf)F.setAllTf(this.checked);else redraw();};
function zoneLine(tag,z){
 if(!z)return '<div class="muted">'+esc(tag)+': none</div>';
 return '<div>'+esc(tag)+': '+(z.direction==='bullish'?'▲':'▼')+' '+esc(z.timeframe)+' '+esc(px(z.lower))+' – '+esc(px(z.upper))+' · '+esc(TEXT[z.lifecycle])+' ('+z.filledPct+'% filled) · '+z.distancePct+'% away</div>';
}
function renderDash(st){
 dash.hidden=!S.dash||!st.on;
 if(dash.hidden)return;
 var recs=records(st.market),last=candles.length?candles[candles.length-1][4]:0,d=dashboard(recs,last);
 var open=recs.filter(function(r){return r.lifecycle==='unfilled'||r.lifecycle==='partially_filled';}),conf=0,names={};
 open.forEach(function(r){var m=syncedMarkets(r);if(m.length>1)conf++;m.forEach(function(n){names[n]=1;});});
 var others=Object.keys(names).filter(function(n){return n!==mkName(st.market);});
 var tfs=Object.keys(d.byTimeframe).map(function(t){return esc(t)+' ▲'+d.byTimeframe[t].bullish+' ▼'+d.byTimeframe[t].bearish;}).join(' · ');
 var html='<strong>Unfilled FVG dashboard</strong>'
  +'<div class="chips"><span style="color:'+esc((st.colors||{}).bull||'#21d69a')+'">▲ Bullish active '+d.bullishActive+' ('+d.bullishUnfilled+' unfilled, '+d.bullishPartial+' partial)</span>'
  +'<span style="color:'+esc((st.colors||{}).bear||'#ff637d')+'">▼ Bearish active '+d.bearishActive+' ('+d.bearishUnfilled+' unfilled, '+d.bearishPartial+' partial)</span>'
  +'<span>Price inside '+d.inside+'</span><span>Fill pending close '+d.pending+'</span><span>History '+d.history+'</span></div>'
  +zoneLine('Nearest above',d.nearestAbove)+zoneLine('Nearest below',d.nearestBelow)
  +'<div class="muted">By timeframe: '+(tfs||'none')+'</div>'
  +'<div class="muted">Market sync: '+esc(mkName(st.market))+(others.length?' + '+esc(others.join(', '))+' · '+conf+' of '+open.length+' open zones confirmed on more than one market':' · other markets appear here after you view them')+'</div>';
 if(dash.getAttribute('data-html')!==html){dash.setAttribute('data-html',html);dash.innerHTML=html;}
}

/* ---------- hook into the chart (after the FVG layer's own hook) ---------- */
var orig=drawChart;
drawChart=function(){
 orig.apply(this,arguments);
 try{
  var st=F.state();
  if(st.all&&st.all!==lastAll){lastAll=st.all;update(st);}
  if(st.on){
   var list=(st.hitsList||[]).concat(pendingHits(st));
   paintBadges(st,list);
  }
  renderDash(st);
 }catch(e){if(window.console)console.warn('FVG intelligence error',e);}
};
window.etiFvgIntel={life:life,label:label,retrack:retrack,dashboard:dashboard,records:records,update:update,syncedMarkets:syncedMarkets,filter:window.etiFvgFilter,state:function(){return {filters:S,records:records().length};}};
drawChart();
}catch(e){if(window.console)console.warn('FVG intelligence unavailable',e);}
})();
</script>`;
