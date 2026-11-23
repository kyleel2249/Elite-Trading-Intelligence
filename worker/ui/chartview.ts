/**
 * Roomier, scrollable market chart. Layered on the dashboard page (like the motion layer) so the chart engine itself is untouched:
 *  - loads 300 candles instead of 120 (the signals API allows a 500-candle window),
 *  - gives every candle a fixed horizontal slot (default 18 px, adjustable 6-36 px for the current visit; nothing is stored in the browser) so candles are never squeezed,
 *    and lets the chart and its indicator panes scroll sideways together (stays pinned to the latest candle until you scroll back),
 *  - makes the main chart and the indicator panes taller.
 * Pure presentation: it never changes data, signals, orders or handlers. If the page markup it expects is not found it does nothing.
 */
export const CHARTVIEW_BARS = 300;
export const CHARTVIEW_CSS = `<style id="eti-chartview">
#stack{overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;scrollbar-color:#2c4a73 #0b1422;padding-bottom:4px}
#stack:focus-visible{outline:2px solid #5aa9ff;outline-offset:2px}
#stack>.chart.big,#stack>.paneBox{width:var(--stackw,100%);min-width:100%}
.chart.big{height:440px;min-height:440px;max-height:none}
.paneBox{height:128px}
.cvbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 8px;font-size:12px;color:var(--muted)}
.cvbar button{padding:4px 10px;font-size:12px}
.cvbar output{min-width:5em;text-align:center;font-variant-numeric:tabular-nums}
@media(max-width:700px){.chart.big{height:340px;min-height:340px;max-height:none}.paneBox{height:104px}}
</style>`;

export const CHARTVIEW_JS = `<script id="eti-chartview-js">
(function(){
try{
if(typeof drawChart!=='function'||typeof candles==='undefined'||!document.getElementById('stack'))return;
var stack=document.getElementById('stack'),MIN=6,MAX=36,step=18,PADR=(typeof PAD_R==='number'?PAD_R:116),FUT=(typeof FUTURE==='number'?FUTURE:14),pin=true,lastW=0,lastN=0;
function want(n){return Math.max(stack.clientWidth,Math.ceil(n*step+PADR+FUT*step));}
function atEnd(){return stack.scrollLeft+stack.clientWidth>=stack.scrollWidth-24;}
function size(){var n=candles.length,w=want(n);if(w!==lastW){pin=pin||atEnd();stack.style.setProperty('--stackw',w+'px');lastW=w;return true;}return false;}
var orig=drawChart;
drawChart=function(){
 var n=candles.length;if(n<lastN)pin=true;lastN=n;
 var was=atEnd();if(was)pin=true;
 var changed=size();
 orig.apply(this,arguments);
 if(pin&&(changed||was)){stack.scrollLeft=stack.scrollWidth;}
};
stack.addEventListener('scroll',function(){pin=atEnd();},{passive:true});
stack.setAttribute('tabindex','0');stack.setAttribute('role','region');stack.setAttribute('aria-label','Market chart. Scroll sideways to see earlier candles.');
var bar=document.createElement('div');bar.className='cvbar';
bar.innerHTML='<span>Candle spacing</span><button type="button" id="cvOut" aria-label="Squeeze candles closer">\\u2212</button><output id="cvVal" aria-live="polite"></output><button type="button" id="cvIn" aria-label="Spread candles further apart">+</button><button type="button" id="cvLatest">Latest</button><button type="button" id="cvStart">Earliest</button><span>Scroll sideways, or Shift + mouse wheel, to move through history.</span>';
stack.parentNode.insertBefore(bar,stack);
var val=bar.querySelector('#cvVal');
function show(){val.textContent=step+' px';bar.querySelector('#cvOut').disabled=step<=MIN;bar.querySelector('#cvIn').disabled=step>=MAX;}
function zoom(d){var right=stack.scrollWidth-stack.scrollLeft;step=Math.max(MIN,Math.min(MAX,step+d));show();size();orig.call(window);stack.scrollLeft=pin?stack.scrollWidth:Math.max(0,stack.scrollWidth-right);}
bar.querySelector('#cvOut').onclick=function(){zoom(-2);};
bar.querySelector('#cvIn').onclick=function(){zoom(2);};
bar.querySelector('#cvLatest').onclick=function(){pin=true;stack.scrollLeft=stack.scrollWidth;};
bar.querySelector('#cvStart').onclick=function(){pin=false;stack.scrollLeft=0;};
show();drawChart();
}catch(e){if(window.console)console.warn('chart view unavailable',e);}
})();
</script>`;

/** Applies the chart view to the dashboard page. A page without the expected markup is returned unchanged. */
export function withChartView(page: string): string {
  if (!page.includes('id="stack"') || !page.includes("const BARS=120")) return page;
  return page
    .replace("const BARS=120", `const BARS=${CHARTVIEW_BARS}`)
    .replace("</head>", CHARTVIEW_CSS + "</head>")
    .replace("</body>", CHARTVIEW_JS + "</body>");
}
