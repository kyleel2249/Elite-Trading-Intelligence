import { authenticate } from "../auth/session.ts";
import { ensureAotiSchema, scanAotiPairs, persistAotiScan, sizeAotiPosition, scoreAotiCandidate, isAotiSessionOpen, type AotiEnv, type AotiPosition } from "./engine.ts";
import { AOTI_PAGE } from "./ui.ts";
const H={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
const reply=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:H});
const dbOf=(env:any)=>env?.ETI_PORTFOLIO_DB;
async function authorized(req:Request,env:any){const a=await authenticate(req,env);return a.master||a.scopes.has("paper");}
async function state(db:any,key:string,fallback:string){const r=await db.prepare("SELECT v FROM eti_aoti_state WHERE k=?").bind(key).first();return r?.v??fallback;}
async function setState(db:any,key:string,value:string,now:number){await db.prepare("INSERT INTO eti_aoti_state(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated_at=excluded.updated_at").bind(key,value,now).run();}
async function overview(db:any){
 await ensureAotiSchema(db);
 const [c,p,e,eq,peak]=await Promise.all([
  db.prepare("SELECT id,chain,address,pair_address,symbol,score,security_gate,eligible,payload_json,observed_at FROM eti_aoti_candidates ORDER BY observed_at DESC,score DESC LIMIT 40").all(),
  db.prepare("SELECT id,candidate_id,chain,address,symbol,status,entry_price,last_price,quantity,notional_usd,remaining_pct,realized_pnl_usd,opened_at,closed_at,payload_json FROM eti_aoti_positions ORDER BY opened_at DESC LIMIT 50").all(),
  db.prepare("SELECT id,event_type,candidate_id,position_id,reason,payload_json,created_at FROM eti_aoti_events ORDER BY created_at DESC LIMIT 100").all(),
  state(db,"equity_usd","70"),state(db,"peak_equity_usd","70")
 ]);
 return {schema:"eti.aoti.overview/1",mode:"paper_only",liveExecutionAllowed:false,equityUsd:Number(eq),peakEquityUsd:Number(peak),candidates:(c.results||[]).map((x:any)=>JSON.parse(x.payload_json)),positions:(p.results||[]).map((x:any)=>({...x,payload:JSON.parse(x.payload_json)})),events:(e.results||[]).map((x:any)=>({...x,payload:JSON.parse(x.payload_json)}))};
}
async function openPaper(req:Request,env:any){
 const db=dbOf(env);if(!db)return reply({error:"d1_unavailable"},503);
 const body=await req.json().catch(()=>null);const candidateId=String(body?.candidateId||"");
 if(!candidateId||candidateId.length>300)return reply({error:"candidate_id_required"},400);
 await ensureAotiSchema(db);
 const row=await db.prepare("SELECT payload_json FROM eti_aoti_candidates WHERE id=?").bind(candidateId).first();
 if(!row)return reply({error:"candidate_not_found"},404);
 const c=JSON.parse(row.payload_json);
 if(!c.eligible||c.securityGate!=="PASS")return reply({error:"security_or_opportunity_gate_blocked",securityGate:c.securityGate,reasons:c.reasons},409);
 const existing=await db.prepare("SELECT id FROM eti_aoti_positions WHERE status='open' AND candidate_id=?").bind(candidateId).first();
 if(existing)return reply({error:"position_already_open",positionId:existing.id},409);
 const [equity,peak,count,losses]=await Promise.all([
  state(db,"equity_usd","70"),state(db,"peak_equity_usd","70"),
  db.prepare("SELECT COUNT(*) AS n FROM eti_aoti_positions WHERE status='open'").first(),
  state(db,"consecutive_losses","0")
 ]);
 const risk=sizeAotiPosition({equity:Number(equity),peakEquity:Number(peak),openPositions:Number(count?.n||0),consecutiveLosses:Number(losses),liquidityUsd:c.liquidityUsd,requestedRiskPct:1,stopPct:12});
 if(!risk.allowed)return reply({error:"risk_gate_blocked",risk},409);
 const now=Date.now(),id="aoti_"+crypto.randomUUID().replace(/-/g,""),qty=risk.notionalUsd/c.priceUsd;
 const position:AotiPosition={id,candidateId,chain:c.chain,address:c.address,symbol:c.symbol,entryPrice:c.priceUsd,quantity:qty,notionalUsd:risk.notionalUsd,openedAt:now,remainingPct:100,realizedPnlUsd:0,status:"open",lastPrice:c.priceUsd};
 await db.prepare("INSERT INTO eti_aoti_positions(id,candidate_id,chain,address,symbol,status,entry_price,last_price,quantity,notional_usd,remaining_pct,realized_pnl_usd,opened_at,payload_json) VALUES(?,?,?,?,?,'open',?,?,?,?,100,0,?,?)").bind(id,candidateId,c.chain,c.address,c.symbol,c.priceUsd,c.priceUsd,qty,risk.notionalUsd,now,JSON.stringify({...position,pairAddress:c.pairAddress,initialLiquidityUsd:c.liquidityUsd,takeProfit2xDone:false,takeProfit4xDone:false,highWaterPrice:c.priceUsd})).run();
 await db.prepare("INSERT INTO eti_aoti_events(id,event_type,candidate_id,position_id,reason,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").bind("open:"+id,"PAPER_ENTER",candidateId,id,"all_market_and_security_gates_passed",JSON.stringify({risk,entryPrice:c.priceUsd,quantity:qty,notionalUsd:risk.notionalUsd}),now).run();
 return reply({ok:true,mode:"paper_only",position,risk,liveExecutionAllowed:false},201);
}
async function closePaper(req:Request,env:any){
 const db=dbOf(env);if(!db)return reply({error:"d1_unavailable"},503);
 const body=await req.json().catch(()=>null),id=String(body?.positionId||"");
 if(!id)return reply({error:"position_id_required"},400);
 const row=await db.prepare("SELECT * FROM eti_aoti_positions WHERE id=? AND status='open'").bind(id).first();
 if(!row)return reply({error:"open_position_not_found"},404);
 const now=Date.now(),price=Number(row.last_price);if(!(price>0))return reply({error:"invalid_price"},400);
 const p=JSON.parse(row.payload_json),change=(price-Number(row.entry_price))/Number(row.entry_price),pnl=Number(row.notional_usd)*change*Number(row.remaining_pct)/100;
 const totalPnl=Number(row.realized_pnl_usd)+pnl,equity=Number(await state(db,"equity_usd","70"))+pnl,peak=Math.max(Number(await state(db,"peak_equity_usd","70")),equity);
 await db.prepare("UPDATE eti_aoti_positions SET status='closed',last_price=?,remaining_pct=0,realized_pnl_usd=?,closed_at=?,payload_json=? WHERE id=? AND status='open'").bind(price,totalPnl,now,JSON.stringify({...p,lastPrice:price,remainingPct:0,realizedPnlUsd:totalPnl,status:"closed",closeReason:"manual_paper_close"}),id).run();
 await setState(db,"equity_usd",String(equity),now);await setState(db,"peak_equity_usd",String(peak),now);await setState(db,"consecutive_losses",String(pnl<0?Number(await state(db,"consecutive_losses","0"))+1:0),now);
 await db.prepare("INSERT INTO eti_aoti_events(id,event_type,position_id,reason,payload_json,created_at) VALUES(?,?,?,?,?,?)").bind("close:"+id,"PAPER_EXIT",id,"manual_paper_close",JSON.stringify({price,closePnlUsd:pnl,totalRealizedPnlUsd:totalPnl,equity,peak}),now).run();
 return reply({ok:true,positionId:id,closePnlUsd:pnl,totalRealizedPnlUsd:totalPnl,equityUsd:equity,mode:"paper_only"});
}
export function withAoti<E extends Record<string,any>>(base:{fetch(request:Request,env:E,ctx?:any):Promise<Response>|Response}){
 return {async fetch(request:Request,env:E,ctx?:any){
  const u=new URL(request.url),path=u.pathname;
  if(path==="/aoti"&&request.method==="GET")return new Response(AOTI_PAGE,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"}});
  if(path==="/api/aoti/overview"&&request.method==="GET"){const db=dbOf(env);if(!db)return reply({error:"d1_unavailable"},503);try{return reply(await overview(db))}catch{return reply({error:"aoti_storage_unavailable"},503)}}
  if(path.startsWith("/api/aoti/")){
   if(!["POST"].includes(request.method))return reply({error:"method_not_allowed"},405);
   if(!(await authorized(request,env)))return reply({error:"paper_session_required",message:"Start an ETI paper session before changing AOTI state."},401);
   const db=dbOf(env);if(!db)return reply({error:"d1_unavailable"},503);
   try{
    await ensureAotiSchema(db);
    if(path==="/api/aoti/scan"){
     if(env.ETI_AOTI_ENABLED!=="true")return reply({error:"aoti_disabled",message:"Set ETI_AOTI_ENABLED=true to enable scheduled discovery."},423);
     const result=await scanAotiPairs(fetch,Date.now(),Number(env.ETI_AOTI_MAX_CANDIDATES||12));await persistAotiScan(db,result);return reply(result);
    }
    if(path==="/api/aoti/security"){
     const body=await request.json().catch(()=>null),candidateId=String(body?.candidateId||""),raw=body?.evidence;
     if(!candidateId||!raw||typeof raw!=="object")return reply({error:"candidate_and_evidence_required"},400);
     const row=await db.prepare("SELECT payload_json FROM eti_aoti_candidates WHERE id=?").bind(candidateId).first();if(!row)return reply({error:"candidate_not_found"},404);
     const c=JSON.parse(row.payload_json),bool=(v:any)=>typeof v==="boolean"?v:null,num=(v:any)=>Number.isFinite(Number(v))?Number(v):null;
     const security={holderCount:num(raw.holderCount),mintAuthorityRevoked:bool(raw.mintAuthorityRevoked),freezeAuthorityRevoked:bool(raw.freezeAuthorityRevoked),lpLocked:bool(raw.lpLocked),lpLockDays:num(raw.lpLockDays),developerSupplyPct:num(raw.developerSupplyPct),top10SupplyPct:num(raw.top10SupplyPct),sellSimulationPassed:bool(raw.sellSimulationPassed),bundledLaunchClear:bool(raw.bundledLaunchClear),provider:"operator_attested",checkedAt:Date.now(),risks:Array.isArray(raw.risks)?raw.risks.map((x:any)=>String(x).slice(0,120)).slice(0,20):[]};
     const next=scoreAotiCandidate({...c,security},Date.now());await db.prepare("UPDATE eti_aoti_candidates SET score=?,security_gate=?,eligible=?,payload_json=?,observed_at=? WHERE id=?").bind(next.score,next.securityGate,next.eligible?1:0,JSON.stringify(next),next.observedAt,candidateId).run();
     await db.prepare("INSERT INTO eti_aoti_events(id,event_type,candidate_id,reason,payload_json,created_at) VALUES(?,?,?,?,?,?)").bind("security:"+candidateId+":"+next.observedAt,"SECURITY_EVIDENCE",candidateId,"operator_attested_security_review",JSON.stringify({securityGate:next.securityGate,risks:security.risks}),next.observedAt).run();
     return reply({ok:true,securityGate:next.securityGate,eligible:next.eligible,reasons:next.reasons});
    }
    if(path==="/api/aoti/paper/open")return openPaper(request,env);
    if(path==="/api/aoti/paper/close")return closePaper(request,env);
    return reply({error:"not_found"},404);
   }catch(e){return reply({error:"aoti_operation_failed",detail:e instanceof Error?e.message:"unknown"},502)}
  }
  return base.fetch(request,env,ctx);
 }};
}
