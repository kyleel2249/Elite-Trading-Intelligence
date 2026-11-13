/**
 * Dashboard fragments for Binance USDT-M futures orders: leverage and reduce-only controls, estimate preview, a positions / orders /
 * closed-trades panel and balances. Interpolated into the dashboard template literal in worker/index.ts, so these strings must contain
 * no backticks, no dollar-brace sequences and no backslashes. Everything shown is read from /api/perp/state; nothing is invented here.
 */
export const PERP_CSS = `
body:not(.perpmode) .perponly{display:none!important}.perpmode .perponly{display:flex}.perpmode .spotonly{display:none!important}
.perp{margin-top:14px;display:none}.perpmode .perp{display:block}.perpmode #portfolioPanel{display:none}
.perp h2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.perp h3{font-size:13px;margin:16px 0 8px}
.perp .pfwrap{overflow-x:auto;border:1px solid #1d2a3e;border-radius:10px}.perp table{width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap}
.perp th{color:var(--muted);text-align:left;font-weight:600;padding:7px 9px;border-bottom:1px solid #1d2a3e}.perp td{padding:7px 9px;border-bottom:1px solid #121c2c}
.perp .pos{color:#21d69a}.perp .neg{color:#ff637d}.perp .empty{padding:14px;color:var(--muted);text-align:center}
.perp button.mini{padding:2px 9px;font-size:11px;border-radius:6px}.perp button.danger{border-color:#7c2f3d;color:#ff9aab}
.perp .pfkpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:6px 0 10px}.perp .pfkpi{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#0b1422}
.perp .pfkpi span{display:block;font-size:11px;color:var(--muted)}.perp .pfkpi b{font-size:15px}
.perp .pfnote{border:1px solid #b65c38;color:#ffb08c;border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}.perp .pfinfo{border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}
.perpchk{align-items:center;gap:8px;flex-direction:row}.perpchk input{width:auto}
`;

export const PERP_ORDER_HTML = `
<label class="perponly">Leverage (x)<input id="perpLeverage" type="number" min="1" max="125" step="1" value="5" inputmode="numeric"></label>
<label class="perponly perpchk"><input id="perpReduce" type="checkbox">Reduce-only (never opens or flips)</label>
<div class="perponly pfinfo" style="grid-column:1/-1">Futures: USDT-margined, isolated margin, one-way mode. Leverage sets margin, not size. Buy opens or adds a long, Sell opens or adds a short; an opposite order reduces first. Liquidation can lose the whole position margin.</div>
`;

export const PERP_HTML = `
<section class="panel perp" id="perpPanel" aria-label="Futures positions and orders">
<h2><span>Futures: Positions, Orders and P&amp;L</span><span id="perpStatus" class="meta" role="status">Connecting…</span></h2>
<div id="perpNotes"></div>
<div id="perpKpis" class="pfkpis"></div>
<h3>Open positions</h3><div class="pfwrap" id="perpPositions"><div class="empty">Loading…</div></div>
<h3>Open orders</h3><div class="pfwrap" id="perpOrders"><div class="empty">Loading…</div></div>
<h3>Closed trades</h3><div class="pfwrap" id="perpClosed"><div class="empty">Loading…</div></div>
</section>
`;

export const PERP_JS = `
const perp={timer:null,seq:0,last:null};
function perpOn(){return symMkt()==='futures';}
function perpEnv(){return $('orderBroker').value==='binance'?'perp_testnet':'perp_paper';}
function perpNum(v,d){return typeof v==='number'&&isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:d==null?2:d}):'-';}
function perpCls(v){return typeof v==='number'?(v>0?'pos':v<0?'neg':''):'';}
function perpApplyMode(){
 const on=perpOn();document.body.classList.toggle('perpmode',on);
 $('buyOrder').textContent=on?'Buy / Long':'Buy';$('sellOrder').textContent=on?'Sell / Short':'Sell';
 const stop=Array.prototype.find.call($('orderType').options,o=>o.value==='stop');if(stop)stop.textContent=on?'Stop-market (trigger, Internal Paper)':'Stop-loss (sell, Internal Paper)';
 $('stopPriceWrap').style.display=$('orderType').value==='stop'?'flex':'none';
 if(on){const av=Array.prototype.find.call($('orderBroker').options,o=>o.value==='alpaca');if(av&&$('orderBroker').value==='alpaca')$('orderBroker').value='eti_paper';if(av)av.disabled=true;}
 else{const av=Array.prototype.find.call($('orderBroker').options,o=>o.value==='alpaca');if(av)av.disabled=false;}
 const fn=$('rdFutNote');if(fn)fn.hidden=!on;
 clearTimeout(perp.timer);if(on)perpLoad();
}
function perpBody(side){
 const o=selectedOrder(),b={environment:perpEnv(),symbol:o.symbol,side:side,type:o.type,quantity:o.quantity,leverage:Number($('perpLeverage').value),reduceOnly:$('perpReduce').checked};
 if(o.type==='limit')b.limitPrice=o.limitPrice;if(o.type==='stop')b.stopPrice=o.stopPrice;return b;
}
function perpProblem(side){
 const b=perpBody(side);
 if(!/^[A-Z0-9]{3,24}$/.test(b.symbol))return 'Enter a valid futures symbol such as BTCUSDT.';
 if(!isFinite(b.quantity)||b.quantity<=0)return 'Enter a quantity greater than zero.';
 if(!isFinite(b.leverage)||b.leverage<1||b.leverage!==Math.floor(b.leverage))return 'Leverage must be a whole number of at least 1.';
 if(b.type==='limit'&&!(b.limitPrice>0))return 'Enter a valid limit price.';
 if(b.type==='stop'&&!(b.stopPrice>0))return 'Enter a valid stop price.';
 if($('orderBroker').value==='alpaca')return 'Alpaca has no futures. Choose ETI Internal Paper or Binance testnet.';
 if(b.type==='stop'&&perpEnv()==='perp_testnet')return 'Stop orders are not supported on the futures testnet here. Use ETI Internal Paper, or a limit or market order.';
 return '';
}
async function perpPost(path,body){
 const headers={'content-type':'application/json'};if($('executionToken').value)headers.Authorization='Bearer '+$('executionToken').value;
 const send=()=>fetch(path,{method:'POST',credentials:'same-origin',headers:headers,body:JSON.stringify(body)});
 let r=await send();if(r.status===401&&!$('executionToken').value){await startSessions();r=await send();}
 return {r:r,d:await r.json().catch(()=>({}))};
}
function perpEstimateText(e){
 if(!e)return '';const q=[];
 q.push('fill ~'+perpNum(e.fillPrice,4));q.push('notional '+perpNum(e.notional));if(e.margin!=null)q.push('margin '+perpNum(e.margin));if(e.fee!=null)q.push('fee ~'+perpNum(e.fee,4));
 if(e.liqPrice!=null)q.push('liquidation ~'+perpNum(e.liqPrice,4));if(e.available!=null)q.push('available '+perpNum(e.available));return q.join(' | ');
}
async function perpPreview(side){
 const problem=perpProblem(side);if(problem){$('orderOutput').textContent=problem;return;}
 $('orderOutput').textContent='Estimating…';
 try{const x=await perpPost('/api/perp/preview',perpBody(side));
  if(!x.r.ok){$('orderOutput').textContent='Cannot preview: '+(x.d.message||x.d.error||('HTTP '+x.r.status));return;}
  $('orderOutput').textContent='FUTURES ORDER PREVIEW ('+x.d.environment+') | '+(x.d.order.direction.toUpperCase())+' '+x.d.order.quantity+' '+x.d.order.symbol+' x'+x.d.order.leverage+' '+x.d.order.type+(x.d.order.reduceOnly?' reduce-only':'')+' | '+perpEstimateText(x.d.estimate)+' | '+x.d.note;
 }catch(e){$('orderOutput').textContent='Preview failed: '+e.message;}
}
async function perpSubmit(side){
 const problem=perpProblem(side);if(problem){$('orderOutput').textContent=problem;return;}
 if(executionStatus&&executionStatus.kill_switch&&!$('perpReduce').checked){$('orderOutput').textContent='Execution blocked: emergency kill switch is active (reduce-only orders still work).';return;}
 const b=perpBody(side),venue=b.environment==='perp_testnet'?'BINANCE FUTURES TESTNET':'INTERNAL PAPER, SIMULATED';
 if(!window.confirm('FINAL FUTURES ORDER CONFIRMATION |  | '+(side==='buy'?'BUY / LONG ':'SELL / SHORT ')+b.quantity+' '+b.symbol+' x'+b.leverage+' ('+venue+', '+b.type.toUpperCase()+(b.reduceOnly?', REDUCE-ONLY':'')+') |  | Leveraged positions can be liquidated. No real money is used. Continue?'))return;
 b.clientOrderId='eti'+crypto.randomUUID().replace(/-/g,'').slice(0,29);
 $('orderOutput').textContent='Submitting futures order…';
 try{const x=await perpPost('/api/perp/order',b);
  if(x.r.ok){const o=x.d.order;$('orderOutput').textContent=(x.d.filledNow?'FILLED: ':'ACCEPTED (resting): ')+o.side.toUpperCase()+' '+o.qty+' '+o.symbol+(o.avgFillPrice?' @ '+perpNum(o.avgFillPrice,4):'')+' | '+perpEstimateText(x.d.estimate)+' | order '+o.orderId;}
  else $('orderOutput').textContent='NOT EXECUTED: '+(x.d.message||x.d.error||('HTTP '+x.r.status))+(x.d.estimate?' | '+perpEstimateText(x.d.estimate):'');
 }catch(e){$('orderOutput').textContent='Order submission failed before a response was received: '+e.message;}
 perpLoad();
}
async function perpAct(path,body,label){
 try{const x=await perpPost(path,Object.assign({environment:perpEnv()},body));
  $('orderOutput').textContent=x.r.ok?label+' done.':label+' failed: '+(x.d.message||x.d.error||('HTTP '+x.r.status));
 }catch(e){$('orderOutput').textContent=label+' failed: '+e.message;}
 perpLoad();
}
function perpRender(s){
 const notes=[];perp.last=s;
 $('perpStatus').textContent=(s.label||'')+(s.serverTime?' | updated '+new Date(s.serverTime).toLocaleTimeString():'');
 if(s.unavailable){$('perpNotes').innerHTML='<div class="pfnote">'+esc(s.message||'Unavailable')+'</div>';$('perpKpis').innerHTML='';['perpPositions','perpOrders','perpClosed'].forEach(id=>{$(id).innerHTML='<div class="empty">No data.</div>';});return;}
 if(s.simulated)notes.push('<div class="pfinfo">'+esc(s.source)+'</div>');
 (s.alerts||[]).forEach(a=>notes.push('<div class="pfnote">'+esc(a.message)+'</div>'));
 if(s.marksStale&&s.marksStale.length)notes.push('<div class="pfnote">Live price unavailable for '+esc(s.marksStale.join(', '))+': P&amp;L and liquidation distance are not shown for those positions.</div>');
 if(s.balanceSource&&String(s.balanceSource).indexOf('unavailable')===0)notes.push('<div class="pfnote">Exchange balance unavailable ('+esc(s.balanceSource)+').</div>');
 (s.anomalies||[]).slice(-3).forEach(a=>notes.push('<div class="pfnote">Ledger notice: '+esc(a.kind)+' '+esc(a.detail||'')+'</div>'));
 $('perpNotes').innerHTML=notes.join('');
 const b=s.balances||{},k=(l,v,c)=>'<div class="pfkpi"><span>'+l+'</span><b class="'+(c||'')+'">'+v+'</b></div>';
 $('perpKpis').innerHTML=k('Wallet ('+esc(b.currency||'USDT')+')',perpNum(b.wallet))+k('Available',perpNum(b.available))+k('Position margin',perpNum(b.positionMargin))+k('Order margin',perpNum(b.orderMargin))+k('Unrealized P&amp;L',perpNum(b.unrealized),perpCls(b.unrealized))+k('Equity',perpNum(b.equity))+k('Exposure',perpNum(b.exposure))+k('Realized net',perpNum(s.pnl&&s.pnl.realizedNet),perpCls(s.pnl&&s.pnl.realizedNet))+(s.pnl&&s.pnl.total!=null?k('Total P&amp;L',perpNum(s.pnl.total),perpCls(s.pnl.total)):'');
 const P=s.positions||[];
 $('perpPositions').innerHTML=P.length?'<table><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Lev</th><th>Margin</th><th>Liq. price</th><th>Liq. dist.</th><th>Unrealized</th><th>ROE %</th><th></th></tr>'+P.map(p=>'<tr><td>'+esc(p.symbol)+'</td><td class="'+(p.side==='long'?'pos':'neg')+'">'+esc(p.side.toUpperCase())+'</td><td>'+perpNum(p.qty,6)+'</td><td>'+perpNum(p.avgEntry,4)+'</td><td>'+(p.markPrice==null?'stale':perpNum(p.markPrice,4))+'</td><td>'+p.leverage+'x</td><td>'+perpNum(p.margin)+'</td><td>'+perpNum(p.liqPrice,4)+'</td><td>'+(p.liqDistancePct==null?'-':perpNum(p.liqDistancePct)+'%')+'</td><td class="'+perpCls(p.unrealized)+'">'+perpNum(p.unrealized)+'</td><td class="'+perpCls(p.roePct)+'">'+perpNum(p.roePct)+'</td><td><button class="mini danger" data-close="'+esc(p.symbol)+'">Close</button></td></tr>').join('')+'</table>':'<div class="empty">No open futures positions.</div>';
 const O=(s.openOrders||[]);
 $('perpOrders').innerHTML=O.length?'<table><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Lev</th><th>Flags</th><th>Status</th><th></th></tr>'+O.map(o=>'<tr><td>'+esc(o.symbol)+'</td><td class="'+(o.side==='buy'?'pos':'neg')+'">'+esc(o.side.toUpperCase())+'</td><td>'+esc(o.type)+'</td><td>'+perpNum(o.qty-o.filledQty,6)+'</td><td>'+perpNum(o.limitPrice!=null?o.limitPrice:o.stopPrice,4)+'</td><td>'+o.leverage+'x</td><td>'+(o.reduceOnly?'reduce-only':'')+'</td><td>'+esc(o.status)+'</td><td><button class="mini danger" data-cancel="'+esc(o.orderId)+'">Cancel</button></td></tr>').join('')+'</table>':'<div class="empty">No open futures orders.</div>';
 const C=(s.closed||[]).slice(0,25);
 $('perpClosed').innerHTML=C.length?'<table><tr><th>Closed (UTC)</th><th>Symbol</th><th>Dir.</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Fees</th><th>Net P&amp;L</th><th>Result</th></tr>'+C.map(t=>'<tr><td>'+esc(new Date(t.exitAt).toISOString().replace('T',' ').slice(0,19))+'</td><td>'+esc(t.symbol)+'</td><td>'+esc(t.direction)+'</td><td>'+perpNum(t.qty,6)+'</td><td>'+perpNum(t.entryPrice,4)+'</td><td>'+perpNum(t.exitPrice,4)+'</td><td>'+perpNum(t.fees,4)+'</td><td class="'+perpCls(t.net)+'">'+perpNum(t.net)+'</td><td>'+(t.liquidated?'LIQUIDATED':esc(t.result))+'</td></tr>').join('')+'</table>':'<div class="empty">No closed futures trades yet.</div>';
}
async function perpLoad(){
 clearTimeout(perp.timer);if(!perpOn())return;const seq=++perp.seq;
 try{
  const r=await fetch('/api/perp/state?environment='+perpEnv(),{credentials:'same-origin',headers:$('executionToken').value?{Authorization:'Bearer '+$('executionToken').value}:{},cache:'no-store'}),d=await r.json();
  if(seq!==perp.seq)return;
  if(!r.ok){$('perpStatus').textContent='Unavailable';$('perpNotes').innerHTML='<div class="pfnote">'+esc(d.message||d.error||('HTTP '+r.status))+'</div>';}
  else perpRender(d);
 }catch(e){if(seq===perp.seq){$('perpStatus').textContent='Unreachable';$('perpNotes').innerHTML='<div class="pfnote">Futures state unavailable: '+esc(e.message)+'</div>';}}
 if(perpOn())perp.timer=setTimeout(perpLoad,document.hidden?30000:6000);
}
$('perpPanel').addEventListener('click',e=>{
 const c=e.target.closest('[data-close]'),x=e.target.closest('[data-cancel]');
 if(c){const sym=c.getAttribute('data-close');if(window.confirm('Close the whole '+sym+' position at market (reduce-only)?'))perpAct('/api/perp/close',{symbol:sym},'Close '+sym);}
 if(x)perpAct('/api/perp/cancel',{orderId:x.getAttribute('data-cancel')},'Cancel order');
});
`;
