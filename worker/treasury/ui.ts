/**
 * Corporate treasury dashboard (GET /treasury).
 *
 * A same-origin page: it signs nobody in and stores no token. It calls /api/treasury/* with the visitor's existing ETI account session
 * cookie (sign in at /account; money-moving actions need a named account with multi-factor authentication and the right company role).
 * Every request names its environment explicitly and the page never adds the two environments together.
 * No inline event handlers are used, so the nonce-based Content-Security-Policy applied by the security layer allows the page as written.
 */
export function treasuryPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Corporate Treasury</title>
<style>
:root{color-scheme:dark;--bg:#080d16;--panel:#111b2b;--line:#24334a;--mut:#8fa3bd;--g:#21d69a;--r:#ff637d;--b:#56a8ff;--a:#f0c674}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#eaf2ff;font:14px/1.5 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;padding:14px 4vw;border-bottom:1px solid var(--line)}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px}a{color:var(--b)}
main{max-width:1400px;margin:auto;padding:16px 4vw 60px;display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}
.c12{grid-column:span 12}.c6{grid-column:span 6}
@media(max-width:900px){.c6{grid-column:span 12}}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,select,button{background:#0b1422;color:#eaf2ff;border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit}
button{cursor:pointer}button.p{border-color:var(--b);color:var(--b)}button.d{border-color:var(--r);color:var(--r)}
button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--b);outline-offset:2px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.kpi{border:1px solid var(--line);border-radius:10px;padding:10px;background:#0b1422}.kpi small,.mut{color:var(--mut)}.kpi b{display:block;font-size:19px;margin-top:3px}
table{width:100%;border-collapse:collapse}th,td{padding:7px 6px;border-bottom:1px solid #1d2a3e;text-align:left;font-size:12px;vertical-align:top}.scroll{overflow:auto;max-height:420px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:10px}.grid2 label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--mut)}
#banner{padding:10px 4vw;font-weight:600}#banner.sim{background:#3a2f12;color:var(--a)}#banner.act{background:#3b1520;color:#ffb3c0}
.ok{color:var(--g)}.bad{color:var(--r)}.note{font-size:12px;color:var(--mut);margin-top:8px}
#log{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;max-height:220px;overflow:auto}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<header><h1>ETI Corporate Treasury</h1><div class="row"><a href="/">Markets</a><a href="/account">Account / sign in</a><label>Environment <select id="env" aria-label="Environment"><option value="simulated">Simulated (not real money)</option><option value="actual">Actual funds</option></select></label><button id="refresh" class="p">Refresh</button></div></header>
<div id="banner" role="status"></div>
<main>
<section class="c12"><h2>Balances</h2><div id="balances" class="note">Loading...</div></section>
<section class="c6"><h2>Policy requirements</h2><div id="req"></div></section>
<section class="c6"><h2>Profit allocation plan</h2><div id="plan"></div><div class="row" style="margin-top:10px"><button id="btnAlloc" class="p">Allocate realized profits per policy</button></div><div class="note">Only reconciled net profit in the realized-profits pool can be allocated. Operating funds receive money only from this allocation.</div></section>
<section class="c12"><h2>Profit batches (record, then settle, then reconcile: three different people)</h2><div id="batches"></div>
<div class="grid2" style="margin-top:12px"><label>Source (exchange, bank or custody)<input id="bSource" maxlength="120"></label><label>Period (YYYY-Qn, optional)<input id="bPeriod" placeholder="2026-Q4"></label><label>Gross profit or loss<input id="bGross" inputmode="decimal" placeholder="e.g. 1250.00 or -300.00"></label><label>Fees<input id="bFees" inputmode="decimal" placeholder="0.00"></label><label>Description<input id="bDesc" maxlength="500"></label></div>
<button id="btnBatch" class="p">Record profit batch</button><div class="note">Settling needs the exchange, bank or custody record showing the funds have settled. Reconciling needs the statement figure to match the recorded net amount exactly. Paper, testnet and other simulated sources are refused in the actual environment.</div></section>
<section class="c12"><h2>Allocation policy</h2><div id="policies"></div>
<div class="grid2" style="margin-top:12px"><label>Minimum trading capital<input id="pMinTc" inputmode="decimal" value="0"></label><label>Loss recovery (% of profit)<input id="pLoss" inputmode="decimal" value="50"></label><label>Emergency reserve target<input id="pResTarget" inputmode="decimal" value="0"></label><label>Reserve share (% of profit)<input id="pResPct" inputmode="decimal" value="20"></label><label>Minimum liquidity<input id="pLiq" inputmode="decimal" value="0"></label><label>Operating share %<input id="pOp" inputmode="decimal" value="50"></label><label>Long-term share %<input id="pLt" inputmode="decimal" value="20"></label><label>Reinvest share %<input id="pRe" inputmode="decimal" value="30"></label><label>Note<input id="pNote" maxlength="500"></label></div>
<button id="btnPolicy" class="p">Propose policy</button><div class="note">The three shares must total 100%. A different authorised person must approve the proposal before it takes effect.</div></section>
<section class="c6"><h2>Owner contribution</h2><div class="grid2"><label>Account<select id="cAcct"><option value="1100">Trading capital</option><option value="1400">Emergency reserve</option><option value="1500">Long-term investments</option></select></label><label>Amount<input id="cAmt" inputmode="decimal"></label><label>External reference<input id="cRef" maxlength="120"></label><label>Note<input id="cNote" maxlength="300"></label></div><button id="btnContribute">Record contribution</button><div class="note">Operating funds cannot be funded by contributions; they are funded only from reconciled profit.</div></section>
<section class="c6"><h2>Department budget funding</h2><div class="grid2"><label>Department (code or id)<input id="fDept" list="deptList"><datalist id="deptList"></datalist></label><label>Amount<input id="fAmt" inputmode="decimal"></label><label>Period (YYYY-Qn, optional)<input id="fPeriod" placeholder="2026-Q4"></label></div><button id="btnFund">Fund department from operating funds</button><div class="note">In the actual environment funding cannot exceed the department's approved company budget for the period.</div></section>
<section class="c6"><h2>Liabilities</h2><div class="grid2"><label>Amount<input id="lAmt" inputmode="decimal"></label><label>Description (to incur)<input id="lDesc" maxlength="300"></label><label>External reference<input id="lRef" maxlength="120"></label></div><div class="row"><button id="btnIncur">Incur liability</button><button id="btnSettleLiab">Settle liability from operating funds</button></div></section>
<section class="c6"><h2>Post a paid company expense</h2><div class="grid2"><label>Company expense id<input id="xId" maxlength="64"></label></div><button id="btnExpense">Post expense to the ledger</button><div class="note">Actual environment only. The expense must already be recorded as paid in company management; it is paid out of the department's budget balance.</div></section>
<section class="c12"><div class="row" style="justify-content:space-between"><h2>Immutable ledger (latest 20 entries)</h2><button id="btnVerify">Verify hash chain and balances</button></div><div id="ledger"></div></section>
<section class="c12"><h2>Activity</h2><div id="log" role="log"></div></section>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const env=()=>$('env').value;
const ACCT={'1100':'Trading capital','1200':'Realized profits','1300':'Operating funds','1400':'Emergency reserve','1500':'Long-term investments','1600':'Department budget','2100':'Outstanding liabilities','3100':'Owner capital','4100':'Trading revenue','5100':'Operating expenses','5200':'Trading losses'};
let deptNames={};
function money(c){const n=Number(c)||0,a=Math.abs(n);return (n<0?'-':'')+Math.floor(a/100).toLocaleString()+'.'+String(a%100).padStart(2,'0');}
function cents(id,signed){const v=String($(id).value).trim();const re=signed?/^-?\d+(\.\d{1,2})?$/:/^\d+(\.\d{1,2})?$/;if(!re.test(v))throw new Error('Enter a valid amount with up to 2 decimals in the field '+id);return Math.round(Number(v)*100);}
function centsOr0(id){return String($(id).value).trim()===''?0:cents(id,false);}
function bps(id){const v=String($(id).value).trim();if(!/^\d+(\.\d{1,2})?$/.test(v))throw new Error('Enter a valid percentage in the field '+id);const n=Math.round(Number(v)*100);if(n>10000)throw new Error('A percentage cannot exceed 100 (field '+id+')');return n;}
function log(msg,ok){const el=$('log');el.textContent=(ok?'OK   ':'ERR  ')+new Date().toLocaleTimeString()+'  '+msg+String.fromCharCode(10)+el.textContent;}
function why(e){if(e&&e.status===401)return 'Not signed in. Sign in at /account with a named account (multi-factor authentication is required for actions).';return e&&e.message?e.message:'Unexpected error';}
async function api(method,path,body){
 const opt={method:method,credentials:'same-origin',headers:{accept:'application/json'}};
 let url='/api/treasury'+path;
 if(method==='GET'){url+=(path.indexOf('?')<0?'?':'&')+'environment='+encodeURIComponent(env());}
 else{opt.headers['content-type']='application/json';opt.body=JSON.stringify(Object.assign({environment:env()},body||{}));}
 const r=await fetch(url,opt),t=await r.text();let j={};
 try{j=t?JSON.parse(t):{};}catch(e){throw new Error('Unexpected response (HTTP '+r.status+')');}
 if(!r.ok){let m=j.message||j.error||('HTTP '+r.status);if(j.reason)m+=' ('+j.reason+')';if(j.recordedNetCents!=null)m+=' - recorded net is '+money(j.recordedNetCents);const er=new Error(m);er.status=r.status;throw er;}
 return j;}
function table(heads,rows){return '<div class="scroll"><table><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';}
function setBanner(){const b=$('banner'),a=env()==='actual';b.className=a?'act':'sim';b.textContent=a?'ACTUAL FUNDS: entries record real money that has moved elsewhere (bank, exchange, custody). Always cite the external reference.':'SIMULATED: test balances only. Nothing here is real money, and nothing here can be moved into the actual environment.';}
async function loadDepartments(){try{const r=await fetch('/api/company/departments',{credentials:'same-origin',headers:{accept:'application/json'}});if(!r.ok)return;const j=await r.json();const list=Array.isArray(j)?j:(j.departments||j.items||[]);const dl=$('deptList');dl.textContent='';deptNames={};list.forEach(d=>{if(!d||!d.id)return;deptNames[d.id]=(d.code?d.code+' ':'')+(d.name||'');const o=document.createElement('option');o.value=d.code||d.id;o.label=deptNames[d.id];dl.appendChild(o);});}catch(e){}}
function renderReq(r){const q=r.requirements;if(!q){$('req').innerHTML='<div class="note">No active allocation policy. Propose one below; a second authorised person must approve it.</div>';return;}
 const row=(n,need,have,met)=>'<tr><td>'+n+'</td><td>'+money(need)+'</td><td>'+money(have)+'</td><td class="'+(met?'ok':'bad')+'">'+(met?'met':'NOT MET')+'</td></tr>';
 $('req').innerHTML=table(['Requirement','Required','Actual','Status'],[row('Minimum trading capital',q.minimum_trading_capital.required,q.minimum_trading_capital.actual,q.minimum_trading_capital.met),row('Emergency reserve target',q.emergency_reserve.target,q.emergency_reserve.actual,q.emergency_reserve.met),row('Liquidity',q.liquidity.required,q.liquidity.actual,q.liquidity.met)])+'<div class="note">Policy version '+esc(r.policy&&r.policy.version)+'. Loss recovery: '+(q.loss_recovery.share_bps/100)+'% of profit until the unrecovered loss ('+money(q.loss_recovery.unrecovered_loss_cents)+') is cleared.</div>';}
function renderReport(r){
 const b=r.buckets||{};
 const items=[['Trading capital',b.trading_capital],['Realized profits (awaiting allocation)',b.realized_profits],['Operating funds',b.operating_funds],['Emergency reserves',b.emergency_reserve],['Long-term investments',b.long_term_investments],['Departmental budgets (total)',b.department_budgets_total],['Outstanding liabilities',b.outstanding_liabilities]];
 let h='<div class="kpis">'+items.map(i=>'<div class="kpi"><small>'+esc(i[0])+'</small><b>'+money(i[1])+'</b></div>').join('')+'</div>';
 h+='<div class="note">'+esc(r.funds)+' | Liquid funds '+money(r.liquid_funds_cents)+' (operating + reserve + department budgets - liabilities) | Unrecovered trading loss '+money(r.unrecovered_loss_cents)+' | Owner capital '+money(r.owner_capital)+' | Trading revenue '+money(r.trading_revenue)+' | Trading losses '+money(r.trading_losses)+' | Operating expenses '+money(r.operating_expenses)+'</div>';
 const d=r.department_budgets||{},ids=Object.keys(d);
 h+=ids.length?table(['Department','Budget balance'],ids.map(k=>'<tr><td>'+esc(deptNames[k]||k)+'</td><td>'+money(d[k])+'</td></tr>')):'<div class="note">No department has been funded in this environment.</div>';
 $('balances').innerHTML=h;renderReq(r);}
async function loadReport(){try{renderReport(await api('GET','/report'));}catch(e){$('balances').innerHTML='<div class="bad">'+esc(why(e))+'</div>';$('req').textContent='';}}
async function loadBatches(){try{const j=await api('GET','/profit-batches?limit=50');
 const rows=(j.batches||[]).map(b=>{let a='';if(b.status==='recorded')a+='<button data-act="settle" data-id="'+esc(b.id)+'">Settle</button> ';if(b.status==='settled')a+='<button data-act="reconcile" data-id="'+esc(b.id)+'" data-net="'+esc(b.net_cents)+'">Reconcile</button> ';if(b.status==='recorded'||b.status==='settled')a+='<button class="d" data-act="reject" data-id="'+esc(b.id)+'">Reject</button>';return '<tr><td>'+esc(b.period)+'</td><td>'+esc(b.source)+'</td><td>'+money(b.gross_cents)+'</td><td>'+money(b.fees_cents)+'</td><td><b>'+money(b.net_cents)+'</b></td><td>'+esc(b.status)+'</td><td>'+a+'</td></tr>';});
 $('batches').innerHTML=rows.length?table(['Period','Source','Gross','Fees','Net','Status','Actions'],rows):'<div class="note">No profit batches in this environment.</div>';}catch(e){$('batches').innerHTML='<div class="bad">'+esc(why(e))+'</div>';}}
async function loadPlan(){try{const j=await api('GET','/allocations/plan');
 $('plan').innerHTML='<div class="note">Policy version '+esc(j.policyVersion)+' | realized-profit pool '+money(j.realizedProfitsCents)+' | unrecovered loss '+money(j.unrecoveredLossCents)+'</div>'+((j.plan||[]).length?table(['Destination','Amount','Reason'],j.plan.map(a=>'<tr><td>'+esc(ACCT[a.account]||a.account)+'</td><td>'+money(a.cents)+'</td><td>'+esc(String(a.reason).replace(/_/g,' '))+'</td></tr>')):'<div class="note">Nothing to allocate: the pool of reconciled profit is empty.</div>');}catch(e){$('plan').innerHTML='<div class="bad">'+esc(why(e))+'</div>';}}
async function loadPolicies(){try{const j=await api('GET','/policy');
 const rows=(j.policies||[]).map(p=>{let a='';if(p.status==='proposed')a='<button data-act="pol-approve" data-id="'+esc(p.id)+'">Approve</button> <button class="d" data-act="pol-reject" data-id="'+esc(p.id)+'">Reject</button>';return '<tr><td>v'+esc(p.version)+'</td><td>'+esc(p.status)+'</td><td>'+money(p.min_trading_capital_cents)+'</td><td>'+(p.loss_recovery_bps/100)+'%</td><td>'+money(p.reserve_target_cents)+' @ '+(p.reserve_bps/100)+'%</td><td>'+money(p.liquidity_min_cents)+'</td><td>'+(p.operating_bps/100)+' / '+(p.long_term_bps/100)+' / '+(p.reinvest_bps/100)+'</td><td>'+a+'</td></tr>';});
 $('policies').innerHTML=rows.length?table(['Version','Status','Min trading capital','Loss recovery','Reserve target','Min liquidity','Operating / long-term / reinvest %','Actions'],rows):'<div class="note">No policy has been proposed in this environment.</div>';}catch(e){$('policies').innerHTML='<div class="bad">'+esc(why(e))+'</div>';}}
async function loadLedger(){try{const j=await api('GET','/ledger?limit=20');
 const rows=(j.entries||[]).map(x=>'<tr><td>#'+esc(x.seq)+'</td><td>'+esc(x.kind)+'</td><td>'+esc(new Date(x.at).toLocaleString())+'</td><td>'+esc(x.reference||'')+'</td><td>'+(x.lines||[]).map(l=>esc((ACCT[l.account_code]||l.account_code)+(l.department_id!=='*'?' ['+(deptNames[l.department_id]||l.department_id)+']':'')+' '+(l.debit_cents?'Dr '+money(l.debit_cents):'Cr '+money(l.credit_cents)))).join('<br>')+'</td><td class="mut">'+esc(String(x.hash).slice(0,12))+'</td></tr>');
 $('ledger').innerHTML=rows.length?table(['Entry','Kind','Time','Reference','Lines','Hash'],rows):'<div class="note">The ledger for this environment is empty.</div>';}catch(e){$('ledger').innerHTML='<div class="bad">'+esc(why(e))+'</div>';}}
async function refresh(){setBanner();await Promise.all([loadReport(),loadBatches(),loadPlan(),loadPolicies(),loadLedger()]);}
async function run(label,fn,confirmText){try{if(confirmText&&!window.confirm(confirmText))return;const j=await fn();log(label+' done'+(j&&j.entry?' (ledger entry #'+j.entry.seq+')':''),true);await refresh();}catch(e){log(label+' failed: '+why(e),false);}}
const real=()=>env()==='actual'?'ACTUAL FUNDS. ':'';
$('env').addEventListener('change',refresh);
$('refresh').addEventListener('click',refresh);
$('btnBatch').addEventListener('click',()=>run('Record profit batch',()=>api('POST','/profit-batches',{source:$('bSource').value.trim(),period:$('bPeriod').value.trim()||undefined,grossCents:cents('bGross',true),feesCents:centsOr0('bFees'),description:$('bDesc').value.trim()})));
$('btnPolicy').addEventListener('click',()=>run('Propose policy',()=>api('POST','/policy',{minTradingCapitalCents:cents('pMinTc'),lossRecoveryBps:bps('pLoss'),reserveTargetCents:cents('pResTarget'),reserveBps:bps('pResPct'),liquidityMinCents:cents('pLiq'),operatingBps:bps('pOp'),longTermBps:bps('pLt'),reinvestBps:bps('pRe'),note:$('pNote').value.trim()})));
$('btnAlloc').addEventListener('click',()=>run('Allocate profits',()=>api('POST','/allocations',{}),real()+'Allocate the whole realized-profits pool according to the active policy? This posts an immutable ledger entry.'));
$('btnContribute').addEventListener('click',()=>run('Record contribution',()=>api('POST','/contributions',{account:$('cAcct').value,amountCents:cents('cAmt'),reference:$('cRef').value.trim(),note:$('cNote').value.trim()}),real()+'Record this owner contribution? It cannot be edited or deleted afterwards.'));
$('btnFund').addEventListener('click',()=>run('Fund department',()=>api('POST','/department-funding',{departmentId:$('fDept').value.trim(),amountCents:cents('fAmt'),period:$('fPeriod').value.trim()||undefined}),real()+'Move this amount from operating funds to the department budget?'));
$('btnIncur').addEventListener('click',()=>run('Incur liability',()=>api('POST','/liabilities',{amountCents:cents('lAmt'),description:$('lDesc').value.trim(),reference:$('lRef').value.trim()}),real()+'Record this liability?'));
$('btnSettleLiab').addEventListener('click',()=>run('Settle liability',()=>api('POST','/liabilities/settle',{amountCents:cents('lAmt'),reference:$('lRef').value.trim()}),real()+'Settle this liability from operating funds?'));
$('btnExpense').addEventListener('click',()=>run('Post expense',()=>{if(env()!=='actual')throw new Error('Company expenses are posted to the actual environment only. Switch the environment first.');const id=$('xId').value.trim();if(!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new Error('Enter a valid company expense id.');return api('POST','/expenses/'+id+'/post',{});},real()+'Post this paid expense against the department budget?'));
$('btnVerify').addEventListener('click',async()=>{try{const j=await api('GET','/verify');log('Verify '+env()+': '+(j.ok?'chain and balances are consistent':'PROBLEMS FOUND: '+(j.issues||[]).join('; '))+' ('+j.entries+' entries, triggers '+(j.immutability_triggers?'present':'missing')+')',!!j.ok);}catch(e){log('Verify failed: '+why(e),false);}});
document.addEventListener('click',e=>{const b=e.target.closest('button[data-act]');if(!b)return;const id=b.dataset.id,act=b.dataset.act;
 if(act==='settle'){const ref=window.prompt('Settlement reference (exchange, bank or custody record showing the funds have settled):');if(!ref)return;run('Settle batch',()=>api('POST','/profit-batches/'+id+'/settle',{settlementReference:ref.trim()}));}
 else if(act==='reconcile'){const ref=window.prompt('Reconciliation reference (the statement or record you reconciled against):');if(!ref)return;const st=window.prompt('Net amount shown on that statement (must equal the recorded net exactly):',money(b.dataset.net).replace(/,/g,''));if(st===null)return;run('Reconcile batch',()=>{if(!/^-?\d+(\.\d{1,2})?$/.test(st.trim()))throw new Error('Enter the statement amount with up to 2 decimals.');return api('POST','/profit-batches/'+id+'/reconcile',{reconciliationReference:ref.trim(),statementNetCents:Math.round(Number(st.trim())*100)});},real()+'Reconcile and recognise this profit? This posts an immutable ledger entry.');}
 else if(act==='reject'){const note=window.prompt('Reason for rejecting this batch:');if(!note)return;run('Reject batch',()=>api('POST','/profit-batches/'+id+'/reject',{note:note.trim()}));}
 else if(act==='pol-approve'){run('Approve policy',()=>api('POST','/policy/'+id+'/decision',{decision:'approve'}),real()+'Approve this allocation policy? It replaces the active policy.');}
 else if(act==='pol-reject'){const note=window.prompt('Reason for rejecting this policy:');if(!note)return;run('Reject policy',()=>api('POST','/policy/'+id+'/decision',{decision:'reject',note:note.trim()}));}
});
loadDepartments();refresh();
</script></body></html>`;
}
