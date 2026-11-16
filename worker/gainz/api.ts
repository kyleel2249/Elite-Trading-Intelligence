import { getMarketData, providerOrder, INTERVALS, type MarketEnv } from "../market.ts";
import { independentMarketAssessment, parseSignal, evaluateConsensus, type NormalizedGainzSignal } from "./engine.ts";
import { detectFVG, detectDisplacement } from "../analysis/smc.ts";
import { handlePerp } from "../perp/routes.ts";

export interface GainzEnv extends MarketEnv {
  ETI_PORTFOLIO_DB?: D1Database;
  ETI_GAINZ_WEBHOOK_SECRET?: string;
  ETI_GAINZ_ADMIN_TOKEN?: string;
  ETI_EXECUTION_TOKEN?: string;
}
const H = { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", "access-control-allow-origin":"*" };
const reply = (data: unknown, status=200, extra: Record<string,string>={}) => new Response(JSON.stringify(data),{status,headers:{...H,...extra}});
const MAX_BODY = 256 * 1024;
const nowIso = (n:number) => new Date(n).toISOString();
async function bodyText(req:Request):Promise<string|null>{ const len=Number(req.headers.get("content-length")||0); if(len>MAX_BODY)return null; const t=await req.text(); return t.length<=MAX_BODY?t:null; }
async function jsonBody(req:Request){ const t=await bodyText(req); if(t===null)return null; try{return JSON.parse(t)}catch{return null;} }
async function tokenOk(req:Request, env:GainzEnv):Promise<boolean>{
  const expected=env.ETI_GAINZ_ADMIN_TOKEN||env.ETI_EXECUTION_TOKEN, supplied=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
  if(!expected||!supplied||supplied.length!==expected.length)return false;
  const [a,b]=await Promise.all([expected,supplied].map(v=>crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))));
  const x=new Uint8Array(a),y=new Uint8Array(b);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
async function hmacOk(secret:string,ts:string,raw:string,signature:string):Promise<boolean>{
  if(!/^\d{10,13}$/.test(ts)||!/^sha256=[a-f0-9]{64}$/i.test(signature))return false;
  const ms=Number(ts)*(ts.length===10?1000:1); if(!Number.isFinite(ms)||Math.abs(Date.now()-ms)>300_000)return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const mac=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(ts+"."+raw)));
  const hex=[...mac].map(x=>x.toString(16).padStart(2,"0")).join("");
  const got=signature.slice(7).toLowerCase();let d=hex.length^got.length;for(let i=0;i<Math.min(hex.length,got.length);i++)d|=hex.charCodeAt(i)^got.charCodeAt(i);return d===0;
}
function db(env:GainzEnv){return env.ETI_PORTFOLIO_DB;}
async function event(d:D1Database,id:string,type:string,payload:unknown,at:number){await d.prepare("INSERT INTO gainz_events(signal_id,event_type,payload_json,created_at) VALUES(?,?,?,?)").bind(id,type,JSON.stringify(payload),at).run();}
async function persistSignal(d:D1Database,s:NormalizedGainzSignal){
  const existing=await d.prepare("SELECT id FROM gainz_signals WHERE id=?").bind(s.id).first<{id:string}>();
  if(existing)return {duplicate:true};
  const peer=await d.prepare("SELECT engine,direction,signal_timestamp FROM gainz_signals WHERE symbol=? AND timeframe=? AND engine<>? AND received_at>=? ORDER BY received_at DESC LIMIT 1")
    .bind(s.symbol,s.timeframe,s.engine,s.receivedAt-900_000).first<{engine:string;direction:string;signal_timestamp:number}>();
  const c=evaluateConsensus(s,peer||null);s.consensus=c.consensus;s.consensusScore=c.consensusScore;
  await d.prepare("INSERT INTO gainz_signals(id,engine,preset,symbol,exchange_name,market,direction,timeframe,signal_timestamp,received_at,entry,stop_loss,tp1,tp2,tp3,state,score,consensus,consensus_score,reward_risk,reasons_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(s.id,s.engine,s.preset,s.symbol,s.exchange,s.market,s.direction,s.timeframe,s.signalTimestamp,s.receivedAt,s.entry,s.stopLoss,s.targets[0]??null,s.targets[1]??null,s.targets[2]??null,s.state,s.score,s.consensus,s.consensusScore,s.rewardRisk,JSON.stringify(s.reasons),JSON.stringify(s.payload)).run();
  await event(d,s.id,"signal_received",{engine:s.engine,direction:s.direction,state:s.state},s.receivedAt);
  if(peer)await event(d,s.id,"dual_engine_"+s.consensus,{peerEngine:peer.engine,peerDirection:peer.direction,consensusScore:s.consensusScore},s.receivedAt);
  return {duplicate:false,consensus:s.consensus,consensusScore:s.consensusScore};
}
async function ensureTables(d:D1Database){return await d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='gainz_signals'").first<{name:string}>();}
const LIMIT=(v:string|null,d=50)=>Math.max(1,Math.min(200,Math.floor(Number(v)||d)));
export async function handleGainz(req:Request,env:GainzEnv,now=Date.now()):Promise<Response>{
  const url=new URL(req.url),path=url.pathname.replace(/\/+$/,"")||"/";
  if(path==="/gainz"&&req.method==="GET")return new Response(gainzPage,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
  if(!path.startsWith("/api/gainz"))return reply({error:"not_found"},404);
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{...H,"access-control-allow-methods":"GET,POST,PUT,OPTIONS","access-control-allow-headers":"authorization,content-type,x-eti-gainz-timestamp,x-eti-gainz-signature"}});
  if(path==="/api/gainz/webhook"){
    if(req.method!=="POST")return reply({error:"method_not_allowed"},405);
    if(!env.ETI_GAINZ_WEBHOOK_SECRET)return reply({error:"webhook_not_configured",detail:"Set ETI_GAINZ_WEBHOOK_SECRET as a Worker secret."},503);
    const raw=await bodyText(req);if(raw===null)return reply({error:"body_too_large_or_unreadable"},413);
    if(!await hmacOk(env.ETI_GAINZ_WEBHOOK_SECRET,req.headers.get("x-eti-gainz-timestamp")||"",raw,req.headers.get("x-eti-gainz-signature")||""))return reply({error:"invalid_webhook_signature_or_timestamp"},401);
    let p:any;try{p=JSON.parse(raw)}catch{return reply({error:"invalid_json"},400);}
    const cfgRow=await d.prepare("SELECT config_json FROM gainz_config WHERE id=1").first<any>();
    const cfg={...defaultConfig,...(cfgRow?JSON.parse(cfgRow.config_json):{})};
    const s=parseSignal(p,now,cfg.maxSignalAgeSeconds,cfg.minimumRewardRisk);if(!s)return reply({error:"invalid_signal_payload",required:["engine","symbol","direction","timeframe","signalTimestamp"]},400);
    const d=db(env);if(!d)return reply({error:"database_not_configured"},503);
    try{if(!await ensureTables(d))return reply({error:"migration_required",migration:"0014_gainz_intelligence.sql"},503);const saved=await persistSignal(d,s);return reply({accepted:!saved.duplicate,duplicate:saved.duplicate,signalId:s.id,state:s.state,consensus:s.consensus,consensusScore:s.consensusScore},saved.duplicate?200:202);}
    catch(e){return reply({error:"signal_persistence_failed",detail:e instanceof Error?e.message:"database error"},503);}
  }
  if(path==="/api/gainz/status"&&req.method==="GET"){
    const d=db(env);let ready=false;try{ready=!!(d&&await ensureTables(d));}catch{}
    return reply({service:"ETI GainzAlgo Intelligence Centre",engines:["gainz_v2","gainz_v2_alpha"],databaseConfigured:!!d,databaseReady:ready,webhookConfigured:!!env.ETI_GAINZ_WEBHOOK_SECRET,executionMode:"existing ETI paper/testnet safeguards only",automaticOrderSubmission:false,proprietaryAlgorithmsAccessible:false,asOf:nowIso(now)});
  }
  if(!await tokenOk(req,env))return reply({error:"unauthorized",detail:"Use the ETI Gainz admin token or execution token."},401,{"www-authenticate":"Bearer"});
  const d=db(env);if(!d)return reply({error:"database_not_configured"},503);
  if(!await ensureTables(d))return reply({error:"migration_required",migration:"0014_gainz_intelligence.sql"},503);
  if(path==="/api/gainz/signals"&&req.method==="GET"){
    const engine=url.searchParams.get("engine"),symbol=url.searchParams.get("symbol")?.toUpperCase(),limit=LIMIT(url.searchParams.get("limit"));
    const rows=await d.prepare("SELECT id,engine,preset,symbol,exchange_name,market,direction,timeframe,signal_timestamp,received_at,entry,stop_loss,tp1,tp2,tp3,state,score,consensus,consensus_score,reward_risk,reasons_json FROM gainz_signals WHERE (? IS NULL OR engine=?) AND (? IS NULL OR symbol=?) ORDER BY received_at DESC LIMIT ?")
      .bind(engine,engine,symbol||null,symbol||null,limit).all();
    return reply({count:rows.results.length,signals:rows.results});
  }
  if(path==="/api/gainz/compare"&&req.method==="GET"){
    const rows=await d.prepare("SELECT s.engine,COUNT(*) AS signals, SUM(CASE WHEN s.consensus='agreement' THEN 1 ELSE 0 END) AS agreements,SUM(CASE WHEN s.consensus='conflict' THEN 1 ELSE 0 END) AS conflicts,COUNT(o.signal_id) AS resolved,SUM(CASE WHEN o.outcome='win' THEN 1 ELSE 0 END) AS wins,SUM(CASE WHEN o.outcome='loss' THEN 1 ELSE 0 END) AS losses,AVG(o.net_r) AS avg_net_r FROM gainz_signals s LEFT JOIN gainz_outcomes o ON o.signal_id=s.id GROUP BY s.engine").all();
    const outcomes=await d.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins, SUM(CASE WHEN outcome='loss' THEN 1 ELSE 0 END) AS losses, SUM(net_r) AS net_r FROM gainz_outcomes").first<any>();
    return reply({engines:rows.results,combined:outcomes,note:"Metrics use only manually or independently resolved outcomes; no win rate is inferred from signal direction."});
  }
  if(path==="/api/gainz/config"&&req.method==="GET"){
    const row=await d.prepare("SELECT config_json,updated_at FROM gainz_config WHERE id=1").first<any>();
    return reply({config:row?JSON.parse(row.config_json):defaultConfig,updatedAt:row?.updated_at??null});
  }
  if(path==="/api/gainz/config"&&req.method==="PUT"){
    const p=await jsonBody(req);if(!p||typeof p!=="object")return reply({error:"invalid_json"},400);
    const c:any={...defaultConfig,...p};
    if(!["manual_approval","analysis_only"].includes(c.executionMode))return reply({error:"invalid_execution_mode"},400);
    if(!Number.isFinite(c.v2Weight)||!Number.isFinite(c.alphaWeight)||c.v2Weight<0||c.alphaWeight<0||c.v2Weight+c.alphaWeight<=0)return reply({error:"invalid_engine_weights"},400);
    if(!Number.isFinite(c.minimumRewardRisk)||c.minimumRewardRisk<0.1||c.minimumRewardRisk>20)return reply({error:"invalid_minimum_reward_risk"},400);
    if(!Number.isInteger(c.maxSignalAgeSeconds)||c.maxSignalAgeSeconds<60||c.maxSignalAgeSeconds>86400)return reply({error:"invalid_max_signal_age"},400);
    c.v2Weight=Math.min(100,c.v2Weight);c.alphaWeight=Math.min(100,c.alphaWeight);c.autoExecute=false;
    await d.prepare("INSERT INTO gainz_config(id,config_json,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json,updated_at=excluded.updated_at").bind(JSON.stringify(c),now).run();
    return reply({saved:true,config:c,updatedAt:nowIso(now)});
  }

  if((path==="/api/gainz/execute/preview"||path==="/api/gainz/execute")&&req.method==="POST"){
    const p=await jsonBody(req);if(!p||typeof p.signalId!=="string")return reply({error:"invalid_execution_request"},400);
    const row=await d.prepare("SELECT id,engine,symbol,market,direction,signal_timestamp,state,reward_risk FROM gainz_signals WHERE id=?").bind(p.signalId).first<any>();
    if(!row)return reply({error:"signal_not_found"},404);
    if(row.state!=="validated")return reply({error:"signal_not_executable",state:row.state},409);
    const cfgRow=await d.prepare("SELECT config_json FROM gainz_config WHERE id=1").first<any>();
    const cfg={...defaultConfig,...(cfgRow?JSON.parse(cfgRow.config_json):{})};
    if(now-Number(row.signal_timestamp)>Number(cfg.maxSignalAgeSeconds)*1000)return reply({error:"signal_expired"},409);
    if(row.market!=="futures")return reply({error:"futures_signal_required",detail:"This execution bridge routes futures signals through ETI's existing perpetual paper/testnet gateway. Spot signals remain analysis-only."},422);
    if(Number(row.reward_risk)<Number(cfg.minimumRewardRisk))return reply({error:"reward_risk_below_policy",minimum:cfg.minimumRewardRisk,actual:row.reward_risk},422);
    const environment=String(p.environment||"perp_paper");
    if(!["perp_paper","perp_testnet"].includes(environment))return reply({error:"invalid_environment"},400);
    const quantity=Number(p.quantity),leverage=Number(p.leverage??1),type=String(p.type||"market");
    if(!(Number.isFinite(quantity)&&quantity>0)||!(Number.isFinite(leverage)&&leverage>=1&&leverage<=150)||!["market","limit"].includes(type))return reply({error:"invalid_order_parameters"},400);
    const executionToken=env.ETI_EXECUTION_TOKEN;
    if(!executionToken)return reply({error:"execution_gateway_not_configured"},503);
    const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(row.id+":"+environment)));
    const clientOrderId="gz"+[...digest].slice(0,12).map(x=>x.toString(16).padStart(2,"0")).join("");
    const order={environment,symbol:row.symbol,side:row.direction==="BUY"?"buy":"sell",type,quantity,limitPrice:type==="limit"?Number(p.limitPrice):null,leverage,reduceOnly:false,source:row.engine,clientOrderId};
    const isPreview=path.endsWith("/preview");
    if(!isPreview&&p.confirm!==true)return reply({error:"explicit_confirmation_required"},400);
    const target=isPreview?"/api/perp/preview":"/api/perp/order";
    const upstream=await handlePerp(new Request("https://eti.internal"+target,{method:"POST",headers:{"authorization":"Bearer "+executionToken,"content-type":"application/json"},body:JSON.stringify(order)}),env as any);
    const result=await upstream.json().catch(()=>({error:"invalid_execution_response"}));
    if(!isPreview)await event(d,row.id,"execution_"+(upstream.ok?"submitted":"rejected"),{environment,order,result},now);
    return reply({ok:upstream.ok,signalId:row.id,engine:row.engine,environment,order,result},upstream.status);
  }
  if(path==="/api/gainz/outcomes"&&req.method==="POST"){
    const p=await jsonBody(req);if(!p||typeof p!=="object"||typeof p.signalId!=="string"||!["win","loss","breakeven","cancelled"].includes(p.outcome))return reply({error:"invalid_outcome"},400);
    const netR=Number(p.netR);if(!Number.isFinite(netR)||Math.abs(netR)>100)return reply({error:"invalid_net_r"},400);
    const signal=await d.prepare("SELECT id FROM gainz_signals WHERE id=?").bind(p.signalId).first<any>();if(!signal)return reply({error:"signal_not_found"},404);
    try{await d.prepare("INSERT INTO gainz_outcomes(signal_id,outcome,net_r,pnl,closed_at,notes) VALUES(?,?,?,?,?,?)").bind(p.signalId,p.outcome,netR,Number.isFinite(Number(p.pnl))?Number(p.pnl):null,now,String(p.notes||"").slice(0,1000)).run();}
    catch{return reply({error:"outcome_already_recorded"},409);}
    await event(d,p.signalId,"outcome_recorded",{outcome:p.outcome,netR},now);return reply({saved:true,signalId:p.signalId});
  }
  if(path==="/api/gainz/analyse"&&req.method==="GET"){
    const symbol=(url.searchParams.get("symbol")||"BTCUSDT").toUpperCase(),interval=url.searchParams.get("interval")||"15m",market=url.searchParams.get("market")==="futures"?"futures":"spot";
    if(!/^[A-Z0-9]{5,24}$/.test(symbol)||!INTERVALS.includes(interval))return reply({error:"invalid_symbol_or_interval"},400);
    try{
      const result=await getMarketData("klines",{symbol,interval,limit:300,market},providerOrder(env));
      const rows=result.data as any[];
      const assessment=independentMarketAssessment(rows as any);
      return reply({symbol,interval,market,provider:result.provider,assessment,fairValueGaps:detectFVG(rows as any[]).slice(-12),displacements:detectDisplacement(rows as any[]).slice(-12),asOf:nowIso(now),source:"ETI independent analysis; not GainzAlgo proprietary logic"});
    }catch(e){return reply({error:"market_data_unavailable",detail:e instanceof Error?e.message:"provider failure"},503);}
  }
  return reply({error:"not_found",path},404);
}
const defaultConfig={v2Enabled:true,alphaEnabled:true,v2Weight:40,alphaWeight:40,etiValidationWeight:20,executionMode:"manual_approval",minimumRewardRisk:1.5,maxSignalAgeSeconds:900,autoExecute:false};
const gainzPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETI · GainzAlgo Intelligence</title><style>
:root{color-scheme:dark;--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--green:#21d69a;--red:#ff637d;--blue:#56a8ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 60%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}header,main{max-width:1500px;margin:auto;padding:20px 4vw}header{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line)}h1{font-size:22px;margin:0}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:16px 0}.panel{background:linear-gradient(145deg,#121e30,#0d1624);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.panel h2{font-size:15px;margin:0 0 12px}.kpi{font-size:24px;font-weight:750}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}input,select,button{background:#0b1422;color:#eaf2ff;border:1px solid var(--line);border-radius:8px;padding:10px}button{cursor:pointer}button.primary{border-color:#267e68;color:#8ff0c8}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line);font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#09111d;padding:12px;border-radius:8px;overflow:auto}.good{color:var(--green)}.bad{color:var(--red)}a{color:var(--blue)}@media(max-width:850px){.grid{grid-template-columns:1fr}}label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:12px}
</style></head><body><header><div><h1>ETI <span style="color:var(--blue)">GainzAlgo Intelligence Centre</span></h1><div class="muted">GainzAlgo V2 · GainzAlgo V2 Alpha · Independent ETI validation</div></div><div><a href="/">← ETI Dashboard</a></div></header><main>
<section class="panel"><h2>Connection & access</h2><div class="row"><input id="token" type="password" placeholder="ETI Gainz admin / execution token" autocomplete="off" style="min-width:260px"><button id="connect" class="primary">Connect</button><span id="status" class="muted">Checking service…</span></div><p class="muted">The token is held in this tab's session storage only. Configure ETI_GAINZ_ADMIN_TOKEN or use the existing ETI execution token.</p></section>
<div class="grid"><section class="panel"><h2>GainzAlgo V2</h2><div class="kpi" id="v2count">—</div><div class="muted">Signals received</div><p id="v2state" class="muted">Awaiting connection</p></section><section class="panel"><h2>GainzAlgo V2 Alpha</h2><div class="kpi" id="alphacount">—</div><div class="muted">Signals received</div><p id="alphastate" class="muted">Awaiting connection</p></section><section class="panel"><h2>Dual-engine consensus</h2><div class="kpi" id="agreements">—</div><div class="muted">Agreement records</div><p id="conflicts" class="muted">Conflicts: —</p></section></div>
<section class="panel"><h2>Signal history</h2><div class="row"><select id="engine"><option value="">Both engines</option><option value="gainz_v2">V2</option><option value="gainz_v2_alpha">V2 Alpha</option></select><input id="symbol" placeholder="Symbol e.g. BTCUSDT"><button id="load" class="primary">Refresh signals</button></div><div style="overflow:auto"><table><thead><tr><th>Received</th><th>Engine</th><th>Instrument</th><th>Direction</th><th>Timeframe</th><th>Entry</th><th>SL</th><th>TP1</th><th>R:R</th><th>State</th><th>Consensus</th></tr></thead><tbody id="signals"><tr><td colspan="11" class="muted">Connect to load records.</td></tr></tbody></table></div></section>
<div class="grid"><section class="panel"><h2>Engine configuration</h2><div class="row"><label>V2 weight<input id="v2weight" type="number" min="0" max="100" value="40"></label><label>Alpha weight<input id="aweight" type="number" min="0" max="100" value="40"></label><label>Minimum R:R<input id="rr" type="number" min="0.1" step="0.1" value="1.5"></label></div><div class="row"><label>Execution mode<select id="mode"><option value="manual_approval">Manual approval</option><option value="analysis_only">Analysis only</option></select></label><button id="save" class="primary">Save configuration</button></div><p class="muted">Automatic execution is disabled. Approved opportunities must still pass ETI's existing risk and paper/testnet order safeguards.</p></section><section class="panel"><h2>Independent ETI market assessment</h2><div class="row"><input id="analysisSymbol" value="BTCUSDT"><select id="interval"><option>5m</option><option selected>15m</option><option>1h</option><option>4h</option><option>1d</option></select><select id="market"><option value="spot">Spot</option><option value="futures">Perpetual futures market data</option></select><button id="analyse" class="primary">Analyse</button></div><pre id="analysisResult">No analysis requested.</pre></section></div>
<section class="panel"><h2>TradingView webhook setup</h2><p class="muted">Configure ETI_GAINZ_WEBHOOK_SECRET as a Cloudflare Worker secret. Sign the exact request body using HMAC-SHA256 over timestamp + "." + raw JSON. Send timestamp and signature headers. The endpoint rejects unsigned, stale and replayed timestamps.</p><pre>POST /api/gainz/webhook
X-ETI-Gainz-Timestamp: &lt;unix-seconds&gt;
X-ETI-Gainz-Signature: sha256=&lt;hex-hmac&gt;
Content-Type: application/json

{
  "engine": "gainz_v2_alpha",
  "preset": "alpha",
  "signalId": "unique-alert-id",
  "symbol": "BTCUSDT",
  "exchange": "BINANCE",
  "market": "futures",
  "direction": "BUY",
  "timeframe": "5m",
  "signalTimestamp": 1794834000,
  "entry": 90000,
  "stopLoss": 89550,
  "tp1": 90900,
  "tp2": 91350,
  "tp3": 91800
}</pre></section></main>
<script>
const $=id=>document.getElementById(id),auth=()=>({Authorization:"Bearer "+(sessionStorage.getItem("eti_gainz_token")||""),"Content-Type":"application/json"});
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{...auth(),...(opts.headers||{})}});const j=await r.json().catch(()=>({error:"invalid_response"}));if(!r.ok)throw new Error(j.detail||j.error||("HTTP "+r.status));return j}
async function status(){const s=await fetch("/api/gainz/status").then(r=>r.json());$("status").textContent=s.databaseReady?"Database ready · webhook "+(s.webhookConfigured?"configured":"not configured"):"Database "+(s.databaseConfigured?"migration required":"not configured");}
async function refresh(){const q=new URLSearchParams({limit:"100"});if($("engine").value)q.set("engine",$("engine").value);if($("symbol").value.trim())q.set("symbol",$("symbol").value.trim());const [a,c]=await Promise.all([api("/api/gainz/signals?"+q),api("/api/gainz/compare")]);$("signals").innerHTML=a.signals.length?a.signals.map(s=>"<tr><td>"+new Date(Number(s.received_at)).toLocaleString()+"</td><td>"+s.engine+"</td><td>"+s.symbol+"</td><td class='"+(s.direction==="BUY"?"good":"bad")+"'>"+s.direction+"</td><td>"+s.timeframe+"</td><td>"+(s.entry??"—")+"</td><td>"+(s.stop_loss??"—")+"</td><td>"+(s.tp1??"—")+"</td><td>"+(s.reward_risk??"—")+"</td><td>"+s.state+"</td><td>"+s.consensus+"</td></tr>").join(""):"<tr><td colspan='11'>No signals stored yet.</td></tr>";const e=c.engines||[];const v=e.find(x=>x.engine==="gainz_v2")||{},al=e.find(x=>x.engine==="gainz_v2_alpha")||{};$("v2count").textContent=v.signals||0;$("alphacount").textContent=al.signals||0;$("v2state").textContent=(v.resolved||0)+" resolved · "+(v.wins||0)+" wins · "+(v.losses||0)+" losses";$("alphastate").textContent=(al.resolved||0)+" resolved · "+(al.wins||0)+" wins · "+(al.losses||0)+" losses";$("agreements").textContent=(Number(v.agreements)||0)+(Number(al.agreements)||0);$("conflicts").textContent="Conflicts: "+((Number(v.conflicts)||0)+(Number(al.conflicts)||0));}
$("connect").onclick=async()=>{sessionStorage.setItem("eti_gainz_token",$("token").value.trim());try{await refresh();$("status").textContent="Connected";}catch(e){$("status").textContent=e.message;}};
$("load").onclick=()=>refresh().catch(e=>$("status").textContent=e.message);
$("save").onclick=async()=>{try{const c=await api("/api/gainz/config",{method:"PUT",body:JSON.stringify({v2Weight:Number($("v2weight").value),alphaWeight:Number($("aweight").value),minimumRewardRisk:Number($("rr").value),executionMode:$("mode").value,autoExecute:false})});$("status").textContent=c.saved?"Configuration saved":"Not saved";}catch(e){$("status").textContent=e.message;}};
$("analyse").onclick=async()=>{try{const q=new URLSearchParams({symbol:$("analysisSymbol").value,interval:$("interval").value,market:$("market").value});const a=await api("/api/gainz/analyse?"+q);$("analysisResult").textContent=JSON.stringify(a,null,2);}catch(e){$("analysisResult").textContent=e.message;}};
status().catch(e=>$("status").textContent=e.message);
</script></body></html>`;
