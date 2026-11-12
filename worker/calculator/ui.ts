/**
 * Dashboard fragments for the profit and leverage calculator. Interpolated into the dashboard template literal in
 * worker/index.ts, so every string here must contain no backticks, no dollar-brace sequences and no backslashes.
 * The arithmetic is core.ts's computePosition, embedded verbatim. Nothing here places an order or sends data anywhere
 * except one read-only GET to /api/markets/classify to choose sensible contract-size defaults for the chart symbol.
 */
import { computePosition } from "./core.ts";

export const CALC_CSS = `
.cl{margin-top:14px}.cl h2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.clgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0}.clgrid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);min-width:0}
.clgrid input,.clgrid select{width:100%;min-width:0;padding:8px 10px;font-size:13px}.clgrid .wide{grid-column:span 2}.clgrid input[type=range]{padding:0;height:34px}
.clbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}.clbar button{padding:6px 12px;font-size:12px}
.clinfo{border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.clwarn{border:1px solid #b65c38;color:#ffb08c;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.clerr{border:1px solid #7c2f3d;color:#ff9aab;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}
.clkpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0}.clkpi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#0b1422;min-width:0}.clkpi span{display:block;font-size:11px;color:var(--muted)}.clkpi b{display:block;font-size:15px;overflow-wrap:anywhere}
.cl .pos{color:#21d69a}.cl .neg{color:#ff637d}.clwrap{overflow-x:auto;border:1px solid #1d2a3e;border-radius:10px}.cl table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.cl th{color:var(--muted);text-align:left;font-weight:600;padding:7px 9px;border-bottom:1px solid #1d2a3e}.cl td{padding:6px 9px;border-bottom:1px solid #121c2c}.cl tr.cur td{background:#10233a}.cl tr.imm td{color:#ff9aab}
@media(max-width:700px){.clgrid .wide{grid-column:span 1}}
`;

export const CALC_HTML = `
<section class="panel cl" id="calcPanel" aria-labelledby="calcTitle">
<h2 id="calcTitle">Profit &amp; Leverage Calculator <span class="muted" style="font-size:12px;font-weight:400">planning only · no orders are placed</span></h2>
<div class="clinfo" id="clSym" aria-live="polite">Chart symbol: not loaded yet.</div>
<div class="clgrid">
<label>Direction<select id="clSide"><option value="buy">Long (buy)</option><option value="sell">Short (sell)</option></select></label>
<label>Instrument type<select id="clInst"><option value="crypto">Crypto / units (1)</option><option value="forex">Forex lots (100,000)</option><option value="gold">Gold lots (100 oz)</option><option value="silver">Silver lots (5,000 oz)</option><option value="stock">Stocks / shares (1)</option><option value="custom">Custom contract size</option></select></label>
<label>Contract size (units per 1 quantity)<input id="clCs" type="number" inputmode="decimal" min="0" step="any" value="1"></label>
<label>Entry price<input id="clEntry" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 2650"></label>
<label>Exit / target price<input id="clExit" type="number" inputmode="decimal" min="0" step="any"></label>
<label>Stop price (optional)<input id="clStop" type="number" inputmode="decimal" min="0" step="any"></label>
<label>Size by<select id="clSizeBy"><option value="quantity">Quantity</option><option value="margin">Margin (capital)</option></select></label>
<label id="clQtyL">Quantity (contracts, lots or units)<input id="clQty" type="number" inputmode="decimal" min="0" step="any" value="1"></label>
<label id="clMarginL" style="display:none">Margin to commit (account currency)<input id="clMargin" type="number" inputmode="decimal" min="0" step="any" value="100"></label>
<label class="wide">Leverage <b id="clLevOut">10x</b><input id="clLevRange" type="range" min="1" max="125" step="1" value="10" aria-label="Leverage slider"></label>
<label>Leverage (exact)<input id="clLev" type="number" inputmode="numeric" min="1" max="150" step="1" value="10"></label>
<label>Fee per side (%)<input id="clFee" type="number" inputmode="decimal" min="0" step="any" value="0.05"></label>
<label>Slippage per side (%)<input id="clSlip" type="number" inputmode="decimal" min="0" step="any" value="0.02"></label>
<label>Funding / financing, total (% of notional)<input id="clFund" type="number" inputmode="decimal" step="any" value="0" title="Positive = you pay, negative = you receive"></label>
<label>Maintenance margin (%)<input id="clMmr" type="number" inputmode="decimal" min="0" step="any" value="0.5"></label>
<label>Quote to account rate<input id="clFx" type="number" inputmode="decimal" min="0" step="any" value="1" title="1 for USD/USDT quotes. For a GBP-quoted pair into a USD account, enter the GBP to USD rate."></label>
<label>Target net profit (optional)<input id="clTp" type="number" inputmode="decimal" step="any" placeholder="amount, account currency"></label>
</div>
<div class="clbar"><button type="button" id="clUseLast">Use chart price as entry</button><button type="button" id="clReset">Reset</button><span class="muted" id="clUnits" style="font-size:12px"></span></div>
<div id="clMsgs" aria-live="polite"></div>
<div class="clkpis" id="clKpis"></div>
<h3 style="font-size:13px;margin:14px 0 6px">Leverage ladder <span class="muted" style="font-weight:400">same position size at other leverage levels</span></h3>
<div class="clwrap"><table id="clLadder"><thead><tr><th>Leverage</th><th>Margin</th><th>Est. liquidation</th><th>Distance</th><th>Net at exit</th><th>ROI on margin</th></tr></thead><tbody></tbody></table></div>
<p class="muted" style="font-size:11px;margin:8px 0 0">Liquidation is an estimate from a standard isolated-margin model (entry price, leverage and the maintenance margin you enter). The venue's own risk engine, mark price, margin tiers and funding decide the real figure. Fee, slippage and maintenance defaults are assumptions, not your account's rates. Linear contracts only; inverse contracts are not modelled.</p>
</section>
`;

const PRESETS = { crypto: { cs: 1, fee: 0.05, slip: 0.02 }, forex: { cs: 100000, fee: 0, slip: 0.005 }, gold: { cs: 100, fee: 0, slip: 0.01 }, silver: { cs: 5000, fee: 0, slip: 0.02 }, stock: { cs: 1, fee: 0, slip: 0.02 } };

export const CALC_JS = `
var __name=function(f){return f;};
var computePosition=${computePosition.toString()};
(function(){
var P=${JSON.stringify(PRESETS)};
function g(id){return $(id);}
function n(id){var v=g(id).value;return v===''?null:Number(v);}
function money(v){if(v===null||!isFinite(v))return '-';var a=Math.abs(v);return (v<0?'-':'')+a.toLocaleString(undefined,{maximumFractionDigits:a>=100?2:a>=1?4:6});}
function px(v){if(v===null||!isFinite(v))return '-';return Number(v.toPrecision(7)).toLocaleString(undefined,{maximumFractionDigits:8});}
function pct(v){return v===null||!isFinite(v)?'-':v.toFixed(2)+'%';}
function kpi(label,val,cls){var d=document.createElement('div');d.className='clkpi';var s=document.createElement('span');s.textContent=label;var b=document.createElement('b');b.textContent=val;if(cls)b.className=cls;d.appendChild(s);d.appendChild(b);return d;}
function msg(cls,t){var d=document.createElement('div');d.className=cls;d.textContent=t;return d;}
function sign(v){return v===null||!isFinite(v)?'':v>=0?'pos':'neg';}
function run(){
 var sizeBy=g('clSizeBy').value;
 g('clQtyL').style.display=sizeBy==='quantity'?'':'none';g('clMarginL').style.display=sizeBy==='margin'?'':'none';
 var r=computePosition({side:g('clSide').value,entry:n('clEntry'),exit:n('clExit'),stop:n('clStop'),sizeBy:sizeBy,quantity:n('clQty'),margin:n('clMargin'),leverage:n('clLev'),feePct:n('clFee'),slippagePct:n('clSlip'),fundingPct:n('clFund'),mmrPct:n('clMmr'),contractSize:n('clCs'),fxRate:n('clFx'),targetProfit:n('clTp')});
 var msgs=g('clMsgs'),k=g('clKpis'),tb=g('clLadder').getElementsByTagName('tbody')[0];msgs.textContent='';k.textContent='';tb.textContent='';g('clUnits').textContent='';
 if(!r.ok){(r.errors||[]).forEach(function(e){msgs.appendChild(msg('clerr',e));});return;}
 (r.warnings||[]).forEach(function(w){msgs.appendChild(msg('clwarn',w));});
 g('clUnits').textContent='Position: '+px(r.units)+' units ('+px(r.quantity)+' quantity)';
 k.appendChild(kpi('Notional exposure',money(r.notional)));k.appendChild(kpi('Margin required',money(r.margin)));
 k.appendChild(kpi('Est. liquidation price',r.liquidation===null?'none (unleveraged long)':px(r.liquidation)+' ('+pct(r.liquidationDistancePct)+' away)',r.liquidationDistancePct!==null&&r.liquidationDistancePct<5?'neg':''));
 k.appendChild(kpi('Break-even price',px(r.breakEven)));
 if(r.target){k.appendChild(kpi('Gross P&L at exit',money(r.target.gross),sign(r.target.gross)));k.appendChild(kpi('Fees + slippage',money(-r.target.fees)));if(r.fundingCost)k.appendChild(kpi('Funding / financing',money(-r.fundingCost)));k.appendChild(kpi('Net profit at exit',money(r.target.net),sign(r.target.net)));k.appendChild(kpi('ROI on margin',pct(r.target.roiPct),sign(r.target.roiPct)));k.appendChild(kpi('Price move to exit',pct(r.target.movePct)));}
 if(r.stopResult){k.appendChild(kpi('Net loss at stop',money(r.stopResult.net),sign(r.stopResult.net)));k.appendChild(kpi('Loss as % of margin',pct(r.stopResult.roiPct),sign(r.stopResult.roiPct)));}
 if(r.riskReward!==null)k.appendChild(kpi('Risk : reward','1 : '+r.riskReward.toFixed(2)));
 if(r.priceForTargetProfit!==null)k.appendChild(kpi('Exit price for target profit',px(r.priceForTargetProfit)));
 var cur=Number(g('clLev').value);
 r.ladder.forEach(function(l){var tr=document.createElement('tr');if(l.leverage===cur)tr.className='cur';if(l.immediate)tr.className+=' imm';
  var cells=[l.leverage+'x',money(l.margin),l.immediate?'liquidated at entry':l.liquidation===null?'none':px(l.liquidation),l.immediate||l.liquidationDistancePct===null?'-':pct(l.liquidationDistancePct),l.net===null?'-':money(l.net),l.roiPct===null?'-':pct(l.roiPct)];
  cells.forEach(function(c,i){var td=document.createElement('td');td.textContent=c;if(i===5&&l.roiPct!==null)td.className=sign(l.roiPct);tr.appendChild(td);});tb.appendChild(tr);});
}
var IDS=['clSide','clInst','clCs','clEntry','clExit','clStop','clSizeBy','clQty','clMargin','clLev','clFee','clSlip','clFund','clMmr','clFx','clTp'];
function applyPreset(){var p=P[g('clInst').value];if(!p)return;g('clCs').value=p.cs;g('clFee').value=p.fee;g('clSlip').value=p.slip;}
function setLev(v){v=Math.max(1,Math.min(150,Math.round(Number(v)||1)));g('clLev').value=v;g('clLevRange').value=Math.min(v,125);g('clLevOut').textContent=v+'x';}
g('clLevRange').addEventListener('input',function(){setLev(g('clLevRange').value);run();});
g('clLev').addEventListener('input',function(){var v=Number(g('clLev').value);if(isFinite(v)&&v>=1){g('clLevRange').value=Math.min(Math.round(v),125);g('clLevOut').textContent=Math.round(v)+'x';}run();});
g('clInst').addEventListener('change',function(){applyPreset();run();});
IDS.forEach(function(i){if(i!=='clLev'&&i!=='clInst'){g(i).addEventListener('input',run);g(i).addEventListener('change',run);}});
function lastPrice(){var t=$('last').textContent.replace(/,/g,'').trim(),v=Number(t);return isFinite(v)&&v>0?v:null;}
g('clUseLast').addEventListener('click',function(){var v=lastPrice();if(v===null){g('clSym').textContent='No live chart price yet: type the entry price manually.';return;}g('clEntry').value=v;run();});
g('clReset').addEventListener('click',function(){g('clSide').value='buy';g('clInst').value='crypto';applyPreset();['clEntry','clExit','clStop','clTp'].forEach(function(i){g(i).value='';});g('clSizeBy').value='quantity';g('clQty').value=1;g('clMargin').value=100;g('clFund').value=0;g('clMmr').value=0.5;g('clFx').value=1;setLev(10);run();});
var seq=0;
async function symInfo(){
 var s=$('symbol').value,my=++seq;if(!s)return;
 try{var r=await fetch('/api/markets/classify?symbol='+encodeURIComponent(s),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);var c=await r.json();if(my!==seq)return;
  var ac=c.asset_class,base=c.base,t=ac==='forex'?'forex':ac==='metal'?(base==='XAU'?'gold':base==='XAG'?'silver':'custom'):ac==='crypto'?'crypto':ac==='stock'?'stock':'custom';
  var quote=c.quote||'',needFx=quote&&['USD','USDT','USDC','FDUSD','BUSD'].indexOf(quote)<0;
  g('clSym').textContent='Chart symbol '+s+' · '+(c.name||s)+' · '+ac+(c.tier?' / '+c.tier:'')+(needFx?' · quoted in '+quote+': set the quote to account rate to convert results.':' · results are in '+(quote||'quote currency')+'.');
  if(g('clInst').dataset.auto!=='off'&&g('clInst').dataset.last!==s){g('clInst').dataset.last=s;if(P[t]||t==='custom'){g('clInst').value=t;if(P[t])applyPreset();}run();}
 }catch(e){if(my===seq)g('clSym').textContent='Chart symbol '+s+' (market profile unavailable; pick the instrument type manually).';}
}
g('clInst').addEventListener('change',function(){g('clInst').dataset.auto='off';});
$('symbol').addEventListener('change',symInfo);$('symMarket').addEventListener('change',function(){setTimeout(symInfo,400);});
setLev(g('clLev').value);run();symInfo();
})();
`;
