/**
 * Dashboard Wallet section (paper wallet). Injected into the dashboard HTML by worker/wallet/inject.ts, and kept free of
 * backticks, dollar-brace sequences and backslashes so it can also be interpolated into a template literal.
 * Reads /api/portfolio/state (the persistent ledger), starting an automatic paper session first when none exists.
 * Nothing is invented: unavailable storage, a failed session or stale prices are shown as such. On-chain wallets need the ETI backend.
 */
export const WALLET_CSS = `
.wl{margin-top:14px}.wl h2{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.wlk{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:8px 0}
.wlk div{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#0b1422}.wlk small{display:block;color:var(--muted);font-size:11px}.wlk b{font-size:18px}
.wl .pos{color:#21d69a}.wl .neg{color:#ff637d}.wlmsg{border:1px solid var(--line);color:var(--muted);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:12px}
.wlmsg.warn{border-color:#b65c38;color:#ffb08c}.wl table{width:100%;border-collapse:collapse;font-size:12px}.wl th,.wl td{text-align:left;padding:6px 8px;border-bottom:1px solid #1d2a3e}.wl th{color:var(--muted)}
`;

export const WALLET_HTML = `
<section class="panel wl" id="walletPanel" aria-label="Wallet">
<h2><span>Wallet</span><span><span class="muted" id="wlMeta">Loading…</span> <button id="wlReload" type="button">Reload</button></span></h2>
<div id="wlMsg" class="wlmsg">Loading the paper wallet…</div>
<div class="wlk" id="wlKpis"></div>
<div style="overflow-x:auto"><table><thead><tr><th>Asset / position</th><th>Quantity</th><th>Entry</th><th>Mark</th><th>Unrealized P/L</th></tr></thead><tbody id="wlRows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div>
<div class="wlmsg" style="margin-top:8px">Simulated paper wallet: no real funds are held or moved. On-chain wallets and balances come from the ETI backend (needs CHAIN_ENABLED) and are not shown here. Withdrawals are never enabled.</div>
</section>
`;

export const WALLET_JS = `
function wlNum(v){return typeof v==='number'&&isFinite(v)}
function wlFmt(v,d){return wlNum(v)?v.toLocaleString(undefined,{maximumFractionDigits:d==null?2:d}):'n/a'}
function wlEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function wlCls(v){return wlNum(v)?(v>=0?'pos':'neg'):''}
function wlKpi(l,v,c){return '<div><small>'+wlEsc(l)+'</small><b class="'+(c||'')+'">'+wlEsc(v)+'</b></div>'}
async function wlFetchState(){
  var u='/api/portfolio/state?environment=internal_paper';
  var r=await fetch(u,{credentials:'same-origin',cache:'no-store'});
  if(r.status===401){
    var s=await fetch('/api/auth/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'paper'})});
    if(!s.ok)throw new Error('could not start a paper session (HTTP '+s.status+')');
    r=await fetch(u,{credentials:'same-origin',cache:'no-store'});
  }
  var d=await r.json().catch(function(){return {}});
  if(!r.ok)throw new Error(d.message||d.error||('HTTP '+r.status));
  return d;
}
async function walletLoad(){
  var m=document.getElementById('wlMsg');
  try{
    var d=await wlFetchState();
    if(d.unavailable||d.disabled){m.className='wlmsg warn';m.textContent=d.message||'Wallet unavailable.';return}
    var b=d.balances||{},p=d.pnl||{},cur=b.currency||'USDT';
    m.className='wlmsg';m.textContent=(d.label||'Paper wallet')+(d.marksStale&&d.marksStale.length?' - stale prices for: '+d.marksStale.join(', '):' - prices current');
    document.getElementById('wlMeta').textContent='Updated '+new Date(d.serverTime||Date.now()).toLocaleTimeString();
    document.getElementById('wlKpis').innerHTML=wlKpi('Equity ('+cur+')',wlFmt(b.equity))+wlKpi('Cash',wlFmt(b.cash))+wlKpi('Available',wlFmt(b.available))+wlKpi('In orders',wlFmt(b.reservedForOrders))+wlKpi('Position value',wlFmt(b.positionValue))+wlKpi('Unrealized P/L',wlFmt(p.unrealized),wlCls(p.unrealized))+wlKpi('Realized P/L (net)',wlFmt(p.realizedNet),wlCls(p.realizedNet))+wlKpi('Starting balance',wlFmt(b.starting));
    var rows=(d.positions||[]).map(function(x){return '<tr><td>'+wlEsc(x.symbol)+'</td><td>'+wlFmt(x.qty,6)+'</td><td>'+wlFmt(x.entryPrice||x.avgPrice,4)+'</td><td>'+(wlNum(x.markPrice)?wlFmt(x.markPrice,4):'stale')+'</td><td class="'+wlCls(x.unrealized)+'">'+wlFmt(x.unrealized)+'</td></tr>'}).join('');
    var cash='<tr><td>'+wlEsc(cur)+' (cash)</td><td>'+wlFmt(b.cash,4)+'</td><td></td><td></td><td></td></tr>';
    document.getElementById('wlRows').innerHTML=cash+rows;
  }catch(e){m.className='wlmsg warn';m.textContent='Wallet unavailable: '+(e&&e.message?e.message:'network error')}
}
function walletInit(){var b=document.getElementById('wlReload');if(b)b.onclick=walletLoad;walletLoad();setInterval(walletLoad,30000)}
`;
