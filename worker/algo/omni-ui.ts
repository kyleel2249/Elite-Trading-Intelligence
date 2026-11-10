// ETI Omnisignal X dashboard: a standalone page (GET /omnisignal) plus its script (GET /omnisignal.js).
// Hardening: strict CSP (no inline script, same-origin connections only), every dynamic value is written with
// textContent (the script never uses innerHTML), and the paper-API bearer token is typed at runtime and held in memory only.
// The script lives in String.raw so no template-literal escape can corrupt it; it must not contain backticks or "${".

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SEC = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

export const OMNI_CSS = String.raw`
:root{--bg:#0b0f14;--panel:#121923;--panel2:#18212e;--line:#263244;--text:#e6edf5;--mute:#93a1b3;--buy:#2ecc8f;--sell:#ff6b6b;--hold:#e6b450;--info:#5aa9ff;--warn:#ffb454;--bad:#ff6b6b;--good:#2ecc8f;--r:10px}
@media (prefers-color-scheme:light){:root{--bg:#f4f6f9;--panel:#fff;--panel2:#f0f3f8;--line:#d5dce6;--text:#16202c;--mute:#5a6879;--buy:#0a8f5b;--sell:#c93a3a;--hold:#9a6b00;--info:#1a62c4;--warn:#9a5b00;--bad:#c93a3a;--good:#0a8f5b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1280px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-size:20px;margin:0;letter-spacing:.04em}h1 span{color:var(--info)}
h2{font-size:13px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.badge{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--mute)}
.badge.safe{color:var(--good);border-color:var(--good)}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:end;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:12px;margin-bottom:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--mute)}
label.inline{flex-direction:row;align-items:center;gap:6px}
input,select,button{font:inherit;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-height:40px}
input[type=checkbox]{min-height:0;width:18px;height:18px}
input[type=text]{width:130px;text-transform:uppercase}input[type=password]{width:190px}
button{cursor:pointer;font-weight:600}button:hover{border-color:var(--info)}button.primary{background:var(--info);color:#fff;border-color:var(--info)}
button.danger{border-color:var(--bad);color:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
:focus-visible{outline:2px solid var(--info);outline-offset:2px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(12,1fr)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px;min-width:0}
.s12{grid-column:span 12}.s8{grid-column:span 8}.s6{grid-column:span 6}.s4{grid-column:span 4}
@media (max-width:960px){.s8,.s6,.s4{grid-column:span 12}}
.decision{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.big{font-size:34px;font-weight:800;letter-spacing:.04em;padding:4px 16px;border:2px solid currentColor;border-radius:10px}
.BUY{color:var(--buy)}.SELL{color:var(--sell)}.HOLD,.REJECTED{color:var(--hold)}.DATA_UNRELIABLE{color:var(--bad)}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.kv div{background:var(--panel2);border-radius:8px;padding:8px 10px}.kv small{display:block;color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.num{font-variant-numeric:tabular-nums}
.warn{border-left:4px solid var(--warn);background:var(--panel2);padding:8px 12px;border-radius:6px;margin:8px 0}
.bad{border-left-color:var(--bad)}.ok{border-left-color:var(--good)}
ul{margin:6px 0;padding-left:18px}li{margin:2px 0}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.scroll{overflow-x:auto}
.bull{color:var(--buy)}.bear{color:var(--sell)}.neutral{color:var(--mute)}
details summary{cursor:pointer;color:var(--info);font-size:13px;margin-top:6px}
.muted{color:var(--mute)}.small{font-size:12px}
#status{min-height:20px;margin:4px 0 12px}
.ro{position:absolute;left:-9999px}
@media (prefers-reduced-motion:no-preference){button{transition:border-color .15s}}
`;

export const OMNI_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI Omnisignal X</title><meta name="description" content="Dual-engine analytical signal dashboard with simulated paper trading. Not financial advice."><meta name="robots" content="noindex"><style>${OMNI_CSS}</style></head><body><div class="wrap">
<header><h1>ETI <span>OMNISIGNAL X</span></h1><div><span class="badge safe">Analytical + simulated paper only</span> <span class="badge">Live trading unavailable</span> <span class="badge">No withdrawals</span> <a class="badge" href="/">Main dashboard</a></div></header>
<form class="bar" id="controls" autocomplete="off">
<label>Symbol<input type="text" id="symbol" value="BTCUSDT" maxlength="20" pattern="[A-Za-z0-9]{5,20}" required></label>
<label>Strategy<select id="strategy"><option value="scalp">Scalp</option><option value="intraday" selected>Intraday</option><option value="swing">Swing</option><option value="position">Position</option></select></label>
<label class="inline"><input type="checkbox" id="e-swift" checked> Swift-inspired</label>
<label class="inline"><input type="checkbox" id="e-gainz" checked> Gainz-inspired</label>
<label>Auto-refresh<select id="auto"><option value="0">Off</option><option value="30">30 s</option><option value="60" selected>60 s</option><option value="120">120 s</option></select></label>
<button class="primary" type="submit" id="refresh">Analyse</button>
</form>
<div id="status" role="status" aria-live="polite"></div>
<div class="grid">
<section class="card s12" id="decision" aria-labelledby="h-dec"><h2 id="h-dec">Independent decision</h2><div id="decision-body" class="muted">Loading…</div></section>
<section class="card s6" id="swift"><h2>Swift-inspired engine</h2><div id="swift-body" class="muted">–</div></section>
<section class="card s6" id="gainz"><h2>GainzAlgo-inspired engine</h2><div id="gainz-body" class="muted">–</div></section>
<section class="card s6"><h2>Independent evidence families</h2><div id="evidence" class="muted">–</div></section>
<section class="card s6"><h2>Validation</h2><div id="validation" class="muted">–</div></section>
<section class="card s12"><h2>Eight-timeframe matrix</h2><div id="matrix" class="scroll muted">–</div></section>
<section class="card s6"><h2>Momentum, EMA, volatility, breakout</h2><div id="indicators" class="muted">–</div></section>
<section class="card s6"><h2>Liquidity and order book</h2><div id="liquidity" class="muted">–</div></section>
<section class="card s12"><h2>Elite Trader research</h2><div id="elite" class="muted">–</div></section>
<section class="card s12" id="scanner"><h2>Opportunity scanner and leaderboard</h2><form class="bar" id="scan-form" autocomplete="off"><label>Symbols (up to 4, comma separated)<input type="text" id="scan-symbols" value="BTCUSDT,ETHUSDT,SOLUSDT" maxlength="80" style="width:280px"></label><button type="submit" id="scan-go">Scan</button></form><div id="scan-body" class="muted">Ranks by evidence quality (validator score, reward/risk, liquidity), not by predicted profit. HOLD and REJECTED are valid outcomes and are not ranked.</div></section>
<section class="card s12" id="paper"><h2>Paper trading (simulated)</h2>
<form class="bar" id="paper-auth" autocomplete="off"><label>Paper API token (kept in memory only, never stored)<input type="password" id="token" autocomplete="off" spellcheck="false"></label><button type="submit">Connect</button><button type="button" id="p-eval">Evaluate (analyse only)</button><button type="button" id="p-open" class="primary">Evaluate &amp; open paper position</button><button type="button" id="p-tick">Tick position</button><button type="button" id="p-kill" class="danger">Engage kill switch</button></form>
<div id="paper-body" class="muted">Enter the paper API token to load simulated positions, performance and the audit trail.</div></section>
<section class="card s12"><h2>Not available yet (nothing here is simulated)</h2><div class="small muted">Strategy optimisation and model rollback, real-time alerts, exchange testnet execution, Elite Trader database inputs to fusion. Confidence is an evidence score, not a probability of profit.</div></section>
</div><p class="small muted">Analytical research tool, not financial advice. Simulated results do not guarantee future results.</p></div><script src="/omnisignal.js"></script></body></html>`;

export const OMNI_JS = String.raw`(function(){
"use strict";
var $=function(id){return document.getElementById(id)};
var state={token:null,timer:null,last:null,busy:false};
function el(tag,attrs){var e=document.createElement(tag);if(attrs){for(var k in attrs){if(k==="class")e.className=attrs[k];else if(k==="text")e.textContent=attrs[k];else e.setAttribute(k,attrs[k]);}}
 function add(c){if(c==null)return;if(Array.isArray(c)){c.forEach(add);return}e.appendChild(typeof c==="string"||typeof c==="number"?document.createTextNode(String(c)):c)}
 for(var i=2;i<arguments.length;i++)add(arguments[i]);return e}
function put(id){var n=$(id);while(n.firstChild)n.removeChild(n.firstChild);for(var i=1;i<arguments.length;i++){if(arguments[i]!=null)n.appendChild(arguments[i]);}n.classList.remove("muted")}
function fmt(n){if(n==null||!isFinite(n))return "–";var a=Math.abs(n);return a>=1000?n.toLocaleString(undefined,{maximumFractionDigits:2}):a>=1?n.toFixed(4):n.toFixed(6)}
function pct(n,d){return n==null||!isFinite(n)?"–":(n*(d?1:100)).toFixed(1)+"%"}
function num(n,d){return n==null||!isFinite(n)?"–":Number(n).toFixed(d==null?2:d)}
function kv(pairs){var d=el("div",{class:"kv"});pairs.forEach(function(p){d.appendChild(el("div",null,el("small",{text:p[0]}),el("span",{class:"num "+(p[2]||""),text:String(p[1])})))});return d}
function list(items,empty){if(!items||!items.length)return el("div",{class:"muted small",text:empty||"None"});var u=el("ul");items.forEach(function(t){u.appendChild(el("li",{text:String(t)}))});return u}
function note(text,kind){return el("div",{class:"warn "+(kind||""),text:text})}
function dirWord(d){return d>0?"LONG":d<0?"SHORT":"none"}
function dirClass(d){return d>0?"bull":d<0?"bear":"neutral"}
function setStatus(t,bad){var s=$("status");s.textContent=t||"";s.style.color=bad?"var(--bad)":"var(--mute)"}
function when(ms){return ms?new Date(ms).toISOString().replace("T"," ").slice(0,19)+" UTC":"–"}

function api(path,opts){opts=opts||{};var h={};if(opts.auth){if(!state.token)return Promise.reject(new Error("Enter the paper API token first"));h.authorization="Bearer "+state.token}
 if(opts.body){h["content-type"]="application/json"}
 return fetch(path,{method:opts.method||"GET",headers:h,body:opts.body?JSON.stringify(opts.body):undefined,cache:"no-store"}).then(function(r){return r.json().catch(function(){return {}}).then(function(j){return {status:r.status,ok:r.ok,body:j}})})}

function renderDecision(p){
 var f=p.fusion||{},d=p.decision,box=el("div");
 var top=el("div",{class:"decision"},el("div",{class:"big "+d,text:d.replace("_"," ")}),
  el("div",null,el("div",{text:"Agreement: "+String(f.agreement||"–").replace(/_/g," ").toLowerCase()}),
   el("div",{class:"muted small",text:"Evidence score "+(p.confidence||0)+"/100 "+(p.calibration&&p.calibration.status==="calibrated"?"- "+Math.round(p.calibration.observedWinRate*100)+"% of "+p.calibration.basedOn+" similar past trades closed net-positive (95% interval "+Math.round(p.calibration.interval95.low*100)+"-"+Math.round(p.calibration.interval95.high*100)+"%); a past frequency, not a forecast":"(uncalibrated; not a win probability)")}),
   el("div",{class:"muted small",text:"As of "+(p.generatedAt||"–")+(p.expiresAt?" | expires "+p.expiresAt:"")})));
 box.appendChild(top);
 if(d==="BUY"||d==="SELL"){var z=p.entryZone||[null,null],tp=p.takeProfits||[];
  box.appendChild(kv([["Entry zone",fmt(z[0])+" – "+fmt(z[1])],["Stop-loss",fmt(p.stopLoss),"bear"],["TP1",fmt(tp[0]&&tp[0].price)+" ("+num(tp[0]&&tp[0].rewardRisk)+"R)","bull"],["TP2",fmt(tp[1]&&tp[1].price)+" ("+num(tp[1]&&tp[1].rewardRisk)+"R)","bull"],["TP3",fmt(tp[2]&&tp[2].price)+" ("+num(tp[2]&&tp[2].rewardRisk)+"R)","bull"],["Reward/risk to TP3",num(p.riskRewardToTP3)+"R"]]));
  box.appendChild(note("Partial exits 40/30/30%; stop moves to break-even after TP1, trails after TP2, and is never widened. Fees and slippage are not included in these levels.","ok"));}
 else box.appendChild(note(d==="DATA_UNRELIABLE"?"Data is stale, incomplete or conflicting: no recommendation is made.":"No trade. HOLD and REJECTED are valid outcomes when the evidence is insufficient or a hard rule blocks the setup.","warn"));
 if(f.rejectedEngine)box.appendChild(note("Disagreement: "+f.rejectedEngine.engine+" was rejected. "+f.rejectedEngine.reason,"warn"));
 var dis=/SWIFT_.*_GAINZ_/.test(f.agreement||"");if(dis&&!f.rejectedEngine)box.appendChild(note("Engines disagree and independent evidence was not decisive, so ETI stands aside.","warn"));
 var det=el("details",null,el("summary",{text:"Why (decision trail)"}),list(p.reasons,"No reasons recorded"));box.appendChild(det);
 var dq=p.dataQuality||{};box.appendChild(el("div",{class:"muted small",text:"Provider: "+(dq.provider||"–")+" | timeframes loaded: "+((dq.timeframesLoaded||[]).join(", ")||"–")+" | order book: "+(dq.orderBook||"–")+" | cross-provider check: "+(dq.providerCrossCheck||"–")}));
 put("decision-body",box)}

function renderEngine(id,e){
 if(!e){put(id,el("div",{text:"No data"}));return}
 var box=el("div"),cls=e.status==="SIGNAL"?dirClass(e.direction):"neutral";
 box.appendChild(kv([["Status",e.status,cls],["Direction",dirWord(e.direction),cls],["Evidence score",e.confidence+"/100"],["Regime",e.regime||"–"],["Holding",e.expectedHolding||"–"]]));
 if(e.status==="SIGNAL"){var z=e.entryZone||[],tp=e.takeProfits||[];box.appendChild(kv([["Entry zone",fmt(z[0])+" – "+fmt(z[1])],["Stop",fmt(e.stopLoss)],["TP1/TP2/TP3",tp.map(function(t){return fmt(t.price)}).join(" / ")]]))}
 box.appendChild(el("details",null,el("summary",{text:"Evidence ("+(e.evidence||[]).length+")"}),list(e.evidence)));
 if(e.invalidation&&e.invalidation.length)box.appendChild(el("details",null,el("summary",{text:"Invalidation conditions"}),list(e.invalidation)));
 put(id,box)}

function renderEvidence(p){
 var inv=p.fusion&&p.fusion.investigation;if(!inv){put("evidence",el("div",{class:"muted",text:"Independent investigation not run (execution timeframe data unavailable)."}));return}
 var t=el("table"),b=el("tbody");t.appendChild(el("thead",null,el("tr",null,el("th",{text:"Family"}),el("th",{text:"Vote"}),el("th",{text:"Detail"}))));
 inv.votes.forEach(function(v){b.appendChild(el("tr",null,el("td",{text:v.family}),el("td",{class:v.vote>0?"bull":v.vote<0?"bear":"neutral",text:v.vote>0?"bullish":v.vote<0?"bearish":"neutral"}),el("td",{text:v.detail})))});t.appendChild(b);
 var box=el("div",{class:"scroll"},t);
 box.appendChild(el("div",{class:"muted small",text:"Net margin: bullish "+inv.margin["1"]+", bearish "+inv.margin["-1"]+". Disagreements are settled by this evidence, never a majority vote."}));put("evidence",box)}

function renderValidation(p){
 var v=p.validation;if(!v){put("validation",el("div",{class:"muted",text:"Validation runs only when the engines propose a trade."}));return}
 var box=el("div");box.appendChild(kv([["Score",num(v.score,1)+"/100"],["Class",v.classification],["Supporting",v.supportingFamilies],["Opposing",v.opposingFamilies],["Live execution",v.liveExecutionAllowed?"eligible":"blocked"]]));
 if(v.hardFailures&&v.hardFailures.length){box.appendChild(note("Hard rejections (cannot be overridden by score):","bad"));box.appendChild(list(v.hardFailures))}
 if(v.warnings&&v.warnings.length){box.appendChild(note("Warnings:","warn"));box.appendChild(list(v.warnings))}
 var t=el("table"),tb=el("tbody");Object.keys(v.components||{}).forEach(function(k){tb.appendChild(el("tr",null,el("td",{text:k}),el("td",{class:"num",text:num(v.components[k],0)}),el("td",{class:"num muted",text:"weight "+num(v.weights[k],0)+"%"})))});t.appendChild(tb);box.appendChild(el("div",{class:"scroll"},t));
 box.appendChild(el("details",null,el("summary",{text:"Checklist"}),list((v.checklist||[]).map(function(c){return (c.pass===true?"PASS":c.pass===false?"FAIL":"n/a")+" - "+c.question+" ("+c.detail+")"}))));put("validation",box)}

function renderMatrix(p){
 var tfs=["1m","5m","15m","30m","1h","4h","1d","1w"],t=el("table"),h=["TF","Trend","Score","Momentum","EMA","Bands","ADX","ATR %","Rel vol","Structure","Divergence"];
 t.appendChild(el("thead",null,el("tr",null,h.map(function(x){return el("th",{text:x})}))));var b=el("tbody");
 tfs.forEach(function(tf){var s=p.timeframes&&p.timeframes[tf];
  if(!s){b.appendChild(el("tr",null,el("td",{text:tf}),el("td",{class:"muted",colspan:"10",text:"not loaded or too few candles"})));return}
  var c=function(x){return x==="bull"?"bull":x==="bear"?"bear":"neutral"};
  b.appendChild(el("tr",null,el("td",{text:tf}),el("td",{class:c(s.trend),text:s.trend}),el("td",{class:"num",text:num(s.trendScore,0)}),el("td",{class:"num",text:num(s.momentum,0)}),el("td",{class:c(s.emaAlignment),text:s.emaAlignment}),el("td",{class:c(s.bandTrend),text:s.bandTrend+(s.choppy?" (choppy)":"")}),el("td",{class:"num",text:num(s.adx,0)}),el("td",{class:"num",text:num(s.atrPercent,2)}),el("td",{class:"num",text:num(s.relativeVolume,2)+(s.volumeConfirms?" ✓":"")}),el("td",{text:s.structureBias}),el("td",{text:s.divergence})))});
 t.appendChild(b);var c=p.consensus,box=el("div",null,el("div",{class:"scroll"},t));
 if(c){box.appendChild(el("div",{class:"small muted",text:"Consensus "+c.direction+" (weighted "+num(c.weightedScore,1)+", "+c.bullish+" bull / "+c.bearish+" bear / "+c.neutral+" neutral)"+(c.degraded?" - DEGRADED: some timeframes missing":"")+(c.dominantTimeframe?" | dominant: "+c.dominantTimeframe:"")}));(c.conflicts||[]).forEach(function(x){box.appendChild(note(x,"warn"))})}
 put("matrix",box)}

function renderIndicators(p){
 var s=(p.fusion.swift&&p.fusion.swift.details)||{},g=(p.fusion.gainz&&p.fusion.gainz.details)||{},box=el("div");
 if(g.ema)box.appendChild(kv([["EMA 9/21/50",g.ema.state,g.ema.state==="bull"?"bull":g.ema.state==="bear"?"bear":"neutral"],["Compression",num(g.ema.compression)+" ATR"+(g.ema.compressed?" (compressed)":"")],["Transition",g.ema.transition],["Potential reversal",g.ema.potentialReversal?"yes":"no"]]));
 if(g.rsi){box.appendChild(kv([["RSI",num(g.rsi.value,1)],["RSI slope",num(g.rsi.slope,2)],["Zone",g.rsi.zone],["Divergence",g.rsi.divergence],["Exhaustion",g.rsi.exhaustion?"yes":"no"]]));box.appendChild(el("div",{class:"small muted",text:"RSI extremes are context only; they are never treated as automatic reversal instructions."}))}
 if(g.breakout){var b=g.breakout;box.appendChild(kv([["Breakout",b.breakout+(b.confirmed?" (confirmed)":b.breakout!=="none"?" (unconfirmed)":"")],["Failed breakout",b.failed],["Liquidity sweep",b.liquiditySweep],["Squeeze",b.squeeze?"yes":b.squeezeReleased?"released":"no"],["Breakout volume",num(b.relativeVolume)+"x"]]));if(b.failed&&b.failed!=="none")box.appendChild(note("False-breakout warning: "+b.failed+" breakout failed back into the range.","warn"))}
 if(s.volumeMomentum){var v=s.volumeMomentum;box.appendChild(kv([["Volume momentum",num(v.score,0),v.score>0?"bull":v.score<0?"bear":"neutral"],["Buying pressure",pct(v.buyingPressure)],["Selling pressure",pct(v.sellingPressure)],["Relative volume",num(v.relativeVolume)+"x"],["Exhaustion",v.exhaustion?"yes":"no"],["Divergence",v.divergence]]))}
 var vol=s.volatility||g.volatility;if(vol)box.appendChild(kv([["ATR",pct(vol.atrPercent,1)],["Volatility",vol.classification],["Percentile",pct(vol.percentile)],["Expansion",vol.expansion?"yes":vol.contraction?"contracting":"no"]]));
 if(s.bands)box.appendChild(kv([["Adaptive bands",s.bands.trend,s.bands.trend==="bull"?"bull":"bear"],["Flips (last 50)",s.bands.flipsLast50],["Choppy",s.bands.choppy?"yes":"no"],["Reversal confirmed",s.bands.reversalConfirmed?"yes":"no"]]));
 if(!box.firstChild)box.appendChild(el("div",{class:"muted",text:"Indicator detail appears when an engine evaluates the symbol (not available when data is unreliable or the regime suspends entries)."}));put("indicators",box)}

function renderLiquidity(p){
 var l=p.liquidity;if(!l){put("liquidity",el("div",{class:"muted",text:"Order book unavailable: the signal is degraded and live execution would be blocked."}));return}
 var box=el("div");box.appendChild(kv([["Status",l.status,l.status==="ok"?"bull":l.status==="blocked"?"bear":""],["Spread",l.spreadBps==null?"–":num(l.spreadBps,1)+" bps"],["Imbalance",l.imbalance==null?"–":num(l.imbalance,2)],["Bid depth",fmt(l.bidDepth)],["Ask depth",fmt(l.askDepth)],["Book age",Math.round(l.ageMs/1000)+" s"]]));
 if(l.issues&&l.issues.length)box.appendChild(list(l.issues));if(l.deteriorating)box.appendChild(note("Liquidity is deteriorating versus the previous snapshot.","warn"));
 if(l.largeOrders&&l.largeOrders.length)box.appendChild(el("details",null,el("summary",{text:"Large resting orders ("+l.largeOrders.length+")"}),list(l.largeOrders.map(function(o){return JSON.stringify(o)}))));
 box.appendChild(el("div",{class:"small muted",text:l.caveat}));put("liquidity",box)}

function renderElite(p){
 var e=p.elite;if(!e){put("elite",el("div",{class:"muted",text:"Elite Trader assessment runs only when the engines propose a trade."}));return}
 if(!e.available){put("elite",el("div",{class:"muted",text:e.reason||"Unavailable"}));return}
 var box=el("div");box.appendChild(kv([["Alignment",e.alignment,e.alignment==="supports"?"bull":e.alignment==="opposes"?"bear":""],["Supporting / opposing",e.supporting+" / "+e.opposing],["Neutral / suppressed / n.a.",e.neutral+" / "+e.suppressed+" / "+e.notApplicable],["Gates the decision",e.influencesDecision?"yes":"no (advisory)"],["Research database",e.knowledge.profiles+" profiles, "+e.knowledge.strategies+" strategies, "+(e.knowledge.researchDate||"undated")]]));
 if(e.warnings&&e.warnings.length)box.appendChild(list(e.warnings));
 box.appendChild(el("details",null,el("summary",{text:"Principles"}),list((e.principles||[]).map(function(x){return x.principle+": "+x.status.replace(/_/g," ")+" - "+x.evidence+(x.documentedBy&&x.documentedBy.length?" ["+x.documentedBy.join(", ")+"]":"")}))));
 box.appendChild(el("div",{class:"small muted",text:"Investor disclosures: "+e.disclosures.reason}));
 box.appendChild(el("div",{class:"small muted",text:e.limitations}));put("elite",box)}

function renderAll(p){state.last=p;renderDecision(p);renderEngine("swift-body",p.fusion.swift);renderEngine("gainz-body",p.fusion.gainz);renderEvidence(p);renderValidation(p);renderMatrix(p);renderIndicators(p);renderLiquidity(p);renderElite(p)}
function clearAll(msg){["decision-body","swift-body","gainz-body","evidence","validation","matrix","indicators","liquidity","elite"].forEach(function(id){put(id,el("div",{class:"muted",text:"–"}))});put("decision-body",el("div",null,el("div",{class:"big DATA_UNRELIABLE",text:"DATA UNRELIABLE"}),note(msg,"bad")))}

function params(){var sym=$("symbol").value.trim().toUpperCase();var eng=[];if($("e-swift").checked)eng.push("swift");if($("e-gainz").checked)eng.push("gainz");return {symbol:sym,strategy:$("strategy").value,engines:eng}}
function analyse(){
 var q=params();if(!/^[A-Z0-9]{5,20}$/.test(q.symbol)){setStatus("Symbol must be 5-20 letters or digits, e.g. BTCUSDT",true);return Promise.resolve()}
 if(!q.engines.length){setStatus("Enable at least one engine",true);return Promise.resolve()}
 if(state.busy)return Promise.resolve();state.busy=true;$("refresh").disabled=true;setStatus("Analysing "+q.symbol+"…");
 return api("/api/omnisignal?symbol="+encodeURIComponent(q.symbol)+"&strategy="+q.strategy+"&engines="+q.engines.join(",")).then(function(r){
  if(r.ok&&r.body&&r.body.fusion){renderAll(r.body);setStatus("Updated "+new Date().toLocaleTimeString()+" - "+q.symbol+" "+q.strategy)}
  else{clearAll(r.body&&r.body.error?"Market data unavailable ("+r.body.error+"). No stale values are shown.":"Request failed (HTTP "+r.status+")");setStatus("Analysis failed",true)}
 }).catch(function(e){clearAll("Network error: "+e.message);setStatus("Analysis failed",true)}).then(function(){state.busy=false;$("refresh").disabled=false})}

function schedule(){if(state.timer){clearInterval(state.timer);state.timer=null}var s=Number($("auto").value);if(s>0)state.timer=setInterval(function(){if(!document.hidden){analyse();if(state.token)loadPaper()}},s*1000)}

// ---------- paper ----------
function paperTable(head,rows){var t=el("table");t.appendChild(el("thead",null,el("tr",null,head.map(function(x){return el("th",{text:x})}))));var b=el("tbody");rows.forEach(function(r){b.appendChild(el("tr",null,r.map(function(c){return el("td",{class:"num",text:c==null?"–":String(c)})})))});t.appendChild(b);return el("div",{class:"scroll"},t)}
function repRow(name,r){return [name,r.trades,r.status==="ok"?pct(r.winRate):"withheld (n<30)",r.profitFactor==null?"withheld":(r.profitFactor===Infinity||r.profitFactor==="Infinity"?"inf":num(r.profitFactor)),r.expectancyR==null?"withheld":num(r.expectancyR)+"R",num(r.netPnl),pct(r.maxDrawdownPct)]}
function loadPaper(){
 return Promise.all([api("/api/paper/status",{auth:true}),api("/api/paper/performance",{auth:true}),api("/api/paper/audit?limit=25",{auth:true})]).then(function(rs){
  if(rs[0].status===401){state.token=null;put("paper-body",note("Unauthorised: the token was rejected.","bad"));return}
  if(!rs[0].ok){put("paper-body",note("Paper API error: "+(rs[0].body.error||rs[0].status)+(rs[0].body.message?" - "+rs[0].body.message:""),"bad"));return}
  var s=rs[0].body,perf=rs[1].body,audit=rs[2].body,box=el("div");
  box.appendChild(kv([["Equity (simulated)",num(s.equity)],["Start",num(s.startingEquity)],["Open positions",s.openPositions.length],["Closed trades",s.closedTrades],["Kill switch",s.killSwitch?"ENGAGED":"off",s.killSwitch?"bear":"bull"],["Risk gateway",s.riskGateConfigured?"configured":"NOT configured: orders are rejected",s.riskGateConfigured?"bull":"bear"],["Live trading",s.liveTradingAvailable?"available":"unavailable"],["Withdrawals",s.withdrawalPermissions?"enabled":"none"]]));
  $("p-kill").textContent=s.killSwitch?"Release kill switch":"Engage kill switch";$("p-kill").dataset.on=s.killSwitch?"0":"1";
  var sc=s.scheduler;if(sc){var lr=sc.lastRun;box.appendChild(note("Scheduled cycle: "+(sc.symbols.length?sc.symbols.join(", ")+" ("+sc.strategy+")":"no symbols configured")+" | auto-execute "+(sc.autoExecute?"ON":"off")+(lr?" | last run "+lr.at+(lr.ran?"":" (skipped: "+lr.reason+")"):" | has not run yet"),"ok"))}
  box.appendChild(el("h2",{text:"Open positions"}));
  box.appendChild(s.openPositions.length?paperTable(["Symbol","Side","Qty left","Entry","Stop","TP1","TP2","TP3","Targets hit","Realised"],s.openPositions.map(function(p){return [p.symbol,p.direction>0?"LONG":"SHORT",num(p.remainingQty,6),fmt(p.entry),fmt(p.stop),fmt(p.targets[0].price),fmt(p.targets[1].price),fmt(p.targets[2].price),p.hitTargets+"/3",num(p.realizedPnl)]})):el("div",{class:"muted small",text:"No open paper positions."}));
  box.appendChild(el("h2",{text:"Performance (simulated)"}));var w=perf.windows,rows=[];["24h","7d","30d","90d","all"].forEach(function(k){rows.push(repRow(k,w[k]))});Object.keys(perf.byEngine||{}).forEach(function(k){rows.push(repRow("engine: "+k,perf.byEngine[k]))});
  box.appendChild(paperTable(["Window","Trades","Win rate","Profit factor","Expectancy","Net P/L","Max DD"],rows));
  box.appendChild(el("div",{class:"small muted",text:perf.disclosure+" Calibration: "+(perf.calibration&&perf.calibration.note)}));
  box.appendChild(el("details",null,el("summary",{text:"Audit trail (latest "+(audit.entries||[]).length+")"}),list((audit.entries||[]).slice().reverse().map(function(e){return when(e.ts)+" "+e.type+(e.symbol?" "+e.symbol:"")+(e.detail&&e.detail.reasons?": "+e.detail.reasons.join("; "):"")}),"No audit entries yet")));
  put("paper-body",box)}).catch(function(e){put("paper-body",note("Could not reach the paper API: "+e.message,"bad"))})}
function paperAction(kind){
 var q=params(),symbol=q.symbol;if(!/^[A-Z0-9]{5,20}$/.test(symbol)){setStatus("Enter a valid symbol",true);return}
 var path,body;if(kind==="tick"){path="/api/paper/tick";body={symbol:symbol}}else if(kind==="kill"){path="/api/paper/kill";body={on:$("p-kill").dataset.on!=="0"}}else{path="/api/paper/evaluate";body={symbol:symbol,strategy:q.strategy,execute:kind==="open"}}
 if(kind==="open"&&!window.confirm("Open a SIMULATED paper position on "+symbol+" if the plan is BUY/SELL and the risk gateway approves? No real order is sent."))return;
 setStatus("Sending…");api(path,{auth:true,method:"POST",body:body}).then(function(r){
  var b=r.body||{},m=r.ok?"Done":"HTTP "+r.status;if(b.event&&b.event.type)m=b.event.type+(b.event.reasons?": "+b.event.reasons.join("; "):"");else if(b.events&&b.events.length)m="Events: "+b.events.map(function(e){return e.type}).join(", ");else if(b.message)m=b.message;else if(b.error)m=b.error;
  setStatus(m,!r.ok&&r.status!==200);return loadPaper()}).catch(function(e){setStatus(e.message,true)})}

function scanNow(){
 var raw=$("scan-symbols").value,strategy=$("strategy").value;if(!raw.trim()){setStatus("Enter at least one symbol",true);return}
 $("scan-go").disabled=true;setStatus("Scanning (a few seconds per symbol)…");
 api("/api/omnisignal/scan?strategy="+strategy+"&symbols="+encodeURIComponent(raw)).then(function(r){
  var b=r.body||{};if(!r.ok||!b.leaderboard){put("scan-body",note("Scan failed: "+(b.error||"HTTP "+r.status),"bad"));setStatus("Scan failed",true);return}
  var box=el("div",null,paperTable(["Rank","Symbol","Decision","Score","Validator","R:R to TP3","Agreement","Liquidity","Note"],b.leaderboard.map(function(x){return [x.rank==null?"–":x.rank,x.symbol,x.decision+(x.direction?" "+x.direction:""),x.opportunityScore==null?"–":num(x.opportunityScore,1),x.validationScore==null?"–":num(x.validationScore,1),x.riskRewardToTP3==null?"–":num(x.riskRewardToTP3)+"R",String(x.agreement||"–").replace(/_/g," ").toLowerCase(),x.liquidity||"–",(x.reason||"").slice(0,90)]})));
  if(b.ignoredSymbols&&b.ignoredSymbols.length)box.appendChild(note("Ignored (invalid or beyond the "+b.maxSymbols+"-symbol limit): "+b.ignoredSymbols.join(", "),"warn"));
  box.appendChild(el("div",{class:"small muted",text:b.note}));put("scan-body",box);setStatus("Scan complete "+new Date().toLocaleTimeString())
 }).catch(function(e){put("scan-body",note("Network error: "+e.message,"bad"));setStatus("Scan failed",true)}).then(function(){$("scan-go").disabled=false})}
$("scan-form").addEventListener("submit",function(ev){ev.preventDefault();scanNow()});

$("controls").addEventListener("submit",function(ev){ev.preventDefault();analyse()});
$("auto").addEventListener("change",schedule);
$("paper-auth").addEventListener("submit",function(ev){ev.preventDefault();var t=$("token").value.trim();if(!t){setStatus("Enter the token",true);return}state.token=t;$("token").value="";loadPaper()});
$("p-eval").addEventListener("click",function(){paperAction("eval")});
$("p-open").addEventListener("click",function(){paperAction("open")});
$("p-tick").addEventListener("click",function(){paperAction("tick")});
$("p-kill").addEventListener("click",function(){paperAction("kill")});
analyse();schedule();
})();`;

export function handleOmniUi(req: Request): Response | null {
  const path = new URL(req.url).pathname;
  if (path !== "/omnisignal" && path !== "/omnisignal.js") return null;
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD", ...SEC } });
  return path === "/omnisignal"
    ? new Response(req.method === "HEAD" ? null : OMNI_HTML, { headers: { ...SEC, "content-type": "text/html; charset=utf-8" } })
    : new Response(req.method === "HEAD" ? null : OMNI_JS, { headers: { ...SEC, "content-type": "text/javascript; charset=utf-8" } });
}
