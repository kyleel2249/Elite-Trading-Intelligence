/**
 * Roomy, scrollable price chart for the dashboard. Interpolated into the dashboard template literal in worker/index.ts
 * (through worker/calculator/ui.ts), so every string here must contain no backticks, no dollar-brace sequences and no
 * backslashes.
 *
 * What it does: the candle chart and its four indicator panes used to squeeze every candle into the available width, so
 * candles were a few pixels wide. Here the chart canvas is as wide as (candles x candle size) and sits in a horizontally
 * scrollable box with a large visible scrollbar. The user picks the candle size (Compact to Extra large) or "Fit all";
 * the chart and panes get taller; and the view follows the newest candle until the user scrolls back in time.
 * Nothing here draws a candle: it only decides how wide the existing canvases are, then lets drawChart() do the drawing.
 */
export const CHART_LAYOUT_CSS = `
.chart.big{height:440px;min-height:440px;max-height:none}.paneBox{height:124px}
.cscroll{overflow-x:auto;overflow-y:hidden;border:1px solid #1d2a3e;border-radius:10px;background:#0a1220;padding-bottom:4px;scrollbar-width:auto;scrollbar-color:#4a6c9b #0f1a2b}
.cscroll::-webkit-scrollbar{height:16px}.cscroll::-webkit-scrollbar-track{background:#0f1a2b;border-radius:8px}.cscroll::-webkit-scrollbar-thumb{background:#4a6c9b;border-radius:8px;border:3px solid #0f1a2b}.cscroll::-webkit-scrollbar-thumb:hover{background:#6b93c9}.cscroll:focus-visible{outline:2px solid var(--blue)}
.cbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 8px}.cbar select,.cbar button{padding:7px 12px;font-size:13px}
.scroll{max-height:540px}.scroll th,.scroll td{padding:10px 10px;font-size:13px}
@media(max-width:700px){.chart.big{height:340px;min-height:340px;max-height:none}.paneBox{height:104px}.scroll{max-height:420px}}
/* Live market chart follows the shared 440px desktop / 340px mobile chart height. */
.chart-workspace:not(:fullscreen) #stack>.chart.big#liveChartFrame{height:440px;min-height:440px;max-height:none}
@media(max-width:700px){.chart-workspace:not(:fullscreen) #stack>.chart.big#liveChartFrame{height:340px;min-height:340px;max-height:none}}
}
`;

export const CHART_LAYOUT_JS = `
(function(){
if(typeof drawChart!=='function'||!$('stack')||$('cscroll'))return;
var cfg={step:16,fit:false,atEnd:true}; /* kept in memory only: the dashboard stores nothing in the browser */
var st=$('stack'),sc=document.createElement('div');
sc.id='cscroll';sc.className='cscroll';sc.tabIndex=0;sc.setAttribute('role','region');
sc.setAttribute('aria-label','Scrollable price chart. Use the horizontal scrollbar or the arrow keys to see older candles.');
st.parentNode.insertBefore(sc,st);sc.appendChild(st);
var bar=document.createElement('div');bar.className='cbar';
bar.innerHTML='<label class="muted">Candle size <select id="barW" aria-label="Candle size"><option value="10">Compact</option><option value="16">Comfortable</option><option value="22">Large</option><option value="28">Extra large</option></select></label><button type="button" id="barFit" aria-pressed="false">Fit all candles</button><button type="button" id="barEnd">Jump to latest</button><span class="muted" id="barNote">Scroll sideways for older candles.</span>';
sc.parentNode.insertBefore(bar,sc);
var sel=$('barW');
function pick(v){var best='16',d=1e9;Array.prototype.forEach.call(sel.options,function(o){var x=Math.abs(Number(o.value)-v);if(x<d){d=x;best=o.value;}});sel.value=best;}
pick(cfg.step);
function layout(){
 var vis=sc.clientWidth||600,n=Math.max(candles.length,1);
 var want=cfg.fit?vis:Math.max(vis,Math.round((n+FUTURE)*cfg.step+PAD_R)),w=want+'px';
 if(st.style.width!==w)st.style.width=w;
}
var base=drawChart;
drawChart=function(){layout();base();if(cfg.atEnd&&!cfg.fit)sc.scrollLeft=sc.scrollWidth;};
sc.addEventListener('scroll',function(){cfg.atEnd=sc.scrollLeft+sc.clientWidth>=sc.scrollWidth-8;});
sel.addEventListener('change',function(){cfg.step=Number(sel.value);cfg.fit=false;$('barFit').setAttribute('aria-pressed','false');drawChart();});
$('barFit').addEventListener('click',function(){cfg.fit=!cfg.fit;this.setAttribute('aria-pressed',String(cfg.fit));this.textContent=cfg.fit?'Back to scrolling':'Fit all candles';$('barNote').textContent=cfg.fit?'All candles squeezed into the visible width.':'Scroll sideways for older candles.';if(!cfg.fit)cfg.atEnd=true;drawChart();});
$('barEnd').addEventListener('click',function(){cfg.atEnd=true;cfg.fit=false;drawChart();sc.scrollLeft=sc.scrollWidth;});
if(typeof resetAndLoad==='function'){var rl=resetAndLoad;resetAndLoad=function(){cfg.atEnd=true;return rl.apply(this,arguments);};}
})();
`;
