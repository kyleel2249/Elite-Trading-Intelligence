/** Cross-exchange reconciliation. Unknown or incomplete venue data never becomes zero or deployable capital. */
import { loadExchangePortfolioSnapshot } from "./exchanges.ts";
import { openStore, type KVL } from "./store.ts";
type Env = Record<string, any>;
const finite = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const qty = (v: unknown) => finite(v) ?? 0;
const norm = (s: unknown) => String(s ?? "").trim().toUpperCase();
const side = (s: unknown) => { const v = String(s ?? "").toLowerCase(); return v === "buy" || v === "long" ? "long" : v === "sell" || v === "short" ? "short" : v; };
function exchangePositions(snapshot: any) {
 const out: any[] = [], bybit = snapshot.venues.find((v: any) => v.venue === "bybit");
 for (const p of bybit?.positions ?? []) out.push({ venue:"bybit",symbol:norm(p.symbol),side:side(p.side),qty:qty(p.size) });
 const bitget = snapshot.venues.find((v: any) => v.venue === "bitget");
 for (const m of bitget?.markets ?? []) for (const p of m.positions ?? []) out.push({ venue:"bitget",market:m.market,symbol:norm(p.symbol),side:side(p.side),qty:qty(p.size) });
 return out;
}

export function verifiedGrossExposureUsd(snapshot:any,activity:any,now:number){
 const problems:string[]=[];
 if(!activity?.syncedAt||now-activity.syncedAt<0||now-activity.syncedAt>6*60_000)problems.push("exchange_activity_snapshot_stale_or_missing");
 const last=activity?.syncs?.at?.(-1),results=last?.results??[];
 for(const [venue,markets] of [["bybit",["spot","linear","inverse"]],["bitget",["spot","margin-crossed","margin-isolated","usdt-futures","usdc-futures","coin-futures"]]] as const){
  for(const market of markets){const row=results.find((x:any)=>x.venue===venue&&x.market===market);if(!row||row.status!=="connected")problems.push("activity_scope_unverified:"+venue+":"+market);}
 }
 let total=0;
 const bybit=snapshot?.venues?.find((v:any)=>v.venue==="bybit");
 for(const a of bybit?.assets??[]){const balance=finite(a.walletBalance);if(balance!==null&&balance>0){const value=finite(a.usdValue);if(value===null)problems.push("unvalued_bybit_asset:"+String(a.coin));else total+=value;}}
 for(const p of bybit?.positions??[]){if(qty(p.size)>0){const value=finite(p.positionValue);if(value===null||value<0)problems.push("bybit_position_notional_unverified:"+String(p.symbol));else total+=value;}}
 const bitget=snapshot?.venues?.find((v:any)=>v.venue==="bitget");
 for(const m of bitget?.markets??[]){
  if(m.market==="spot"){for(const a of m.assets??[]){if(qty(a.total)>0){const value=finite(a.usdValue);if(value===null)problems.push("unvalued_bitget_spot_asset:"+String(a.coin));else total+=value;}}}
  if(m.market==="margin-crossed"||m.market==="margin-isolated"){for(const a of m.assets??[]){if(qty(a.debt)>0)problems.push("bitget_margin_liability_not_reconciled:"+m.market+":"+String(a.coin));if(qty(a.total)>0)problems.push("bitget_margin_asset_exposure_not_reconciled:"+m.market+":"+String(a.coin));}}
  if(m.market==="usdt-futures"||m.market==="usdc-futures"){for(const p of m.positions??[]){if(qty(p.size)>0){const mark=finite(p.markPrice);if(mark===null||mark<=0)problems.push("bitget_position_mark_unavailable:"+p.symbol);else total+=qty(p.size)*mark;}}}
  if(m.market==="coin-futures"&&(m.positions??[]).some((p:any)=>qty(p.size)>0))problems.push("bitget_coin_futures_contract_value_unverified");
 }
 for(const o of activity?.openOrders??[]){const remaining=finite(o.leavesQty),price=finite(o.price);if(remaining===null||remaining<=0)continue;if(o.market==="coin-futures"){problems.push("coin_futures_open_order_notional_unverified:"+o.symbol);continue;}if(o.venue==="bybit"&&o.market==="inverse"){const value=finite(o.notionalUsd);if(value===null||value<0)problems.push("bybit_inverse_open_order_notional_unverified:"+o.symbol);else total+=value;continue;}if(price===null||price<=0){problems.push("open_order_notional_unverified:"+o.venue+":"+o.market+":"+o.symbol);continue;}total+=remaining*price;}
 return {value:problems.length===0?total:null,problems:[...new Set(problems)]};
}
export function reconcileCrossExchange(snapshot: any, ledger: any, now: number, maxAgeMs = 90_000, activity:any=null) {
 const problems:string[]=[],warnings:string[]=[],venues=snapshot?.venues??[];
 const bybit=venues.find((v:any)=>v.venue==="bybit"),bitget=venues.find((v:any)=>v.venue==="bitget");
 const fresh=Number.isFinite(snapshot?.generatedAt)&&now-snapshot.generatedAt>=0&&now-snapshot.generatedAt<=maxAgeMs;
 if(!fresh)problems.push("exchange_snapshot_stale_or_invalid");
 for(const v of [bybit,bitget])if(!v||v.status!=="connected")problems.push((v?.venue??"exchange")+"_account_snapshot_incomplete_or_unavailable");
 if(bitget?.status==="partial")warnings.push("bitget_product_snapshot_partial");
 const exchange=exchangePositions(snapshot),internal=Object.values(ledger?.positions??{}).map((p:any)=>({venue:String(p.venue??"").toLowerCase(),symbol:norm(p.symbol),side:side(p.direction??p.side),qty:qty(p.qty)}));
 const comparisons:any[]=[],keys=new Set([...exchange.map(p=>p.venue+"|"+p.symbol+"|"+p.side),...internal.filter(p=>["bybit","bitget"].includes(p.venue)).map(p=>p.venue+"|"+p.symbol+"|"+p.side)]);
 for(const key of keys){const [venue,symbol,direction]=key.split("|"),ex=exchange.filter(p=>p.venue===venue&&p.symbol===symbol&&p.side===direction),le=internal.filter(p=>p.venue===venue&&p.symbol===symbol&&p.side===direction),externalQty=ex.reduce((s,p)=>s+p.qty,0),ledgerQty=le.reduce((s,p)=>s+p.qty,0),delta=externalQty-ledgerQty,match=Math.abs(delta)<=Math.max(1e-10,Math.max(externalQty,ledgerQty)*1e-8);comparisons.push({venue,symbol,side:direction,exchangeQty:externalQty,ledgerQty,delta,status:match?"matched":"mismatch"});if(!match)problems.push("position_mismatch:"+venue+":"+symbol+":"+direction);}
 let verifiedAvailableUsd:number|null=null;
 if(fresh&&bybit?.status==="connected"&&bitget?.status==="connected"&&finite(bybit.availableUsd)!==null){
  const spot=bitget.markets?.find((m:any)=>m.market==="spot");
  if(spot?.status==="connected"){const assets=spot.assets??[],unvalued=assets.some((a:any)=>qty(a.available)>0&&finite(a.usdValue)===null),spotUsd=assets.reduce((s:number,a:any)=>s+(finite(a.available)!==null&&finite(a.usdValue)!==null&&qty(a.total)>0?finite(a.usdValue)!*(qty(a.available)/qty(a.total)):0),0);if(!unvalued)verifiedAvailableUsd=finite(bybit.availableUsd)!+spotUsd;else warnings.push("bitget_spot_contains_unvalued_assets");}
 }
 if(verifiedAvailableUsd===null){warnings.push("combined_available_capital_not_verified");problems.push("combined_available_capital_not_verified");}
 if(comparisons.some(x=>x.status!=="matched"))problems.push("ledger_and_exchange_positions_do_not_reconcile");
 const exposure=verifiedGrossExposureUsd(snapshot,activity,now);
 warnings.push(...exposure.problems);
 if(exposure.value===null)problems.push("combined_exposure_not_verified");
 const verified=problems.length===0?verifiedAvailableUsd:null;
 const verifiedExposure=problems.length===0?exposure.value:null;
 return {schema:"eti.cross-exchange-reconciliation/1",checkedAt:now,snapshotAt:snapshot?.generatedAt??null,fresh,ok:fresh&&problems.length===0,status:!fresh?"stale":problems.length?(problems.every(p=>p==="combined_exposure_not_verified")?"incomplete":"mismatch"):"matched",venues:[{venue:"bybit",status:bybit?.status??"missing"},{venue:"bitget",status:bitget?.status??"missing"}],comparisons,combinedVerifiedAvailableUsd:verified,capitalAllocation:{basis:"combinedVerifiedAvailableUsd",reservePct:50,maxDeploymentPct:50,reserveUsd:verified===null?null:verified*0.5,maxDeployableUsd:verified===null?null:verified*0.5,maxPerStrategyPctOfDeployable:35,executable:false},combinedVerifiedExposureUsd:verifiedExposure,exposurePolicy:"Gross exposure includes valued spot assets, open Bybit/Bitget positions and remaining open-order notional. Combined capital allocation is withheld unless all venue/product sync scopes are fresh and fully valued.",problems:[...new Set(problems)],warnings:[...new Set(warnings)],executionEligible:false,limitations:["Open-order notional requires fresh Bybit and Bitget activity syncs across every supported product.","Bitget cross/isolated/futures collateral is excluded from combined available capital to prevent shared-collateral double counting.","Non-USD assets without a trusted USD valuation are excluded; the reconciliation remains non-executable."]};
}
export async function buildCrossExchangeReconciliation(env:Env,environment:"internal_paper"|"exchange_testnet",now:number,deps:{fetchImpl?:typeof fetch}={}){const snapshot=await loadExchangePortfolioSnapshot(env,now,deps),store=openStore(env,environment);if(!store)throw new Error("portfolio_storage_unavailable");const {ledger}=await store.ledgerFast(now),activity=await store.kvGet<any>("exchange_activity",null);return reconcileCrossExchange(snapshot,ledger,now,90_000,activity);}
export async function readAutonomyControls(kv:KVL|undefined,now:number){if(!kv)return{enabled:false,authorized:false,executionDispatchEnabled:false,reason:"control_storage_unavailable"};try{const saved=await kv.get("eti:autonomy:controls");if(!saved)return{enabled:false,authorized:false,executionDispatchEnabled:false,reason:"not_authorized"};const c=JSON.parse(saved),active=c.enabled===true&&Number(c.expiresAt)>now;return{...c,enabled:active,authorized:active,executionDispatchEnabled:false,reason:active?"authorization_recorded_but_execution_dispatch_is_safely_locked":"authorization_expired_or_disabled"};}catch{return{enabled:false,authorized:false,executionDispatchEnabled:false,reason:"control_state_unavailable"};}}
export async function saveAutonomyControls(kv:KVL|undefined,input:any,actor:string,now:number){if(!kv)throw new Error("control_storage_unavailable");const enabled=input.enabled===true,cap=Number(input.perOrderCapUsd),max=Number(input.maxConcurrentPositions);if(enabled&&input.confirmation!=="AUTHORIZE ETI AUTONOMY")throw new Error("explicit_confirmation_required");if(enabled&&(!Number.isFinite(cap)||cap<=0||cap>1000))throw new Error("per_order_cap_must_be_between_0_and_1000_usd");if(enabled&&(!Number.isInteger(max)||max<1||max>5))throw new Error("max_concurrent_positions_must_be_between_1_and_5");const record={schema:"eti.autonomy-controls/1",enabled,authorized:enabled,actor,authorizedAt:enabled?now:null,expiresAt:enabled?now+900000:null,perOrderCapUsd:enabled?cap:0,maxConcurrentPositions:enabled?max:0,requireFreshReconciliation:true,requireRiskManagerApproval:true,riskManagerVetoOverridable:false,executionDispatchEnabled:false,mode:"authorization_only_no_live_order_dispatch"};await kv.put("eti:autonomy:controls",JSON.stringify(record));return{...record,reason:enabled?"authorization_recorded_but_execution_dispatch_is_safely_locked":"disabled"};}
export function autonomousExecutionGate(input:{controls:any;reconciliation:any;riskApproved:boolean;killSwitch:boolean;notionalUsd:number;openPositions:number},now=Date.now()){const reasons:string[]=[];if(!input.controls?.enabled||Number(input.controls.expiresAt)<=now)reasons.push("autonomous_execution_not_authorized");if(!input.reconciliation?.ok||!input.reconciliation?.fresh)reasons.push("cross_exchange_reconciliation_not_verified");if(input.reconciliation?.executionEligible!==true)reasons.push("reconciliation_does_not_authorize_execution");if(input.killSwitch)reasons.push("kill_switch_active");if(input.riskApproved!==true)reasons.push("risk_manager_veto_or_missing_approval");if(!Number.isFinite(input.notionalUsd)||input.notionalUsd<=0||input.notionalUsd>Number(input.controls?.perOrderCapUsd??0))reasons.push("per_order_cap_exceeded_or_invalid");if(input.openPositions>=Number(input.controls?.maxConcurrentPositions??0))reasons.push("max_concurrent_positions_reached");return{allowed:reasons.length===0,reasons,riskManagerHasFinalVeto:true};}
