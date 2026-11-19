/**
 * Dashboard fragments for the profit and leverage calculator. Interpolated into the dashboard template literal in
 * worker/index.ts, so every string here must contain no backticks, no dollar-brace sequences and no backslashes.
 * The arithmetic is core.ts's computePosition, embedded verbatim.
 *
 * The calculator is anchored to the ENTRY price (typed, taken from the chart price, or set by clicking the chart).
 * "Place entry + stop + target" does not talk to any venue itself: it copies the calculation into the dashboard's existing
 * order ticket (symbol, quantity, limit price) and the protective-levels plan (stop and TP1), then calls the dashboard's own
 * submitOrder('buy'), so every existing safeguard, the final confirmation dialog and the server-side checks still apply.
 * A limit entry rests on the book and fills automatically when the market reaches it; the stop and target then exit
 * automatically on INTERNAL PAPER (on exchange testnet they are alert-only, as the portfolio panel already states).
 * The only network call made here is one read-only GET to /api/markets/classify to choose contract-size defaults.
 *
 * It also carries the roomy, scrollable chart layout (worker/ui/chart-layout.ts) because this module is already
 * interpolated into the dashboard after the chart code runs.
 */
import { computePosition } from "./core.ts";
import { CHART_LAYOUT_CSS, CHART_LAYOUT_JS } from "../ui/chart-layout.ts";

export const CALC_CSS = CHART_LAYOUT_CSS + `
.cl{margin-top:14px}.cl h2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.clgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:8px 0}.clgrid label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted);min-width:0}
.clgrid input,.clgrid select{width:100%;min-width:0;padding:8px 10px;font-size:13px}.clgrid .wide{grid-column:span 2}.clgrid input[type=range]{padding:0;height:34px}
.clbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}.clbar button{padding:6px 12px;font-size:12px}
.clinfo{border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.clwarn{border:1px solid #b65c38;color:#ffb08c;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.clerr{border:1px solid #7c2f3d;color:#ff9aab;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.clok{border:1px solid #1f6f55;color:#7be3b9;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}
.clkpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:10px 0}.clkpi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#0b1422;min-width:0}.clkpi span{display:block;font-size:11px;color:var(--muted)}.clkpi b{display:block;font-size:15px;overflow-wrap:anywhere}
.cl .pos{color:#21d69a}.cl .neg{color:#ff637d}.clwrap{overflow-x:auto;border:1px solid #1d2a3e;border-radius:10px}.cl table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}.cl th{color:var(--muted);text-align:left;font-weight:600;padding:7px 9px;border-bottom:1px solid #1d2a3e}.cl td{padding:6px 9px;border-bottom:1px solid #121c2c}.cl tr.cur td{background:#10233a}.cl tr.imm td{color:#ff9aab}
.clexec{border:1px solid #1d2a3e;border-radius:10px;padding:10px 12px;margin:12px 0;background:#0b1422}.clexec h3{font-size:13px;margin:0 0 6px}.clexec label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted)}.clexec .clchk{flex-direction:row;align-items:center;gap:6px}.clexec select{padding:7px 10px;font-size:13px;max-width:100%}.clexec button.clgo{padding:8px 16px;font-size:13px;border-color:#1f6f55;color:#7be3b9}
@media(max-width:700px){.clgrid .wide{grid-column:span 1}}
`;

export const CALC_HTML = `
<section class="panel cl" id="calcPanel" aria-labelledby="calcTitle">
<h2 id="calcTitle">Profit &amp; Leverage Calculator <span class="muted" style="font-size:12px;font-weight:400">anchored to your entry price · can place the order for you (paper / testnet)</span></h2>
<div class="clinfo" id="clSym" aria-live="polite">Chart symbol: not loaded yet.</div>
<div class="clexec" id="clAnalysisPanel"><h3>ETI strategy-driven entry and exit</h3><label class="clchk muted"><input type="checkbox" id="clAutoAnalysis" checked> Automatically use qualified ETI Liquidity-FVG strategy levels</label><div class="clinfo" id="clAnalysisStatus" aria-live="polite">Waiting for current pair and timeframe analysis.</div><div class="clinfo" id="clAnalysisDetails" aria-live="polite">FVG, liquidity sweeps, order blocks, structure and strategy targets will appear here when analysis is ready.</div></div>
<div class="clinfo" id="clMarketNote" aria-live="polite">Futures mode: choose Long or Short and set leverage. Calculations include fees, slippage and funding assumptions.</div>
<div class="clgrid">
<label>Market type<select id="clMarketMode"><option value="futures">Futures / Perpetual</option><option value="spot">Spot</option></select></label>
<label>Direction<select id="clSide"><option value="buy">Long (buy)</option><option value="sell">Short (sell)</option></select></label>
<label>Instrument type<select id="clInst"><option value="crypto">Crypto / units (1)</option><option value="forex">Forex lots (100,000)</option><option value="gold">Gold lots (100 oz)</option><option value="silver">Silver lots (5,000 oz)</option><option value="stock">Stocks / shares (1)</option><option value="custom">Custom contract size</option></select></label>
<label>Contract size (units per 1 quantity)<input id="clCs" type="number" inputmode="decimal" min="0" step="any" value="1"></label>
<label>ETI entry price<input id="clEntry" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 2650"></label>
<label>ETI planned exit price<input id="clExit" type="number" inputmode="decimal" min="0" step="any"></label>
<label>ETI stop-loss price<input id="clStop" type="number" inputmode="decimal" min="0" step="any"></label>
<label>Amount type<select id="clSizeBy"><option value="margin" selected>Capital / margin to commit</option><option value="quantity">Quantity</option></select></label>
<label id="clQtyL">Quantity (contracts, lots or units)<input id="clQty" type="number" inputmode="decimal" min="0" step="any" value="1"></label>
<label id="clMarginL"><span id="clMarginTitle">Capital / margin to commit (account currency)</span><input id="clMargin" type="number" inputmode="decimal" min="0" step="any" value="100"></label>
<label class="wide" id="clLevRangeL">Leverage <b id="clLevOut">10x</b><input id="clLevRange" type="range" min="1" max="125" step="1" value="10" aria-label="Leverage slider"></label>
<label id="clLevL">Leverage (exact)<input id="clLev" type="number" inputmode="numeric" min="1" max="150" step="1" value="10"></label>
<label>Fee per side (%)<input id="clFee" type="number" inputmode="decimal" min="0" step="any" value="0.05"></label>
<label>Slippage per side (%)<input id="clSlip" type="number" inputmode="decimal" min="0" step="any" value="0.02"></label>
<label id="clFundL">Funding / financing, total (% of notional)<input id="clFund" type="number" inputmode="decimal" step="any" value="0" title="Positive = you pay, negative = you receive"></label>
<label id="clMmrL">Maintenance margin (%)<input id="clMmr" type="number" inputmode="decimal" min="0" step="any" value="0.5"></label>
<label>Quote to account rate<input id="clFx" type="number" inputmode="decimal" min="0" step="any" value="1" title="1 for USD/USDT quotes. For a GBP-quoted pair into a USD account, enter the GBP to USD rate."></label>
<label>Target input<select id="clTargetMode"><option value="amount">Net profit amount</option><option value="pct">Net return (%)</option></select></label>
<label id="clTpL">Target net profit amount<input id="clTp" type="number" inputmode="decimal" step="any" placeholder="e.g. 1.00"></label>
<label id="clTpPctL" style="display:none">Target net return on capital / margin (%)<input id="clTpPct" type="number" inputmode="decimal" min="0" step="any" placeholder="e.g. 2"></label>
</div>
<div class="clbar"><button type="button" id="clUseLast">Use chart price as entry</button><button type="button" id="clReset">Reset</button><label class="clchk muted" style="display:inline-flex;flex-direction:row;gap:6px;align-items:center;font-size:12px"><input type="checkbox" id="clLink" checked> Clicking the chart sets the entry</label><span class="muted" id="clUnits" style="font-size:12px"></span></div>
<div class="clexec" id="clExec">
<h3>Execute this plan automatically <span class="muted" style="font-weight:400">paper / testnet only · uses the order panel's venue, safeguards and confirmation</span></h3>
<div class="clbar"><label>Entry order<select id="clMode" aria-label="Entry order type"><option value="limit">Limit at the entry price (rests, then fills automatically when the market reaches it)</option><option value="market">Market now at the live chart price</option></select></label><button type="button" id="clPlace" class="clgo">Place entry + stop + target</button></div>
<div class="clinfo" id="clPlaceMsg" aria-live="polite">Fill in the entry (and optionally stop and target), then place it. The stop and target are attached as the order's protective exits.</div>
</div>
<div id="clMsgs" aria-live="polite"></div>
<div class="clkpis" id="clKpis"></div>
<div id="clLadderPanel"><h3 style="font-size:13px;margin:14px 0 6px">Leverage ladder <span class="muted" style="font-weight:400">same position size at other leverage levels</span></h3>
<div class="clwrap"><table id="clLadder"><thead><tr><th>Leverage</th><th>Margin</th><th>Est. liquidation</th><th>Distance</th><th>Net at exit</th><th>ROI on margin</th></tr></thead><tbody></tbody></table></div></div>
<p class="muted" style="font-size:11px;margin:8px 0 0">Liquidation is an estimate from a standard isolated-margin model (entry price, leverage and the maintenance margin you enter). The venue's own risk engine, mark price, margin tiers and funding decide the real figure. Fee, slippage and maintenance defaults are assumptions, not your account's rates. Linear contracts only; inverse contracts are not modelled. Spot paper and testnet orders are unleveraged and long-only: leverage here only changes the margin and liquidation estimates.</p>
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
function inputs(){
 var spot=g('clMarketMode').value==='spot',targetMode=g('clTargetMode').value;
 return {side:spot?'buy':g('clSide').value,entry:n('clEntry'),exit:n('clExit'),stop:n('clStop'),sizeBy:g('clSizeBy').value,quantity:n('clQty'),margin:n('clMargin'),leverage:spot?1:n('clLev'),feePct:n('clFee'),slippagePct:n('clSlip'),fundingPct:spot?0:n('clFund'),mmrPct:n('clMmr'),contractSize:n('clCs'),fxRate:n('clFx'),targetProfit:targetMode==='amount'?n('clTp'):null,targetProfitPct:targetMode==='pct'?n('clTpPct'):null};
}
var activeEtiAnalysis=null,activeEtiAnalysisSymbol='',activeEtiAnalysisTimeframe='';
function autoAnalysisLevels(){
 var a=activeEtiAnalysis,spot=g('clMarketMode').value==='spot',auto=g('clAutoAnalysis').checked,setup=a&&a.autopilotEligible&&a.setup?a.setup:null;
 ['clEntry','clExit','clStop'].forEach(function(id){g(id).readOnly=auto;});
 if(!auto||!setup)return null;
 if(spot&&setup.direction!=='BUY')return {blocked:'The current qualified ETI setup is SHORT. Spot is long-only; switch to Futures to use this setup.'};
 g('clSide').value=setup.direction==='BUY'?'buy':'sell';
 g('clEntry').value=setup.entry;
 g('clStop').value=setup.stopLoss===null?'':setup.stopLoss;
 var strategyTarget=setup.targets&&setup.targets.length?Number(setup.targets[0].price):NaN;
 if(!(strategyTarget>0))return {blocked:'The qualified setup has no valid strategy target. No exit price was invented.'};
 var base=inputs();base.exit=null;
 var targetCalc=computePosition(base),desired=targetCalc.ok?targetCalc.priceForTargetProfit:null,chosen=strategyTarget;
 if(desired!==null&&isFinite(desired)&&desired>0)chosen=setup.direction==='BUY'?Math.min(desired,strategyTarget):Math.max(desired,strategyTarget);
 g('clExit').value=chosen;
 return {setup:setup,strategyTarget:strategyTarget,desired:desired,chosen:chosen,targetCalc:targetCalc};
}
function renderAnalysisPlan(plan){
 var status=g('clAnalysisStatus'),details=g('clAnalysisDetails'),a=activeEtiAnalysis;
 if(!a){status.textContent='Analysis unavailable: '+(plan&&plan.error||'waiting for market data');details.textContent='No entry or exit has been generated. Check the selected pair, chart timeframe and market-data feed.';return;}
 var best=a.precision&&a.precision.best;
 if(plan&&plan.blocked){status.textContent='WAIT · '+plan.blocked;details.textContent=(a.blocks||[]).join(' · ')||'No qualified setup.';return;}
 if(!a.autopilotEligible||!a.setup){
  status.textContent='WAIT · no fully qualified Liquidity-FVG entry on '+a.timeframe+'. No automatic order levels will be proposed.';
  details.textContent=(best?'Best provisional '+best.direction+' FVG '+px(best.zone.lower)+'–'+px(best.zone.upper)+' · candidate entry '+px(best.entry.price)+' · state '+best.state+' · evidence '+best.score+'/100. ':'No precision FVG candidate is currently available. ')+(a.blocks||[]).join(' · ');
  return;
 }
 var s=plan.setup,side=s.direction,parts=['Qualified '+side+' setup · '+a.timeframe+' · evidence '+a.score+'/100','FVG '+px(s.fvg.lower)+'–'+px(s.fvg.upper)+' (CE '+px(s.entry)+')','Stop '+px(s.stopLoss),'Strategy TP1 '+px(plan.strategyTarget)];
 if(plan.desired!==null&&isFinite(plan.desired)){parts.push('Profit-target price '+px(plan.desired));if(Math.abs(plan.desired-plan.strategyTarget)>Math.abs(plan.strategyTarget)*1e-10)parts.push('planned exit '+px(plan.chosen)+' is capped at TP1');}
 if(a.latestSweep)parts.push('latest sweep '+a.latestSweep.side.replace('_',' ')+' at '+px(a.latestSweep.level)+' · reclaimed '+(a.latestSweep.reclaimed?'yes':'no'));
 if(a.manipulation)parts.push('stop-run risk '+a.manipulation.level+' ('+a.manipulation.score+'/100)');
 if(a.pools&&a.pools.length)parts.push('nearest ranked liquidity '+a.pools[0].side.replace('_',' ')+' at '+px(a.pools[0].price));
 if(plan.desired!==null&&isFinite(plan.desired)&&plan.chosen===plan.strategyTarget&&((side==='BUY'&&plan.desired>plan.strategyTarget)||(side==='SELL'&&plan.desired<plan.strategyTarget)))status.textContent='QUALIFIED SETUP · requested profit target lies beyond the strategy TP1; ETI uses TP1 instead, so the requested amount may not be reached.';
 else status.textContent='QUALIFIED SETUP · entry, stop and exit are calculated from ETI analysis and your current capital / margin and profit target.';
 details.textContent=parts.join(' · ');
}
function run(){
 var sizeBy=g('clSizeBy').value,spot=g('clMarketMode').value==='spot',targetMode=g('clTargetMode').value;
 g('clQtyL').style.display=sizeBy==='quantity'?'':'none';g('clMarginL').style.display=sizeBy==='margin'?'':'none';
 g('clTpL').style.display=targetMode==='amount'?'':'none';g('clTpPctL').style.display=targetMode==='pct'?'':'none';
 var plan=autoAnalysisLevels();
 var r=computePosition(inputs());
 var msgs=g('clMsgs'),k=g('clKpis'),tb=g('clLadder').getElementsByTagName('tbody')[0];msgs.textContent='';k.textContent='';tb.textContent='';g('clUnits').textContent='';
 if(!r.ok){(r.errors||[]).forEach(function(e){msgs.appendChild(msg('clerr',e));});return;}
 (r.warnings||[]).forEach(function(w){msgs.appendChild(msg('clwarn',w));});
 g('clUnits').textContent=(spot?'Spot position: ':'Futures position: ')+px(r.units)+' units ('+px(r.quantity)+' quantity)';
 k.appendChild(kpi('Notional exposure',money(r.notional)));k.appendChild(kpi('Margin required',money(r.margin)));
 k.appendChild(kpi('Est. liquidation price',r.liquidation===null?'none (unleveraged long)':px(r.liquidation)+' ('+pct(r.liquidationDistancePct)+' away)',r.liquidationDistancePct!==null&&r.liquidationDistancePct<5?'neg':''));
 k.appendChild(kpi('Break-even price',px(r.breakEven)));
 if(r.target){k.appendChild(kpi('Gross P&L at exit',money(r.target.gross),sign(r.target.gross)));k.appendChild(kpi('Fees + slippage',money(-r.target.fees)));if(r.fundingCost)k.appendChild(kpi('Funding / financing',money(-r.fundingCost)));k.appendChild(kpi('Net profit at exit',money(r.target.net),sign(r.target.net)));k.appendChild(kpi('ROI on margin',pct(r.target.roiPct),sign(r.target.roiPct)));k.appendChild(kpi('Price move to exit',pct(r.target.movePct)));}
 if(r.stopResult){k.appendChild(kpi('Net loss at stop',money(r.stopResult.net),sign(r.stopResult.net)));k.appendChild(kpi('Loss as % of margin',pct(r.stopResult.roiPct),sign(r.stopResult.roiPct)));}
 if(r.riskReward!==null)k.appendChild(kpi('Risk : reward','1 : '+r.riskReward.toFixed(2)));
 if(r.priceForTargetProfit!==null){k.appendChild(kpi('Exit price for target profit',px(r.priceForTargetProfit)));k.appendChild(kpi('Favourable price move required',pct(Math.abs(r.targetProfitMovePct))));k.appendChild(kpi('Net profit target',money(r.targetProfitAmount)));}
 if(plan&&plan.setup){var strategy=computePosition(Object.assign(inputs(),{exit:plan.strategyTarget}));k.appendChild(kpi('ETI strategy TP1',px(plan.strategyTarget)));if(strategy.ok&&strategy.target)k.appendChild(kpi('Net profit at strategy TP1',money(strategy.target.net),sign(strategy.target.net)));}
 var cur=Number(g('clLev').value);
 r.ladder.forEach(function(l){var tr=document.createElement('tr');if(l.leverage===cur)tr.className='cur';if(l.immediate)tr.className+=' imm';
  var cells=[l.leverage+'x',money(l.margin),l.immediate?'liquidated at entry':l.liquidation===null?'none':px(l.liquidation),l.immediate||l.liquidationDistancePct===null?'-':pct(l.liquidationDistancePct),l.net===null?'-':money(l.net),l.roiPct===null?'-':pct(l.roiPct)];
  cells.forEach(function(c,i){var td=document.createElement('td');td.textContent=c;if(i===5&&l.roiPct!==null)td.className=sign(l.roiPct);tr.appendChild(td);});tb.appendChild(tr);});
}
var IDS=['clSide','clInst','clCs','clEntry','clExit','clStop','clSizeBy','clQty','clMargin','clLev','clFee','clSlip','clFund','clMmr','clFx','clTp','clTpPct'];
function applyPreset(){var p=P[g('clInst').value];if(!p)return;g('clCs').value=p.cs;g('clFee').value=p.fee;g('clSlip').value=p.slip;}
function setLev(v){v=Math.max(1,Math.min(150,Math.round(Number(v)||1)));g('clLev').value=v;g('clLevRange').value=Math.min(v,125);g('clLevOut').textContent=v+'x';}
function applyMarketMode(){var mode=g('clMarketMode').value,prev=g('clMarketMode').dataset.last||'futures';if(mode==='spot'&&prev!=='spot'){g('clMarketMode').dataset.futuresLev=g('clLev').value||'10';g('clSide').value='buy';setLev(1);}else if(mode==='futures'&&prev==='spot'){setLev(Number(g('clMarketMode').dataset.futuresLev)||10);}var spot=mode==='spot';g('clSide').disabled=spot;g('clLev').disabled=spot;g('clLevRange').disabled=spot;g('clFund').disabled=spot;g('clMmr').disabled=spot;g('clMarketNote').textContent=spot?'Spot mode: long-only, unleveraged (1x). Target return is calculated against invested capital.':'Futures mode: choose Long or Short and set leverage. Target return is calculated against allocated margin; estimated funding, fees and slippage are included.';['clLevRangeL','clLevL','clFundL','clMmrL'].forEach(function(id){g(id).style.display=spot?'none':'';});g('clLadderPanel').style.display=spot?'none':'';g('clMarginTitle').textContent=spot?'Capital to invest (account currency)':'Margin to commit (account currency)';g('clMarketMode').dataset.last=mode;}
function applyTargetMode(){var amount=g('clTargetMode').value==='amount';g('clTpL').style.display=amount?'':'none';g('clTpPctL').style.display=amount?'none':'';}
g('clLevRange').addEventListener('input',function(){setLev(g('clLevRange').value);run();});
g('clLev').addEventListener('input',function(){var v=Number(g('clLev').value);if(isFinite(v)&&v>=1){g('clLevRange').value=Math.min(Math.round(v),125);g('clLevOut').textContent=Math.round(v)+'x';}run();});
g('clInst').addEventListener('change',function(){applyPreset();run();});
IDS.forEach(function(i){if(i!=='clLev'&&i!=='clInst'){g(i).addEventListener('input',run);g(i).addEventListener('change',run);}});
g('clMarketMode').addEventListener('change',function(){applyMarketMode();run();});g('clTargetMode').addEventListener('change',function(){applyTargetMode();run();});
g('clAutoAnalysis').addEventListener('change',function(){run();});
window.addEventListener('eti-liquidity-fvg-updated',function(ev){
 var d=ev&&ev.detail||{},sym=$('symbol').value,tf=$('interval').value;
 if(d.symbol!==sym||d.timeframe!==tf)return;
 activeEtiAnalysis=d.analysis||null;activeEtiAnalysisSymbol=sym;activeEtiAnalysisTimeframe=tf;
 if(!activeEtiAnalysis){renderAnalysisPlan({error:d.error});run();return;}
 run();renderAnalysisPlan(autoAnalysisLevels());
});
function lastPrice(){var t=$('last').textContent.replace(/,/g,'').trim(),v=Number(t);return isFinite(v)&&v>0?v:null;}
g('clUseLast').addEventListener('click',function(){var v=lastPrice();if(v===null){g('clSym').textContent='No live chart price yet: type the entry price manually.';return;}if(!g('clAutoAnalysis').checked){g('clEntry').value=v;run();}});
g('clReset').addEventListener('click',function(){g('clMarketMode').value='futures';g('clTargetMode').value='amount';g('clAutoAnalysis').checked=true;applyMarketMode();applyTargetMode();g('clSide').value='buy';g('clInst').value='crypto';applyPreset();['clEntry','clExit','clStop','clTp','clTpPct'].forEach(function(i){g(i).value='';});g('clSizeBy').value='quantity';g('clQty').value=1;g('clMargin').value=100;g('clFund').value=0;g('clMmr').value=0.5;g('clFx').value=1;setLev(10);run();});
/* Entry follows chart clicks: the chart ticket sets its price field first, then this listener copies it into the entry. */
if($('stack'))$('stack').addEventListener('click',function(){
 if(!g('clLink').checked||!$('ctPrice'))return;
 var v=Number($('ctPrice').value);
 if(isFinite(v)&&v>0&&!g('clAutoAnalysis').checked){g('clEntry').value=v;run();}
});
/* Place entry + protective exits through the dashboard's own order ticket and submitOrder (confirmation dialog included). */
function fire(id,type){var e=$(id);if(e)e.dispatchEvent(new Event(type,{bubbles:true}));}
function say(t,cls){var m=g('clPlaceMsg');m.className=cls||'clinfo';m.textContent=t;}
g('clPlace').addEventListener('click',function(){
 if(g('clMarketMode').value==='futures'){say('Futures order execution is not connected to this calculator. Use the dedicated futures order panel; this button only supports the existing spot paper/testnet order flow.','clerr');return;}
 var selectedVenue=$('orderBroker')?$('orderBroker').value:'eti_paper';if(selectedVenue==='bitget'){say('Calculator shortcut is disabled for Bitget Live to prevent accidental real-money orders. Use the main order ticket only after independently checking the calculated levels.','clerr');return;}
 if(g('clSide').value!=='buy'){say('Spot paper and testnet trading is long-only. Set Direction to Long, or keep this plan for reference.','clerr');return;}
 if(typeof submitOrder!=='function'||!$('orderType')||!$('orderQuantity')){say('The order panel is not available on this page.','clerr');return;}
 var mode=g('clMode').value,live=lastPrice(),entry=n('clEntry'),stop=n('clStop'),exit=n('clExit');
 if(mode==='market'){if(live===null){say('No live chart price yet: wait for the chart to load, or use a limit entry.','clerr');return;}entry=live;g('clEntry').value=entry;}
 if(entry===null||!(entry>0)){say('Enter the entry price first (or click the chart, or use the chart price).','clerr');return;}
 var r=computePosition(inputs());
 if(!r.ok){say('Fix the calculator first: '+(r.errors||[]).join(' | '),'clerr');return;}
 if(exit===null&&r.priceForTargetProfit!==null){exit=r.priceForTargetProfit;g('clExit').value=exit;}
 var units=Math.floor(r.units*1e6)/1e6;
 if(!(units>0)){say('The position size rounds to zero. Increase the quantity or margin.','clerr');return;}
 if(stop!==null&&!(stop<entry)){say('For a long, the stop must be below the entry price.','clerr');return;}
 if(exit!==null&&!(exit>entry)){say('For a long, the target must be above the entry price.','clerr');return;}
 $('orderSymbol').value=$('symbol').value;
 $('orderType').value=mode==='limit'?'limit':'market';fire('orderType','change');
 if($('orderLimitPrice')){$('orderLimitPrice').value=mode==='limit'?entry:'';fire('orderLimitPrice','input');}
 $('orderQuantity').value=units;fire('orderQuantity','input');
 var pl={planStop:stop,planTp1:exit,planTp2:null,planTp3:null};
 Object.keys(pl).forEach(function(k){if($(k))$(k).value=pl[k]===null?'':pl[k];});
 var venue=selectedVenue;
 var lev=n('clLev');
 say('Order ticket filled from this calculation: BUY '+px(units)+' '+$('symbol').value+(mode==='limit'?' limit at '+px(entry)+' (fills automatically when the market reaches it)':' at market (about '+px(entry)+')')+(stop!==null?', stop '+px(stop):'')+(exit!==null?', target '+px(exit):'')+'. Venue: '+venue+'. '+(lev&&lev>1?'Spot orders are unleveraged: this buys the full '+money(units*entry)+' of notional. ':'')+'Confirm in the dialog to submit.','clok');
 submitOrder('buy');
});
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
applyMarketMode();applyTargetMode();setLev(g('clLev').value);run();symInfo();
})();
` + CHART_LAYOUT_JS;
