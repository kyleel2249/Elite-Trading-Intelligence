/** /account page. Plain DOM APIs and textContent only (no innerHTML with server data). All requests are same-origin; credentials never leave HttpOnly cookies. */
const CSS = `:root{--bg:#0b0f17;--card:#121a27;--line:#223048;--fg:#e6edf7;--mut:#8da0bb;--ok:#2fd18b;--bad:#ff6b6b;--acc:#4da3ff}
@media (prefers-color-scheme:light){:root{--bg:#f4f7fb;--card:#fff;--line:#d5deeb;--fg:#122033;--mut:#52637d;--ok:#0a8f5b;--bad:#c0392b;--acc:#1763c7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:20px;margin:8px 0 16px}h2{font-size:16px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
label{display:block;font-size:13px;color:var(--mut);margin:8px 0 4px}input,select{width:100%;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:inherit}
button{padding:10px 14px;border-radius:8px;border:0;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer;margin:10px 8px 0 0}button.sec{background:transparent;border:1px solid var(--line);color:var(--fg)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.msg{min-height:1.4em;margin-top:8px;font-size:14px}.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}.mut{color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}
code{font-family:ui-monospace,Menlo,monospace;background:var(--bg);padding:2px 5px;border-radius:5px}.codes{columns:2;font-family:ui-monospace,Menlo,monospace}
.hide{display:none}.tw{overflow-x:auto}a{color:var(--acc)}`;
const JS = `(function(){
var $=function(i){return document.getElementById(i)};
function show(id,on){$(id).classList.toggle('hide',!on)}
function msg(id,t,ok){var e=$(id);e.textContent=t||'';e.className='msg '+(t?(ok?'ok':'bad'):'')}
function api(path,body){return fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){j._status=r.status;return j})})}
function cell(tr,t){var td=document.createElement('td');td.textContent=t==null?'':String(t);tr.appendChild(td);return td}
var me=null,codesShown=false;
function render(){
 show('login',!me);show('acct',!!me);
 if(!me){return}
 $('who').textContent=me.email+' - '+me.role+(me.mfa?' - MFA verified':'');
 show('mfaBox',me.limited||!me.mfa||codesShown);show('enrol',!me.mfa);
 $('mfaNote').textContent=me.limited?'Your role requires multi-factor authentication. Enrol now to unlock privileges.':'Add an authenticator app to protect this account.';
 show('admin',!me.limited&&me.permissions.indexOf('users.manage')>=0);
 if(!$('admin').classList.contains('hide')){loadUsers();loadAudit()}
}
function load(){return api('/api/identity/me').then(function(j){me=j.user||null;render()})}
function loadUsers(){api('/api/identity/users').then(function(j){var b=$('users');b.textContent='';(j.users||[]).forEach(function(u){var tr=document.createElement('tr');cell(tr,u.email);cell(tr,u.role);cell(tr,u.mfaEnabled?'on':'off');cell(tr,u.disabled?'disabled':(u.locked?'locked':'active'));
 var td=document.createElement('td');
 [['disable',u.disabled?'Enable':'Disable'],['reset-mfa','Reset MFA'],['revoke','Sign out']].forEach(function(a){var bt=document.createElement('button');bt.className='sec';bt.textContent=a[1];bt.addEventListener('click',function(){api('/api/identity/users/'+u.id+'/'+(a[0]==='disable'&&u.disabled?'enable':a[0]),{}).then(function(r){msg('adminMsg',r.error?(r.message||r.error):'Done.',!r.error);loadUsers()})});td.appendChild(bt)});
 tr.appendChild(td);b.appendChild(tr)})})}
function loadAudit(){api('/api/identity/audit?limit=25').then(function(j){var b=$('audit');b.textContent='';(j.rows||[]).forEach(function(r){var tr=document.createElement('tr');cell(tr,r.seq);cell(tr,new Date(r.at).toISOString().replace('T',' ').slice(0,19));cell(tr,r.action);cell(tr,r.target);b.appendChild(tr)})});
 api('/api/identity/audit/verify').then(function(v){msg('chainMsg',v.ok?'Audit chain intact ('+v.rows+' records).':'AUDIT CHAIN BROKEN at record '+v.brokenAt,!!v.ok)})}
$('loginForm').addEventListener('submit',function(e){e.preventDefault();var b={email:$('email').value,password:$('pw').value};if($('code').value)b.code=$('code').value;if($('rc').value)b.recoveryCode=$('rc').value;
 api('/api/identity/login',b).then(function(j){if(j.error==='mfa_required'){show('codeRow',true);msg('loginMsg',j.message,false);return}if(j.error){msg('loginMsg',j.message||j.error,false);return}$('pw').value='';$('code').value='';$('rc').value='';msg('loginMsg','',true);load()})});
$('logout').addEventListener('click',function(){api('/api/identity/logout',{}).then(function(){me=null;codesShown=false;show('codesBox',false);$('codes').textContent='';render()})});
$('enrol').addEventListener('click',function(){api('/api/identity/mfa/enroll',{}).then(function(j){if(j.error){msg('mfaMsg',j.message||j.error,false);return}$('secret').textContent=j.secret;$('uri').textContent=j.otpauthUri;show('enrolled',true);msg('mfaMsg','',true)})});
$('confirm').addEventListener('click',function(){api('/api/identity/mfa/confirm',{code:$('mfaCode').value}).then(function(j){if(j.error){msg('mfaMsg',j.message||j.error,false);return}var d=$('codes');d.textContent='';j.recoveryCodes.forEach(function(c){var s=document.createElement('div');s.textContent=c;d.appendChild(s)});codesShown=true;show('codesBox',true);show('enrolled',false);msg('mfaMsg',j.note,true);load()})});
$('pwForm').addEventListener('submit',function(e){e.preventDefault();api('/api/identity/password',{current:$('cur').value,next:$('nxt').value}).then(function(j){msg('pwMsg',j.error?(j.message||j.error):'Password changed. Other sessions were signed out.',!j.error);if(!j.error){$('cur').value='';$('nxt').value=''}})});
$('newForm').addEventListener('submit',function(e){e.preventDefault();api('/api/identity/users',{email:$('nEmail').value,password:$('nPw').value,role:$('nRole').value}).then(function(j){msg('adminMsg',j.error?(j.message||j.error):'Account created.',!j.error);if(!j.error){$('nPw').value='';loadUsers()}})});
load()})();`;
export const ACCOUNT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Account</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body><main>
<h1>ETI account <span class="mut">- <a href="/">dashboard</a></span></h1>
<section class="card" id="login"><h2>Sign in</h2><form id="loginForm" autocomplete="on"><label for="email">Email</label><input id="email" type="email" autocomplete="username" required><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
<div id="codeRow" class="hide"><label for="code">Authenticator code</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"><label for="rc">or a recovery code</label><input id="rc" autocomplete="off"></div>
<button type="submit">Sign in</button><div id="loginMsg" class="msg" role="status" aria-live="polite"></div></form>
<p class="mut">No account yet? The first administrator is created with the master execution token (see docs/SECURITY.md).</p></section>
<div id="acct" class="hide">
<section class="card"><h2>Signed in</h2><p id="who"></p><button class="sec" id="logout">Sign out</button></section>
<section class="card hide" id="mfaBox"><h2>Multi-factor authentication</h2><p id="mfaNote" class="mut"></p><button id="enrol">Set up authenticator</button>
<div id="enrolled" class="hide"><p>Add this key to an authenticator app (manual entry), or open the link on a device that has one:</p><p><code id="secret"></code></p><p class="tw"><code id="uri"></code></p><label for="mfaCode">Current 6-digit code</label><input id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8"><button id="confirm">Confirm and enable</button></div>
<div id="codesBox" class="hide"><p><strong>Recovery codes - shown once.</strong> Save them offline. Each works one time.</p><div class="codes" id="codes"></div></div><div id="mfaMsg" class="msg" role="status" aria-live="polite"></div></section>
<section class="card"><h2>Change password</h2><form id="pwForm"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required><label for="nxt">New password (12+ characters)</label><input id="nxt" type="password" autocomplete="new-password" required><button type="submit">Change password</button><div id="pwMsg" class="msg" role="status" aria-live="polite"></div></form></section>
<section class="card hide" id="admin"><h2>Administration</h2>
<form id="newForm"><label for="nEmail">New account email</label><input id="nEmail" type="email" required><label for="nPw">Initial password</label><input id="nPw" type="password" autocomplete="new-password" required><label for="nRole">Role</label><select id="nRole"><option>viewer</option><option>analyst</option><option>paper_trader</option><option>trader</option><option>admin</option></select><button type="submit">Create account</button></form>
<div id="adminMsg" class="msg" role="status" aria-live="polite"></div><div class="tw"><table><thead><tr><th>Email</th><th>Role</th><th>MFA</th><th>Status</th><th>Actions</th></tr></thead><tbody id="users"></tbody></table></div>
<h2 style="margin-top:18px">Audit trail</h2><div id="chainMsg" class="msg" role="status"></div><div class="tw"><table><thead><tr><th>#</th><th>Time (UTC)</th><th>Action</th><th>Target</th></tr></thead><tbody id="audit"></tbody></table></div></section>
</div></main><script>${JS}</script></body></html>`;
