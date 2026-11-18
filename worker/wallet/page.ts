/**
 * ETI Wallet page (/wallet), served by the Worker so it shows even when no FastAPI backend (BACKEND_URL) is configured.
 * It shows the paper (simulated) wallet from /api/portfolio/state after starting an automatic paper session.
 * Nothing is invented: when storage is unbound, the session fails or a price is stale the page says so.
 * On-chain wallets, balances and withdrawals belong to the ETI backend and are not shown here.
 * NOTE: this HTML lives in a template literal. Keep the embedded script free of backticks, dollar-brace sequences and backslashes.
 */
const CSS = `
:root{color-scheme:dark;--bg:#020817;--ok:#00f59b;--bad:#ff365d;--warn:#ffc247;--txt:#eaf5ff;--mut:#91a9c4;--line:#11658d}
*{box-sizing:border-box}body{margin:0;background:#041329;color:var(--txt);font:14px/1.5 Inter,system-ui,sans-serif}
a{color:#00e5ff;text-decoration:none}main{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
nav{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:16px}h1{margin:0 0 4px;font-size:22px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:14px 0}
.card{border:1px solid var(--line);border-radius:14px;padding:14px;background:#061a30}.card small{display:block;color:var(--mut)}.card b{font-size:22px}
.up{color:var(--ok)}.dn{color:var(--bad)}.mut{color:var(--mut)}.note{border:1px dashed rgba(255,194,71,.6);color:var(--warn);border-radius:10px;padding:10px;margin:10px 0}
table{width:100%;border-collapse:collapse}th,td{padding:7px 5px;border-bottom:1px solid #153047;text-align:left;font-size:13px}th{color:var(--mut)}.scroll{overflow-x:auto}
button{background:#081d37;color:var(--txt);border:1px solid #102f50;border-radius:8px;padding:6px 12px;cursor:pointer}
`;

const BODY = `
<main>
<nav><a href="/">Dashboard</a><a href="/command">Command Centre</a><a href="/pro">ETI Pro</a><a href="/wallet"><b>Wallet</b></a><a href="/wallet/chain">On-chain wallet</a></nav>
<h1>Wallet</h1>
<div class="mut">Paper (simulated) wallet. No real funds are held or moved from this page.</div>
<div id="status" class="note">Loading wallet...</div>
<div class="grid" id="kpis"></div>
<div class="card"><b>Open positions</b><div class="scroll"><table><thead><tr><th>Symbol</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Unrealized</th></tr></thead><tbody id="pos"><tr><td colspan="5" class="mut">Loading...</td></tr></tbody></table></div></div>
<div class="note" style="margin-top:14px">The on-chain wallet, its native coin balances and live node status are on <a href="/wallet/chain">/wallet/chain</a>. Node data is read directly from the blockchain; the wallet itself lives in the ETI backend (/api/chain) and needs CHAIN_ENABLED and a configured backend. Withdrawals are never enabled here.</div>
<p><button id="reload">Reload</button></p>
</main>
`;

const SCRIPT = `
(function(){
function $(i){return document.getElementById(i)}
function num(v){return typeof v==='number'&&isFinite(v)}
function fmt(v,d){return num(v)?v.toLocaleString(undefined,{maximumFractionDigits:d==null?2:d}):'n/a'}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function kpi(l,v,cls){return '<div class="card"><small>'+esc(l)+'</small><b class="'+(cls||'')+'">'+esc(v)+'</b></div>'}
function sign(v){return num(v)?(v>=0?'up':'dn'):'mut'}
async function load(){
  var st=$('status');st.textContent='Loading wallet...';
  try{
    var s=await fetch('/api/auth/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'paper'})});
    if(!s.ok){st.textContent='Could not start a paper session (HTTP '+s.status+'). Open the dashboard once, or check that execution authorisation is configured.';return}
    var r=await fetch('/api/portfolio/state?environment=internal_paper',{credentials:'same-origin',cache:'no-store'});
    var d=await r.json().catch(function(){return {}});
    if(!r.ok){st.textContent='Wallet unavailable: '+(d.message||d.error||('HTTP '+r.status));return}
    if(d.unavailable||d.disabled){st.textContent=d.message||'Wallet unavailable.';return}
    var b=d.balances||{},p=d.pnl||{},cur=b.currency||'USDT';
    st.className='mut';st.textContent=(d.label||'Paper')+' - updated '+new Date(d.serverTime||Date.now()).toLocaleTimeString()+(d.marksStale&&d.marksStale.length?' - stale prices: '+d.marksStale.join(', '):'');
    $('kpis').innerHTML=kpi('Equity ('+cur+')',fmt(b.equity))+kpi('Cash',fmt(b.cash))+kpi('Available',fmt(b.available))+kpi('Position value',fmt(b.positionValue))+kpi('Unrealized P/L',fmt(p.unrealized),sign(p.unrealized))+kpi('Realized P/L (net)',fmt(p.realizedNet),sign(p.realizedNet))+kpi('Starting balance',fmt(b.starting));
    var rows=(d.positions||[]).map(function(x){return '<tr><td>'+esc(x.symbol)+'</td><td>'+fmt(x.qty,6)+'</td><td>'+fmt(x.entryPrice||x.avgPrice,4)+'</td><td>'+(num(x.markPrice)?fmt(x.markPrice,4):'stale')+'</td><td class="'+sign(x.unrealized)+'">'+fmt(x.unrealized)+'</td></tr>'}).join('');
    $('pos').innerHTML=rows||'<tr><td colspan="5" class="mut">No open positions.</td></tr>';
  }catch(e){st.textContent='Wallet request failed: '+(e&&e.message?e.message:'network error')}
}
$('reload').onclick=load;load();
})();
`;

export function walletPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Wallet</title><style>${CSS}</style></head><body>${BODY}<script>${SCRIPT}</script></body></html>`;
}
