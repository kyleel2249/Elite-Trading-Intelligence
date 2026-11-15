/**
  * /wallet/chain: ETI on-chain wallet dashboard. Two independent live reads of the blockchain:
 *  1. the Worker queries the node over JSON-RPC (/api/chain-view/native) for chain id, block height, gas and the native coin balance;
 *  2. the backend wallet (/api/chain/*, proxied through BACKEND_URL) supplies the address, tokens, transactions and limits.
 * Nothing here is a demo figure: every value comes from a node or the backend and shows a dash plus the reason when unavailable.
 * Read-only apart from creating the wallet and building a transfer preview. The page cannot sign or send anything.
 * Rendered with textContent only (no HTML injection); no template interpolation in the script.
 */
import { withMotion } from "../ui/motion.ts";

const BODY = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>ETI Wallet</title>
<style>
:root{--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--green:#21d69a;--red:#ff637d;--blue:#56a8ff;--amber:#ffc247}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 55%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}
header{padding:18px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:22px;margin:0}
main{padding:20px 4vw 48px;max-width:1500px;margin:auto}a{color:var(--blue);text-decoration:none}small,.mut{color:var(--muted)}.ok{color:var(--green)}.bad{color:var(--red)}.warn{color:var(--amber)}
nav a{margin-left:14px;font-size:13px}
.panel{border:1px solid var(--line);border-radius:14px;padding:16px;background:var(--panel);min-width:0;margin-bottom:16px}
h2{font-size:15px;margin:0 0 12px}h2 small{font-weight:400;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.tile{border:1px solid var(--line);border-radius:12px;padding:14px;background:rgba(8,13,22,.55);min-width:0}
.tile .net{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;gap:8px}.tile .coin{font-size:26px;font-weight:800;margin:8px 0 2px;overflow-wrap:anywhere}.tile .sym{font-size:13px;color:var(--muted);font-weight:600;margin-left:6px}
.tile .kv{font-size:12px;color:var(--muted);display:flex;justify-content:space-between;margin-top:4px;gap:8px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#52627a;margin-right:6px}.dot.on{background:var(--green);box-shadow:0 0 8px var(--green)}.dot.off{background:var(--red)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
input,select{background:#0c1626;border:1px solid var(--line);color:#eaf2ff;border-radius:8px;padding:8px 10px;font:inherit;min-width:0}input.addr{flex:1;min-width:260px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
button{background:#12335a;border:1px solid #2b5c98;color:#eaf2ff;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}
.addr-box{font-family:ui-monospace,Menlo,monospace;font-size:13px;overflow-wrap:anywhere;background:#0c1626;border:1px solid var(--line);border-radius:8px;padding:10px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:6px 8px;border-bottom:1px solid #1b2a40;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{color:var(--muted);font-weight:600}
.scroll{overflow-x:auto}.note{font-size:12px;color:var(--muted);margin-top:8px}.empty{color:var(--muted);padding:6px 0}.err{color:var(--red);font-size:12px}
.pill{display:inline-block;border:1px solid var(--line);border-radius:20px;padding:3px 10px;font-size:11px;margin-left:6px}
@media(max-width:600px){header{padding:14px 16px}main{padding:16px}input.addr{min-width:100%}}
</style></head><body>
<header><div><h1>ETI <span style="color:var(--blue)">Wallet</span></h1><small>On-chain wallet, native coin balances and live node status. Read-only: this page cannot sign or send.</small></div>
<nav><a href="/">Dashboard</a><a href="/elite">Elite UI</a><a href="/journal">Trade Journal</a><a href="/wallet">Paper wallet</a><a href="/wallet/chain" aria-current="page">On-chain wallet</a></nav></header>
<main>
<section class="panel" id="pWallet"><h2>ETI wallet <small id="wMeta"></small></h2>
 <div class="row"><input id="apiKey" type="password" autocomplete="off" placeholder="ETI API key (only if the backend enforces one; kept in memory)" style="min-width:260px;flex:1"><button id="btnLoad">Load wallet</button><button id="btnCreate" disabled>Create wallet</button></div>
 <div id="wBody"><div class="empty">Loading the wallet from the backend…</div></div></section>
<section class="panel"><h2>Native coin by network <small id="nMeta">live from the nodes over JSON-RPC</small></h2><div id="tiles" class="grid"></div>
 <div class="note" id="nNote"></div></section>
<section class="panel"><h2>Check any address <small>native coin balance read straight from the chain</small></h2>
 <div class="row"><input id="watch" class="addr" placeholder="0x… address" spellcheck="false" autocomplete="off"><button id="btnWatch">Look up</button></div><div id="watchOut" class="grid"></div></section>
<section class="panel"><h2>Tokens <small>allowlisted tokens only</small></h2>
 <div class="row"><select id="tokNet" aria-label="Network"></select><button id="btnTok">Load token balances</button></div><div id="tokOut" class="scroll"></div></section>
<section class="panel"><h2>Transfer preview <small>builds and checks a quote against the spending policy; nothing is signed or sent</small></h2>
 <div class="row"><select id="trNet" aria-label="Network"></select><input id="trTo" class="addr" placeholder="Destination 0x… (must be allowlisted)" spellcheck="false"><input id="trAmt" placeholder="Amount" style="width:120px" inputmode="decimal"><button id="btnPrev" disabled>Preview</button></div><div id="trOut"></div></section>
<section class="panel"><h2>Transactions <small id="txMeta"></small></h2><div id="txOut" class="scroll"><div class="empty">—</div></div>
 <div class="row" style="margin-top:8px"><button id="btnTx" disabled>Refresh pending</button></div></section>
<section class="panel"><h2>Limits and safety</h2><div id="limits" class="empty">—</div>
 <div class="note">Testnets only unless the operator explicitly enables mainnet sending (CHAIN_MAINNET_SEND_ENABLED). The private key never leaves the server and there is no endpoint that returns it. A broadcast is not a confirmation until a receipt says so.</div></section>
</main>
<script>
var $=function(id){return document.getElementById(id)};
var ST={wallet:null,backend:false,nets:[],key:''};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=String(text);return e;}
function clear(n){while(n.firstChild)n.removeChild(n.firstChild);}
function short(a){return a&&a.length>14?a.slice(0,8)+'…'+a.slice(-6):(a||'—');}
function hdr(extra){var h={};if(ST.key)h['X-API-Key']=ST.key;if(extra)for(var k in extra)h[k]=extra[k];return h;}
function safeLink(href,text){var a=el('a','',text);if(/^https:\\/\\/[A-Za-z0-9.-]+(\\/[A-Za-z0-9._\\/?=&%#:-]*)?$/.test(href)){a.href=href;a.target='_blank';a.rel='noopener noreferrer';}return a;}
async function getJson(path,opt){
  var r=await fetch(path,Object.assign({cache:'no-store',credentials:'same-origin'},opt||{}));
  var t=await r.text(),j=null;try{j=JSON.parse(t);}catch(e){}
  return {status:r.status,ok:r.ok,json:j};
}
function why(res){
  var d=res.json&&(res.json.detail!=null?res.json.detail:res.json.message||res.json.error);
  if(res.status===401||res.status===403)return 'The backend requires the ETI API key (enter it above).';
  if(res.json&&res.json.error==='backend_not_configured')return 'The wallet backend is not connected: set BACKEND_URL on the Worker to the Python backend origin (docs/CHAIN.md).';
  if(res.json&&res.json.error==='backend_invalid')return 'BACKEND_URL is set but invalid: it must be an https origin with no path.';
  if(res.json&&res.json.error==='backend_timeout')return 'The wallet backend is too slow to answer right now.';
  if(res.status===404&&!(res.json&&res.json.detail))return 'The wallet backend does not serve /api/chain (is it the ETI backend?).';
  if(res.status===502)return 'The wallet backend is unreachable right now.';
  if(res.status===503)return typeof d==='string'?d:'The on-chain wallet is disabled on the backend (CHAIN_ENABLED=false).';
  return typeof d==='string'?d:('HTTP '+res.status);
}
function tile(s){
  var t=el('div','tile'),top=el('div','net');
  var l=el('span','',s.label),st=el('span','');var dot=el('span','dot '+(s.connected?'on':(s.configured?'off':'')));st.appendChild(dot);st.appendChild(document.createTextNode(s.connected?'connected':(s.configured?'unreachable':'not configured')));
  top.appendChild(l);top.appendChild(st);t.appendChild(top);
  var coin=el('div','coin',s.balance!=null?s.balance:'—');coin.appendChild(el('span','sym',s.native));t.appendChild(coin);
  if(s.balance==null)t.appendChild(el('div','mut',s.address?'balance unavailable':'no address selected'));
  function kv(k,v){var r=el('div','kv');r.appendChild(el('span','',k));r.appendChild(el('span','',v));t.appendChild(r);}
  kv('Chain id',s.chainId);kv('Block',s.block!=null?s.block.toLocaleString():'—');kv('Gas price',s.gasPriceGwei!=null?s.gasPriceGwei.toFixed(3)+' gwei':'—');
  kv('Type',s.mainnet?'mainnet':'testnet');
  if(s.address){var r=el('div','kv');r.appendChild(el('span','','Address'));r.appendChild(safeLink(s.explorer+'/address/'+s.address,short(s.address)));t.appendChild(r);}
  if(s.error)t.appendChild(el('div','err',s.error));else if(s.note)t.appendChild(el('div','note',s.note));
  return t;
}
function fillSelects(){
  ['tokNet','trNet'].forEach(function(id){var s=$(id);clear(s);ST.nets.forEach(function(n){if(!n.configured)return;var o=el('option','',n.label);o.value=n.key;s.appendChild(o);});});
}
async function loadNetworks(){
  var r=await getJson('/api/chain-view/networks');
  if(r.ok&&r.json){ST.nets=r.json.networks||[];fillSelects();}
}
async function loadTiles(address){
  var box=$('tiles');clear(box);
  var q='/api/chain-view/native?network=all'+(address?'&address='+encodeURIComponent(address):'');
  var r=await getJson(q);
  if(!r.ok||!r.json||!r.json.statuses){box.appendChild(el('div','err','Node status unavailable: '+(r.json&&r.json.message||('HTTP '+r.status))));return;}
  var up=0;r.json.statuses.forEach(function(s){if(s.connected)up++;box.appendChild(tile(s));});
  $('nMeta').textContent=up+' of '+r.json.statuses.length+' networks connected · '+new Date().toISOString().slice(0,19).replace('T',' ')+' UTC';
  $('nNote').textContent=address?'Balances are for the wallet address above, read directly from each node. Unconfigured networks need a CHAIN_RPC_<NETWORK> variable.':'Create or load the wallet (or look up an address) to see a native coin balance. Block height and gas are live.';
}
function renderWallet(w,status){
  var b=$('wBody');clear(b);
  if(!w){b.appendChild(el('div','empty','No wallet exists yet. Creating one generates a key on the server; the key is never shown or exported.'));$('btnCreate').disabled=!ST.backend;return;}
  $('btnCreate').disabled=true;
  var a=el('div','addr-box',w.address);b.appendChild(a);
  var row=el('div','row');row.style.marginTop='8px';
  var cp=el('button','','Copy address');cp.onclick=function(){try{navigator.clipboard.writeText(w.address);cp.textContent='Copied';}catch(e){cp.textContent='Copy failed';}};row.appendChild(cp);
  row.appendChild(el('span','mut','Label: '+(w.label||'—')+' · created '+(w.created_at||'—')));b.appendChild(row);
  if(status&&status.networks){
    var t=el('table'),hd=el('tr');['Network','Native coin balance','Block','Gas','Status'].forEach(function(h){hd.appendChild(el('th','',h));});t.appendChild(hd);
    status.networks.forEach(function(n){var tr=el('tr');tr.appendChild(el('td','',n.label));var td=el('td','',n.balance!=null?n.balance+' '+n.native:'—');tr.appendChild(td);tr.appendChild(el('td','',n.block!=null?n.block:'—'));tr.appendChild(el('td','',n.gas_price_gwei!=null?n.gas_price_gwei.toFixed(3)+' gwei':'—'));tr.appendChild(el('td',n.connected?'ok':'bad',n.connected?'connected':(n.error||n.note||'not connected')));t.appendChild(tr);});
    var sc=el('div','scroll');sc.appendChild(t);b.appendChild(sc);
    b.appendChild(el('div','note','Backend reads (above) and direct Worker reads (tiles below) are independent: they should agree.'));
  }
}
async function loadWallet(){
  ST.key=$('apiKey').value.trim();
  var r=await getJson('/api/chain/status',{headers:hdr()});
  var b=$('wBody');
  if(!r.ok||!r.json){ST.backend=false;ST.wallet=null;clear(b);b.appendChild(el('div','warn',why(r)));var bs=await getJson('/api/chain-view/backend');if(bs.json){b.appendChild(el('div','note','Backend check: '+(bs.json.connected?'reachable in '+bs.json.latencyMs+' ms':(bs.json.error||'not reachable'))+(bs.json.backend?' ('+bs.json.backend+')':'')+'.'));}b.appendChild(el('div','note','You can still read live node data and any address below: those do not need the backend.'));$('btnCreate').disabled=true;$('btnPrev').disabled=true;$('btnTx').disabled=true;$('wMeta').textContent='backend not connected';await loadTiles(null);return;}
  ST.backend=true;ST.wallet=r.json.wallet;$('wMeta').textContent=r.json.kill_switch?'KILL SWITCH ACTIVE':'backend connected';
  $('btnPrev').disabled=!ST.wallet;$('btnTx').disabled=!ST.wallet;
  renderWallet(r.json.wallet,r.json);
  await loadTiles(ST.wallet?ST.wallet.address:null);
  loadTxs();loadLimits();
}
async function createWallet(){
  $('btnCreate').disabled=true;
  var r=await getJson('/api/chain/wallet',{method:'POST',headers:hdr({'content-type':'application/json'}),body:JSON.stringify({label:'ETI wallet'})});
  if(!r.ok){$('wBody').appendChild(el('div','err','Could not create the wallet: '+why(r)));$('btnCreate').disabled=false;return;}
  await loadWallet();
}
async function loadTxs(){
  var r=await getJson('/api/chain/txs?limit=25',{headers:hdr()}),box=$('txOut');clear(box);
  if(!r.ok||!r.json){box.appendChild(el('div','empty','—  '+why(r)));return;}
  var rows=r.json.transactions||[];$('txMeta').textContent=rows.length+' recorded';
  if(!rows.length){box.appendChild(el('div','empty','No transactions yet. Nothing has been sent from this wallet.'));return;}
  var t=el('table'),hd=el('tr');Object.keys(rows[0]).slice(0,8).forEach(function(k){hd.appendChild(el('th','',k));});t.appendChild(hd);
  var keys=Object.keys(rows[0]).slice(0,8);
  rows.forEach(function(x){var tr=el('tr');keys.forEach(function(k){var v=x[k];tr.appendChild(el('td','',v==null?'—':(typeof v==='object'?JSON.stringify(v):v)));});t.appendChild(tr);});
  box.appendChild(t);
}
async function refreshTxs(){$('btnTx').disabled=true;await getJson('/api/chain/txs/refresh',{method:'POST',headers:hdr()});await loadTxs();$('btnTx').disabled=false;}
async function loadLimits(){
  var r=await getJson('/api/chain/networks',{headers:hdr()}),b=$('limits');clear(b);b.className='';
  if(!r.ok||!r.json||!r.json.limits){b.className='empty';b.textContent='— '+why(r);return;}
  var l=r.json.limits,t=el('table');
  [['Max per transaction',l.max_tx+' (native)'],['Max per day',l.max_daily+' (native)'],['Max slippage',l.max_slippage_bps+' bps'],['Allowlist required',l.require_allowlist?'yes':'no'],['Mainnet sending',l.mainnet_send_enabled?'ENABLED':'disabled']].forEach(function(p){var tr=el('tr');tr.appendChild(el('th','',p[0]));tr.appendChild(el('td','',p[1]));t.appendChild(tr);});
  b.appendChild(t);
}
async function watch(){
  var a=$('watch').value.trim(),box=$('watchOut');clear(box);
  if(!/^0x[0-9a-fA-F]{40}$/.test(a)){box.appendChild(el('div','err','Enter a 0x address with 40 hex characters.'));return;}
  var r=await getJson('/api/chain-view/native?network=all&address='+encodeURIComponent(a));
  if(!r.ok||!r.json||!r.json.statuses){box.appendChild(el('div','err',(r.json&&r.json.message)||('HTTP '+r.status)));return;}
  r.json.statuses.forEach(function(s){if(s.configured)box.appendChild(tile(s));});
}
async function loadTokens(){
  var n=$('tokNet').value,box=$('tokOut');clear(box);
  if(!n){box.appendChild(el('div','empty','No network is configured.'));return;}
  var r=await getJson('/api/chain/tokens?network='+encodeURIComponent(n),{headers:hdr()});
  if(!r.ok||!r.json){box.appendChild(el('div','empty','— '+why(r)));return;}
  var rows=r.json.balances||[];if(!rows.length){box.appendChild(el('div','empty','No tokens are allowlisted for this network. Add one through the allowlist before it is shown or tradable.'));return;}
  var t=el('table'),keys=Object.keys(rows[0]),hd=el('tr');keys.forEach(function(k){hd.appendChild(el('th','',k));});t.appendChild(hd);
  rows.forEach(function(x){var tr=el('tr');keys.forEach(function(k){tr.appendChild(el('td','',x[k]==null?'—':x[k]));});t.appendChild(tr);});box.appendChild(t);
}
async function preview(){
  var box=$('trOut');clear(box);
  var body={network:$('trNet').value,to:$('trTo').value.trim(),amount:$('trAmt').value.trim()};
  var r=await getJson('/api/chain/transfer/preview',{method:'POST',headers:hdr({'content-type':'application/json'}),body:JSON.stringify(body)});
  if(!r.ok||!r.json){var d=r.json&&r.json.detail;box.appendChild(el('div','err',typeof d==='string'?d:(Array.isArray(d)?'Check the address and amount format.':why(r))));return;}
  var p=r.json;box.appendChild(el('div',p.allowed?'ok':'bad',p.allowed?'Allowed by policy (preview only: nothing was signed or sent)':'Blocked by policy'));
  (p.violations||[]).forEach(function(v){box.appendChild(el('div','bad','• '+v));});
  var t=el('table');Object.keys(p).filter(function(k){return k!=='violations'&&k!=='quote_id'&&typeof p[k]!=='object';}).forEach(function(k){var tr=el('tr');tr.appendChild(el('th','',k));tr.appendChild(el('td','',p[k]));t.appendChild(tr);});box.appendChild(t);
}
$('btnLoad').onclick=loadWallet;$('btnCreate').onclick=createWallet;$('btnWatch').onclick=watch;$('btnTok').onclick=loadTokens;$('btnPrev').onclick=preview;$('btnTx').onclick=refreshTxs;
$('watch').addEventListener('keydown',function(e){if(e.key==='Enter')watch();});
loadNetworks().then(loadWallet);
setInterval(function(){if(!document.hidden)loadTiles(ST.wallet?ST.wallet.address:null);},30000);
</script></body></html>`;

export function walletPage(): string { return withMotion(BODY); }
