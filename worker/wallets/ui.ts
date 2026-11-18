/**
 * /wallets page. Plain DOM APIs and textContent only; no secrets are ever typed, kept or stored here (it uses no browser storage of any kind).
 * Approvals use the browser's WebAuthn with the challenge computed HERE from the action the user is looking at (SHA-256 of its canonical form),
 * so a compromised server cannot get a signature for a different action than the one displayed.
 * This is a TypeScript template literal: the script below contains no backticks, no dollar-brace sequences and no backslashes.
 */
const CSS = `:root{--bg:#0b0f17;--card:#121a27;--line:#223048;--fg:#e6edf7;--mut:#8da0bb;--ok:#2fd18b;--bad:#ff6b6b;--warn:#f0b64d;--acc:#4da3ff}
@media (prefers-color-scheme:light){:root{--bg:#f4f7fb;--card:#fff;--line:#d5deeb;--fg:#122033;--mut:#52637d;--ok:#0a8f5b;--bad:#c0392b;--warn:#9a6a00;--acc:#1763c7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:21px;margin:6px 0 4px}h2{font-size:16px;margin:0 0 10px}h3{font-size:14px;margin:12px 0 6px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
label{display:block;font-size:12px;color:var(--mut);margin:8px 0 3px}input,select,textarea{width:100%;padding:9px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}textarea{min-height:90px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
button{padding:8px 12px;border-radius:8px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin:8px 6px 0 0}button.sec{background:transparent;border:1px solid var(--line);color:var(--fg)}button.bad{background:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.msg{min-height:1.3em;font-size:13px;margin-top:6px}.ok{color:var(--ok)}.badc{color:var(--bad)}.mut{color:var(--mut)}.warn{color:var(--warn)}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px;margin:0 4px 4px 0}.pill.ok{border-color:var(--ok)}.pill.bad{border-color:var(--bad);color:var(--bad)}.pill.warn{border-color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}.tw{overflow-x:auto}
.hide{display:none}.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}.kv span:nth-child(odd){color:var(--mut)}code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--bg);padding:1px 4px;border-radius:4px}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bar a{margin-left:auto}@media (max-width:520px){main{padding:10px}}`;

const JS = `(function(){
var $=function(i){return document.getElementById(i)},S=null,TXT=function(e,t){e.textContent=t==null?'':String(t);return e};
var PURPOSES=['trading','treasury','opex','emergency','long_term'];
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function msg(id,t,ok){var e=$(id);e.textContent=t||'';e.className='msg '+(t?(ok?'ok':'badc'):'')}
function api(path,body){return fetch('/api/wallets/'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return{error:'bad_response'}}).then(function(j){j.__status=r.status;return j})})}
function errText(j){return (j.message||j.error||'failed')}
function b64u(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s).split('+').join('-').split('/').join('_').split('=').join('')}
function unb64u(s){s=s.split('-').join('+').split('_').join('/');while(s.length%4)s+='=';var b=atob(s),o=new Uint8Array(b.length);for(var i=0;i<b.length;i++)o[i]=b.charCodeAt(i);return o}
function hexBytes(h){var o=new Uint8Array(h.length/2);for(var i=0;i<o.length;i++)o[i]=parseInt(h.substr(i*2,2),16);return o}
function toHex(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=(b[i]<16?'0':'')+b[i].toString(16);return s}
function canon(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canon).join(',')+']';return '{'+Object.keys(v).filter(function(k){return v[k]!==undefined}).sort().map(function(k){return JSON.stringify(k)+':'+canon(v[k])}).join(',')+'}'}
function sha256Hex(s){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)).then(toHex)}
function when(ms){return ms?new Date(ms).toLocaleString():'-'}
function wl(id){for(var i=0;i<S.wallets.length;i++)if(S.wallets[i].id===id)return S.wallets[i].label;return id||'(governance)'}
function describe(c){var p=c.payload||{};
 if(c.kind==='withdraw'){var d=p.destination||{};return 'Withdraw '+p.amount+' '+p.asset+' from '+wl(c.walletId)+' to '+(d.type==='internal'?wl(d.walletId)+' (internal book transfer)':d.chain+' address '+d.address)}
 if(c.kind==='record_deposit')return 'Record deposit of '+p.amount+' '+p.asset+' into '+wl(c.walletId)+' (ref '+p.txRef+')';
 if(c.kind==='address_add')return 'Whitelist '+p.chain+' address '+p.address+' ('+p.label+') for '+(p.walletId==='*'?'all wallets':wl(p.walletId));
 if(c.kind==='address_remove')return 'Remove whitelisted address '+p.address;
 if(c.kind==='signer_add')return 'Add signer '+p.label+' (user '+p.uid+') for '+p.wallets.join(', ');
 if(c.kind==='signer_remove')return 'Remove signer (user '+p.uid+')';
 if(c.kind==='policy_change')return 'Change policy/custody of '+wl(c.walletId)+': '+Object.keys(p).join(', ');
 if(c.kind==='unfreeze')return 'Lift the freeze: '+(p.reason||'');
 if(c.kind==='recovery_rotate')return 'Replace the recovery key with set '+p.setId+' ('+p.k+' of '+p.n+')';
 return c.kind}
function head(){var h=$('status');h.textContent='';
 var add=function(t,c){h.appendChild(el('span','pill '+(c||''),t))};
 add(S.sealed?'Sealed':'Setup mode',S.sealed?'ok':'warn');
 if(S.frozen)add('FROZEN: '+S.frozen.reason,'bad');
 add(S.executionEnabled?'External execution ON':'External execution OFF',S.executionEnabled?'warn':'');
 add('Governance: '+S.governanceThreshold+' approvals, '+Math.round(S.govTimelockSec/3600*10)/10+' h timelock');
 add(S.recovery?'Recovery key '+S.recovery.setId+' ('+S.recovery.k+' of '+S.recovery.n+')':'No recovery key','');
 $('freeze').disabled=!!S.frozen}
function walletCards(){var g=$('wallets');g.textContent='';S.wallets.forEach(function(w){var c=el('div','card');c.appendChild(el('h2',null,w.label));
 var kv=el('div','kv'),row=function(a,b){kv.appendChild(el('span',null,a));kv.appendChild(el('span',null,b))};
 row('Custody',w.custody.kind==='ledger'?'Internal ledger (no on-chain keys)':w.custody.kind+' / '+w.custody.ref+' ('+w.custody.chains.join(', ')+')');
 var bal=Object.keys(w.balances).map(function(k){return w.balances[k]+' '+k}).join(', ');row('Ledger balance',w.custody.kind==='ledger'?(bal||'0'):'held by custodian');
 var pol=w.policy;row('Requested by',pol.requestRole+' or above');row('Timelock',Math.round(pol.timelockSec/360)/10+' h');row('Address cooldown',Math.round(pol.addressCooldownSec/360)/10+' h');
 Object.keys(pol.assets).forEach(function(a){var x=pol.assets[a];row(a+' limits','per tx '+x.perTx+', daily '+x.daily);row(a+' approvals',x.tiers.map(function(t){return (t.upTo?'up to '+t.upTo:'above')+': '+t.approvals}).join('; '))});
 row('Signers',w.signers+' scoped');row('Open actions',w.openActions);row('Minimum floor',FLOOR(w));c.appendChild(kv);g.appendChild(c)})}
function FLOOR(w){return w.floors.minApprovals+(w.floors.minApprovals===1?' approval, ':' approvals, ')+Math.round(w.floors.minTimelockSec/360)/10+' h timelock'}
function signers(){var b=$('signers');b.textContent='';S.signers.forEach(function(s){var tr=el('tr');tr.appendChild(el('td',null,s.label));tr.appendChild(el('td',null,s.uid));tr.appendChild(el('td',null,s.wallets.join(', ')));tr.appendChild(el('td',null,s.status));tr.appendChild(el('td',null,s.credentials.map(function(c){return c.id+'… '+(c.aaguid&&c.aaguid.replace(/0/g,'')?'':'(no attestation)')}).join(' ')||'no key yet'));b.appendChild(tr)});
 var mine=S.me&&S.me.status==='invited';$('enrolBox').classList.toggle('hide',!mine)}
function addresses(){var b=$('addrs');b.textContent='';S.addresses.forEach(function(a){var tr=el('tr');tr.appendChild(el('td',null,a.label));tr.appendChild(el('td',null,a.chain));tr.appendChild(el('td',null,a.address));tr.appendChild(el('td',null,a.walletId==='*'?'all':wl(a.walletId)));tr.appendChild(el('td',null,a.active?'active':'cooldown until '+when(a.activeAt)));b.appendChild(tr)});if(!S.addresses.length){var tr=el('tr');var td=el('td','mut','No whitelisted addresses. External withdrawals are impossible until one is added (and its cooldown has passed).');td.colSpan=5;tr.appendChild(td);b.appendChild(tr)}}
function actions(){var b=$('actions');b.textContent='';S.actions.forEach(function(a){var tr=el('tr');
 var d=el('td');d.appendChild(el('div',null,describe(a.core)));d.appendChild(el('div','mut','requested by '+a.core.requestedBy+' on '+when(a.core.createdAt)+' · id '+a.id));if(a.result&&a.result.error)d.appendChild(el('div','badc',a.result.error));if(a.result&&a.result.ref)d.appendChild(el('div','mut','ref '+a.result.ref));tr.appendChild(d);
 var st=el('td');st.appendChild(el('span','pill '+(a.status==='executed'?'ok':(a.status==='failed'||a.status==='unknown'||a.status==='cancelled'?'bad':'')),a.status));st.appendChild(el('div','mut',a.approvals+' of '+a.threshold+' approvals'+(a.approvedBy.length?' ('+a.approvedBy.join(', ')+')':'')));if(a.status==='timelocked')st.appendChild(el('div','mut','executable '+when(a.executableAt)));if(a.status==='pending'||a.status==='timelocked'||a.status==='ready')st.appendChild(el('div','mut','expires '+when(a.expiresAt)));tr.appendChild(st);
 var ac=el('td');
 if(a.canApprove){var bt=el('button',null,'Approve with security key');bt.addEventListener('click',function(){approve(a,bt)});ac.appendChild(bt)}
 if(a.status==='ready'){var ex=el('button','sec','Execute');ex.addEventListener('click',function(){run('actions/'+a.id+'/execute',{},ex)});ac.appendChild(ex)}
 if(['pending','timelocked','ready'].indexOf(a.status)>=0){var cx=el('button','sec','Cancel');cx.addEventListener('click',function(){var r=prompt('Reason for cancelling');if(r!==null)run('actions/'+a.id+'/cancel',{reason:r},cx)});ac.appendChild(cx)}
 if(a.status==='unknown'){var rs=el('button','sec','Resolve…');rs.addEventListener('click',function(){var o=prompt('Did the custodian send it? Type executed or failed');if(o!=='executed'&&o!=='failed')return;var r=o==='executed'?prompt('Custodian transaction reference'):'';run('actions/'+a.id+'/resolve',{outcome:o,ref:r||'',note:'resolved in UI'},rs)});ac.appendChild(rs)}
 tr.appendChild(ac);b.appendChild(tr)});
 if(!S.actions.length){var tr=el('tr');var td=el('td','mut','No actions yet.');td.colSpan=3;tr.appendChild(td);b.appendChild(tr)}}
function run(path,body,btn){if(btn)btn.disabled=true;return api(path,body).then(function(j){if(btn)btn.disabled=false;msg('actMsg',j.error?errText(j):'Done.',!j.error);return load()})}
function approve(a,btn){btn.disabled=true;msg('actMsg','Checking the action digest…',true);
 sha256Hex(canon(a.core)).then(function(h){if(h!==a.digest){throw new Error('The server sent a digest that does not match the action shown. Do not approve.')}
  var NL=String.fromCharCode(10);if(!confirm('Approve this action?'+NL+NL+describe(a.core)+NL+NL+'Your security key will ask you to confirm.'))throw new Error('Cancelled');
  return api('actions/'+a.id+'/approve-options',{})}).then(function(o){if(o.error)throw new Error(errText(o));
  var pk=o.publicKey;return navigator.credentials.get({publicKey:{challenge:hexBytes(a.digest),rpId:pk.rpId,allowCredentials:pk.allowCredentials.map(function(c){return{type:'public-key',id:unb64u(c.id)}}),userVerification:'required',timeout:pk.timeout}}).then(function(cred){
   return api('actions/'+a.id+'/approve',{challengeId:o.challengeId,credentialId:b64u(cred.rawId),clientDataJSON:b64u(cred.response.clientDataJSON),authenticatorData:b64u(cred.response.authenticatorData),signature:b64u(cred.response.signature)})})}).then(function(j){btn.disabled=false;msg('actMsg',j.error?errText(j):'Approved ('+j.approvals+' of '+j.threshold+').',!j.error);return load()}).catch(function(e){btn.disabled=false;msg('actMsg',e.message||String(e),false)})}
function enrol(){msg('enrolMsg','Waiting for your security key…',true);api('enroll/options',{}).then(function(o){if(o.error)throw new Error(errText(o));var pk=o.publicKey;
 return navigator.credentials.create({publicKey:{challenge:unb64u(pk.challenge),rp:pk.rp,user:{id:unb64u(pk.user.id),name:pk.user.name,displayName:pk.user.displayName},pubKeyCredParams:pk.pubKeyCredParams,authenticatorSelection:pk.authenticatorSelection,attestation:'none',timeout:pk.timeout}}).then(function(c){
  return api('enroll/verify',{challengeId:o.challengeId,clientDataJSON:b64u(c.response.clientDataJSON),attestationObject:b64u(c.response.attestationObject)})})}).then(function(j){msg('enrolMsg',j.error?errText(j):'Security key registered.',!j.error);return load()}).catch(function(e){msg('enrolMsg',e.message||String(e),false)})}
/* ---- new action form ---- */
var FIELDS={withdraw:['wallet','asset','amount','dtype','dwallet','dchain','daddr','memo'],record_deposit:['wallet','asset','amount','txref'],address_add:['awallet','dchain','daddr','label'],address_remove:['entry'],signer_add:['uid','label','swallets'],signer_remove:['signer'],policy_change:['wallet','json'],unfreeze:['memo'],recovery_rotate:['json']};
function fld(id){return $('f_'+id)}
function showFields(){var k=$('kind').value,on=FIELDS[k]||[];var all=document.querySelectorAll('[data-f]');for(var i=0;i<all.length;i++)all[i].classList.toggle('hide',on.indexOf(all[i].getAttribute('data-f'))<0);
 if(k==='withdraw')dtype()}
function dtype(){var ext=fld('dtype').value==='external';['dwallet'].forEach(function(f){document.querySelector('[data-f="'+f+'"]').classList.toggle('hide',ext)});['dchain','daddr'].forEach(function(f){document.querySelector('[data-f="'+f+'"]').classList.toggle('hide',!ext)})}
function fillSelects(){var opt=function(sel,items){sel.textContent='';items.forEach(function(i){var o=el('option',null,i[1]);o.value=i[0];sel.appendChild(o)})};
 var ws=S.wallets.map(function(w){return[w.id,w.label]});opt(fld('wallet'),ws);opt(fld('dwallet'),ws);opt(fld('awallet'),[['*','All wallets']].concat(ws));
 opt(fld('signer'),S.signers.filter(function(s){return s.status!=='removed'}).map(function(s){return[s.id,s.label+' ('+s.uid+')']}));
 opt(fld('entry'),S.addresses.map(function(a){return[a.id,a.label+' '+a.address]}));
 var sw=$('f_swallets');if(!sw.childNodes.length){PURPOSES.forEach(function(p){var l=el('label');var c=document.createElement('input');c.type='checkbox';c.value=p;c.style.width='auto';c.style.marginRight='6px';l.appendChild(c);l.appendChild(document.createTextNode(p));sw.appendChild(l)})}}
function submitAction(){var k=$('kind').value,v=function(i){return fld(i).value.trim()},input={},wallet=null;
 try{if(k==='withdraw'){wallet=v('wallet');input={asset:v('asset'),amount:v('amount'),memo:v('memo')};
   if(v('dtype')==='internal')input.destination={type:'internal',walletId:v('dwallet')};else{var addr=v('daddr'),entry=null;S.addresses.forEach(function(a){if(a.address===addr&&a.chain===v('dchain')&&(a.walletId==='*'||a.walletId===wallet))entry=a});input.destination={type:'external',chain:v('dchain'),address:addr,entryId:entry?entry.id:'none'}}}
  else if(k==='record_deposit'){wallet=v('wallet');input={asset:v('asset'),amount:v('amount'),txRef:v('txref')}}
  else if(k==='address_add'){input={walletId:v('awallet'),chain:v('dchain'),address:v('daddr'),label:v('label')}}
  else if(k==='address_remove')input={entryId:v('entry')};
  else if(k==='signer_add'){var w=[];document.querySelectorAll('#f_swallets input').forEach(function(c){if(c.checked)w.push(c.value)});input={uid:v('uid'),label:v('label'),wallets:w}}
  else if(k==='signer_remove')input={signerId:v('signer')};
  else if(k==='policy_change'){wallet=v('wallet');input=JSON.parse(fld('json').value)}
  else if(k==='unfreeze')input={reason:v('memo')};
  else if(k==='recovery_rotate'){var j=JSON.parse(fld('json').value);input={publicKey:j.publicKey,k:j.k,n:j.n,setId:j.setId}}
 }catch(e){msg('newMsg','Check the fields: '+e.message,false);return}
 api('actions',{kind:k,walletId:wallet,input:input}).then(function(j){msg('newMsg',j.error?errText(j):'Proposed. It now needs approvals from other signers.',!j.error);if(!j.error)load()})}
/* ---- setup ---- */
function setupPanel(){var admin=S.viewer&&S.viewer.role==='admin';$('setup').classList.toggle('hide',S.sealed||!admin);$('newAction').classList.toggle('hide',!S.sealed);
 var sel=$('sw_wallet');if(!sel.childNodes.length){S.wallets.forEach(function(w){var o=el('option',null,w.label);o.value=w.id;sel.appendChild(o)});sel.addEventListener('change',fillPolicy);fillPolicy()}}
function fillPolicy(){var w=S.wallets.filter(function(x){return x.id===$('sw_wallet').value})[0];$('sw_policy').value=JSON.stringify(w.policy,null,2);$('sw_kind').value=w.custody.kind;$('sw_ref').value=w.custody.ref||'';$('sw_chains').value=(w.custody.chains||[]).join(',')}
function loadUsers(){fetch('/api/identity/users',{credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){var s=$('sd_user');s.textContent='';(j.users||[]).filter(function(u){return u.role==='admin'||u.role==='trader'}).forEach(function(u){var o=el('option',null,u.email+' ('+u.role+')');o.value=u.id||u.uid;s.appendChild(o)})}).catch(function(){})}
function render(){head();walletCards();signers();addresses();actions();fillSelects();showFields();setupPanel()}
function load(){return api('state').then(function(j){if(j.__status===401){$('auth').classList.remove('hide');$('app').classList.add('hide');return}if(j.error){$('auth').classList.remove('hide');$('authMsg').textContent=errText(j);$('app').classList.add('hide');return}S=j;$('auth').classList.add('hide');$('app').classList.remove('hide');render()})}
$('kind').addEventListener('change',showFields);$('f_dtype').addEventListener('change',dtype);$('submitNew').addEventListener('click',submitAction);$('enrol').addEventListener('click',enrol);
$('freeze').addEventListener('click',function(){var r=prompt('Reason for freezing all wallet activity');if(r)api('freeze',{reason:r}).then(function(j){msg('actMsg',j.error?errText(j):'Frozen.',!j.error);load()})});
$('sd_go').addEventListener('click',function(){api('signers/designate',{uid:$('sd_user').value,label:$('sd_label').value,wallets:Array.prototype.filter.call(document.querySelectorAll('#sd_wallets input'),function(c){return c.checked}).map(function(c){return c.value})}).then(function(j){msg('sdMsg',j.error?errText(j):'Designated. That user must now register a security key on this page.',!j.error);load()})});
$('sw_go').addEventListener('click',function(){var body={walletId:$('sw_wallet').value};try{body.policy=JSON.parse($('sw_policy').value)}catch(e){msg('swMsg','Policy is not valid JSON',false);return}
 body.custody=$('sw_kind').value==='ledger'?{kind:'ledger'}:{kind:$('sw_kind').value,ref:$('sw_ref').value,chains:$('sw_chains').value.split(',').map(function(x){return x.trim()}).filter(Boolean)};
 api('configure',body).then(function(j){msg('swMsg',j.error?errText(j):'Saved.',!j.error);load()})});
$('rc_go').addEventListener('click',function(){var j;try{j=JSON.parse($('rc_json').value)}catch(e){msg('rcMsg','Paste the public-key.json written by the offline ceremony',false);return}api('recovery/register',{publicKey:j.publicKey,k:j.k,n:j.n,setId:j.setId}).then(function(r){msg('rcMsg',r.error?errText(r):'Recovery public key registered.',!r.error);load()})});
$('seal_go').addEventListener('click',function(){if(confirm('Seal the wallets? After this, every change needs multi-signature approval.'))api('seal',{}).then(function(r){msg('sealMsg',r.error?errText(r):'Sealed.',!r.error);load()})});
(function(){var sw=$('sd_wallets');PURPOSES.forEach(function(p){var l=el('label');var c=document.createElement('input');c.type='checkbox';c.value=p;c.style.width='auto';c.style.marginRight='6px';l.appendChild(c);l.appendChild(document.createTextNode(p));sw.appendChild(l)})})();
loadUsers();load();setInterval(function(){if(!document.hidden)load()},30000);
})();`;

export const WALLETS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Corporate Wallets - ETI</title><style>${CSS}</style></head><body><main>
<div class="bar"><h1>Corporate wallets</h1><a href="/">Dashboard</a><a href="/account" style="margin-left:12px">Account</a></div>
<p class="mut">Separate wallets for trading, treasury, operating expenses, emergency reserves and long-term holdings. ETI holds no private keys: transfers are signed by your custodian, and every withdrawal needs hardware-key approvals from other people.</p>
<div id="auth" class="card hide"><h2>Sign in required</h2><p id="authMsg" class="mut">Sign in at <a href="/account">/account</a> with multi-factor authentication, then return here.</p></div>
<div id="app" class="hide">
<div class="card"><div id="status"></div><button id="freeze" class="bad" type="button">Freeze all wallet activity</button><div id="actMsg" class="msg" role="status"></div></div>
<div id="wallets" class="grid"></div>
<div id="enrolBox" class="card hide"><h2>Register your security key</h2><p class="mut">You were designated as a signer. Use a hardware security key (or a device-bound platform authenticator); synced passkeys are refused unless the deployment allows them.</p><button id="enrol" type="button">Register security key</button><div id="enrolMsg" class="msg" role="status"></div></div>
<div class="card"><h2>Actions</h2><div class="tw"><table><thead><tr><th>Action</th><th>Status</th><th></th></tr></thead><tbody id="actions"></tbody></table></div></div>
<div id="newAction" class="card hide"><h2>Propose an action</h2>
<label for="kind">Type</label><select id="kind"><option value="withdraw">Withdrawal / transfer</option><option value="record_deposit">Record a deposit (ledger wallets)</option><option value="address_add">Whitelist an address</option><option value="address_remove">Remove a whitelisted address</option><option value="signer_add">Add a signer</option><option value="signer_remove">Remove a signer</option><option value="policy_change">Change wallet policy or custody</option><option value="unfreeze">Lift the freeze</option><option value="recovery_rotate">Rotate the recovery key</option></select>
<div data-f="wallet"><label for="f_wallet">Wallet</label><select id="f_wallet"></select></div>
<div data-f="asset"><label for="f_asset">Asset</label><input id="f_asset" value="USDT" maxlength="12"></div>
<div data-f="amount"><label for="f_amount">Amount</label><input id="f_amount" inputmode="decimal" placeholder="0.00"></div>
<div data-f="dtype"><label for="f_dtype">Destination</label><select id="f_dtype"><option value="internal">Another ETI wallet (book transfer)</option><option value="external">External address (via custodian)</option></select></div>
<div data-f="dwallet"><label for="f_dwallet">Destination wallet</label><select id="f_dwallet"></select></div>
<div data-f="awallet"><label for="f_awallet">Applies to</label><select id="f_awallet"></select></div>
<div data-f="dchain"><label for="f_dchain">Network</label><select id="f_dchain"><option>ethereum</option><option>bsc</option><option>polygon</option><option>arbitrum</option><option>tron</option><option>bitcoin</option><option>solana</option></select></div>
<div data-f="daddr"><label for="f_daddr">Address</label><input id="f_daddr" autocomplete="off" spellcheck="false"></div>
<div data-f="label"><label for="f_label">Label</label><input id="f_label" maxlength="60"></div>
<div data-f="txref"><label for="f_txref">Transaction reference</label><input id="f_txref" autocomplete="off"></div>
<div data-f="entry"><label for="f_entry">Whitelist entry</label><select id="f_entry"></select></div>
<div data-f="uid"><label for="f_uid">User id of the new signer</label><input id="f_uid" autocomplete="off"></div>
<div data-f="swallets"><label>Wallets the signer may approve</label><div id="f_swallets"></div></div>
<div data-f="signer"><label for="f_signer">Signer</label><select id="f_signer"></select></div>
<div data-f="json"><label for="f_json">JSON (policy, or the recovery public-key.json)</label><textarea id="f_json" spellcheck="false"></textarea></div>
<div data-f="memo"><label for="f_memo">Memo / reason</label><input id="f_memo" maxlength="140"></div>
<button id="submitNew" type="button">Propose</button><div id="newMsg" class="msg" role="status"></div><p class="mut">Never paste seed phrases, private keys or passphrases anywhere in ETI: they are rejected.</p></div>
<div class="card"><h2>Signers</h2><div class="tw"><table><thead><tr><th>Name</th><th>User</th><th>Wallets</th><th>Status</th><th>Keys</th></tr></thead><tbody id="signers"></tbody></table></div></div>
<div class="card"><h2>Whitelisted addresses</h2><div class="tw"><table><thead><tr><th>Label</th><th>Network</th><th>Address</th><th>Wallet</th><th>State</th></tr></thead><tbody id="addrs"></tbody></table></div></div>
<div id="setup" class="card hide"><h2>Setup (administrators, before sealing)</h2>
<h3>1. Designate signers</h3><label for="sd_user">User</label><select id="sd_user"></select><label for="sd_label">Display name</label><input id="sd_label" maxlength="60"><label>Wallets</label><div id="sd_wallets"></div><button id="sd_go" type="button">Designate</button><div id="sdMsg" class="msg" role="status"></div>
<h3>2. Wallet policy and custody</h3><label for="sw_wallet">Wallet</label><select id="sw_wallet"></select><label for="sw_kind">Custody</label><select id="sw_kind"><option value="ledger">Internal ledger (bookkeeping only)</option><option value="external_signer">External signing gateway (HSM / MPC / KMS)</option><option value="binance">Binance withdrawals</option></select><label for="sw_ref">Custodian wallet reference (an id, never a key)</label><input id="sw_ref" maxlength="64"><label for="sw_chains">Networks (comma separated)</label><input id="sw_chains"><label for="sw_policy">Policy (JSON)</label><textarea id="sw_policy" spellcheck="false"></textarea><button id="sw_go" type="button">Save wallet</button><div id="swMsg" class="msg" role="status"></div>
<h3>3. Recovery key</h3><p class="mut">Run <code>node scripts/wallet-recover.mjs init</code> offline, then paste only the public-key.json here. The shares stay with your custodians.</p><textarea id="rc_json" spellcheck="false" placeholder="public-key.json"></textarea><button id="rc_go" type="button">Register recovery public key</button><div id="rcMsg" class="msg" role="status"></div>
<h3>4. Seal</h3><button id="seal_go" type="button">Seal wallets</button><div id="sealMsg" class="msg" role="status"></div></div>
<div class="card"><h2>Backup and recovery</h2><p class="mut">Administrators can download an encrypted backup of the wallet configuration and approval history. It can only be opened with the offline recovery shares. See docs/WALLETS.md.</p><a href="/api/wallets/backup" download>Download encrypted backup</a></div>
</div></main><script>${JS}</script></body></html>`;
