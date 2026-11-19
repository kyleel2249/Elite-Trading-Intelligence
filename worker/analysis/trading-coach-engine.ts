/**
 * ETI Trading Intelligence & Behavioral Coach — deterministic analysis helpers.
 * Evidence-first; no order placement, wallet attribution or guaranteed forecasts.
 */
const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
const num=(v)=>Number.isFinite(Number(v))?Number(v):null;
export function scoreBehavior(events=[],rules={}) {
 const e=events.slice(-200).map(x=>({...x,at:num(x.at)})).filter(x=>x.at!==null);
 const counts={revenge:0,fomo:0,impulsive:0,overtrade:0,riskEscalation:0,planViolation:0,earlyExit:0};
 const findings=[];
 const recentLoss=e.filter(x=>x.type==="trade_close"&&num(x.pnl)<0).slice(-1)[0];
 for(const x of e){
  const tags=Array.isArray(x.tags)?x.tags.map(String):[];
  const lossNear=recentLoss&&x.type==="trade_open"&&x.at>=recentLoss.at&&x.at-recentLoss.at<=Number(rules.cooldownMs||45*60*1000);
  if(tags.includes("revenge")||x.recoveryIntent===true||(lossNear&&x.riskIncreased===true)){counts.revenge++;findings.push({type:"revenge_risk",severity:"high",confidence:lossNear?0.7:0.85,at:x.at,reason:"Entry/re-entry is marked as recovery-driven or follows a loss with increased risk."});}
  if(tags.includes("fomo")||x.chasedPrice===true){counts.fomo++;findings.push({type:"fomo",severity:"moderate",confidence:0.75,at:x.at,reason:"Entry was tagged as chasing price or FOMO."});}
  if(tags.includes("impulsive")||x.unplanned===true){counts.impulsive++;findings.push({type:"impulsive",severity:"moderate",confidence:0.75,at:x.at,reason:"Trade was marked unplanned or impulsive."});}
  if(tags.includes("plan_violation")||x.ruleViolation===true){counts.planViolation++;findings.push({type:"plan_violation",severity:"high",confidence:0.9,at:x.at,reason:"Recorded activity conflicts with a declared rule."});}
  if(x.type==="trade_open"&&x.riskIncreased===true){counts.riskEscalation++;findings.push({type:"risk_escalation",severity:"high",confidence:0.8,at:x.at,reason:"Trade risk/exposure was increased relative to baseline or plan."});}
  if(tags.includes("early_exit")||x.exitBeforePlan===true){counts.earlyExit++;findings.push({type:"early_exit",severity:"low",confidence:0.7,at:x.at,reason:"Exit was recorded earlier than the plan; early exits can still be prudent if evidence changed."});}
 }
 const total=Object.values(counts).reduce((a,b)=>a+b,0), discipline=clamp(100-total*8,0,100);
 return {counts,findings,disciplineScore:discipline,observations:e.length,confidence: e.length<10?"low":e.length<30?"moderate":"higher",limitations:["Behavioral classifications depend on recorded tags and fields; timestamps alone cannot reliably infer emotions or motives.","Sample size and context affect confidence."]};
}
export function analyzeStructure(candles=[],opts={}) {
 const rows=candles.filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(v=>Number.isFinite(Number(v)))).slice(-500).map(r=>r.slice(0,6).map(Number));
 if(rows.length<8)return {status:"insufficient_data",bars:rows.length,events:[],note:"At least eight valid OHLCV candles are needed for this basic structure pass."};
 const events=[],look=Math.min(20,Math.max(3,Number(opts.swingLookback)||5)),swings=[];
 for(let i=look;i<rows.length-look;i++){const hi=rows[i][2],lo=rows[i][3];if(rows.slice(i-look,i).every(r=>r[2]<hi)&&rows.slice(i+1,i+look+1).every(r=>r[2]<=hi))swings.push({type:"swing_high",index:i,price:hi});if(rows.slice(i-look,i).every(r=>r[3]>lo)&&rows.slice(i+1,i+look+1).every(r=>r[3]>=lo))swings.push({type:"swing_low",index:i,price:lo});}
 const close=rows.at(-1)[4],highs=swings.filter(s=>s.type==="swing_high"),lows=swings.filter(s=>s.type==="swing_low"),lastHigh=highs.at(-1),lastLow=lows.at(-1);
 if(lastHigh&&close>lastHigh.price)events.push({type:"BOS",direction:"bullish",level:lastHigh.price,index:rows.length-1,reason:"Latest close exceeded the last confirmed swing high."});
 if(lastLow&&close<lastLow.price)events.push({type:"BOS",direction:"bearish",level:lastLow.price,index:rows.length-1,reason:"Latest close fell below the last confirmed swing low."});
 if(lastHigh&&rows.at(-1)[2]>lastHigh.price&&close<lastHigh.price)events.push({type:"liquidity_sweep",direction:"bearish",level:lastHigh.price,reason:"Wick exceeded swing high and closed back below; confirmation remains candle-based."});
 if(lastLow&&rows.at(-1)[3]<lastLow.price&&close>lastLow.price)events.push({type:"liquidity_sweep",direction:"bullish",level:lastLow.price,reason:"Wick fell below swing low and closed back above."});
 const gaps=[];for(let i=2;i<rows.length;i++){if(rows[i][3]>rows[i-2][2])gaps.push({type:"FVG",direction:"bullish",lower:rows[i-2][2],upper:rows[i][3],index:i});if(rows[i][2]<rows[i-2][3])gaps.push({type:"FVG",direction:"bearish",lower:rows[i][2],upper:rows[i-2][3],index:i});}
 events.push(...gaps.slice(-10));
 const trend=lastHigh&&lastLow?(close>lastHigh.price?"bullish_break":close<lastLow.price?"bearish_break":"range/inside"): "undetermined";
 return {status:"ok",bars:rows.length,lastClose:close,lastSwingHigh:lastHigh||null,lastSwingLow:lastLow||null,trend,events,method:"Basic swing/BOS/sweep/FVG heuristic; not a substitute for ETI multi-timeframe or Institutional Market Intelligence."};
}
export function analyzeIndicators(candles=[]) {
 const r=candles.filter(x=>Array.isArray(x)&&x.length>=6&&x.slice(0,6).every(v=>Number.isFinite(Number(v)))).slice(-250).map(x=>x.slice(0,6).map(Number)),cl=r.map(x=>x[4]);
 if(cl.length<30)return {status:"insufficient_data",count:cl.length};
 const avg=a=>a.reduce((s,v)=>s+v,0)/a.length;
 const sma=(n)=>avg(cl.slice(-n));
 const changes=cl.slice(1).map((v,i)=>v-cl[i]),g=changes.slice(-14).filter(v=>v>0),l=changes.slice(-14).filter(v=>v<0).map(v=>-v),avgGain=avg(g.length?g:[0]),avgLoss=avg(l.length?l:[0]),rs=avgLoss===0?(avgGain===0?1e-12:Infinity):avgGain/avgLoss,rsi=avgGain===0&&avgLoss===0?50:100-100/(1+rs);
 const ema=(values,n)=>{const k=2/(n+1),out=[];let prev=null;for(const v of values){prev=prev===null?v:v*k+prev*(1-k);out.push(prev);}return out;},fastSeries=ema(cl,12),slowSeries=ema(cl,26),macdSeries=fastSeries.map((v,i)=>v-slowSeries[i]),signalSeries=ema(macdSeries,9),macd=macdSeries.at(-1),signal=signalSeries.at(-1),hist=macd-signal;
 const tr=r.slice(-14).map((x,i)=>i===0?x[2]-x[3]:Math.max(x[2]-x[3],Math.abs(x[2]-r[r.length-15+i][4]),Math.abs(x[3]-r[r.length-15+i][4]))),atr=avg(tr);
 const volAvg=avg(r.slice(-20).map(x=>x[5])),vol=r.at(-1)[5],vRatio=volAvg?vol/volAvg:null;
 return {status:"ok",rsi14:Number(rsi.toFixed(2)),macdApprox:Number(macd.toPrecision(8)),macdSignalApprox:Number(signal.toPrecision(8)),macdHistogramApprox:Number(hist.toPrecision(8)),atr14:Number(atr.toPrecision(8)),volumeRatio: vRatio===null?null:Number(vRatio.toFixed(3)),sma20:Number(sma(20).toPrecision(8)),sma50:Number(sma(50).toPrecision(8)),close:cl.at(-1),notes:["Approximate compact calculations for coach display only; ETI's existing indicator modules are authoritative.","This RSI/MACD approximation is not the canonical ETI indicator implementation."]};
}
export function classifyTransaction(tx={}) {
 const amount=num(tx.amount),type=String(tx.type||tx.category||"unknown").toLowerCase(),labels={
 transfer:"Wallet transfer",exchange_deposit:"Exchange deposit",exchange_withdrawal:"Exchange withdrawal",swap:"Token swap",bridge:"Cross-chain bridge",mint:"Token mint",burn:"Token burn",staking:"Staking",unstaking:"Unstaking",liquidation:"Liquidation",borrow:"Borrow",repay:"Repayment",approval:"Token approval",contract_interaction:"Smart-contract interaction",unknown:"Unclassified transaction"};
 const category=labels[type]||labels.unknown;
 return {hash:tx.hash||tx.txHash||null,chain:tx.chain||tx.network||"unknown",asset:tx.asset||tx.token||"unknown",amount,category,type,from:tx.from||null,to:tx.to||null,timestamp:num(tx.timestamp||tx.at),source:tx.source||"user-provided",verified:tx.verified===true,attribution:tx.entityName?{entity:tx.entityName,confidence:clamp(num(tx.attributionConfidence)||0,0,1),basis:tx.attributionBasis||"unverified label"}:null,interpretation:category==="Token approval"?"Approval grants a contract allowance; it is not proof that tokens were transferred.":category==="Cross-chain bridge"?"Bridge activity can imply cross-chain movement; source/destination matching is needed to avoid double-counting.":category==="Wallet transfer"?"A transfer alone does not establish buying or selling pressure.": "Transaction classification is descriptive; market impact requires additional flow, price and context data."};
}
export function assessCoach(payload={}) {
 const candles=payload.candles||[],structure=analyzeStructure(candles),indicators=analyzeIndicators(candles),behavior=scoreBehavior(payload.events||[],payload.rules||{}),transactions=(payload.transactions||[]).slice(-200).map(classifyTransaction),institutional=payload.institutional||{},signals=payload.signals||[],trade=payload.trade||{};
 const confirmations=[],conflicts=[],warnings=[];
 if(structure.status==="ok")confirmations.push(...structure.events.map(e=>e.type+" "+e.direction));
 if(indicators.status==="ok"){if(indicators.rsi14<30)confirmations.push("RSI oversold");if(indicators.rsi14>70)confirmations.push("RSI overbought");if(indicators.macdHistogramApprox>0)confirmations.push("MACD momentum positive");else confirmations.push("MACD momentum negative");}
 if(institutional.status==="unavailable"||institutional.status==="missing")warnings.push("Institutional Market Intelligence unavailable; institutional context cannot be confirmed.");
 if(!signals.length)warnings.push("No ETI signals supplied. This assessment is not an ETI-wide signal consensus.");
 const direction=String(trade.direction||"").toLowerCase(),entry=num(trade.entry),stop=num(trade.stop),target=num(trade.target),rr=entry!==null&&stop!==null&&target!==null&&Math.abs(entry-stop)>0?(Math.abs(target-entry)/Math.abs(entry-stop)):null;
 if(entry!==null&&stop!==null&&target!==null){const valid=direction==="long"?stop<entry&&target>entry:direction==="short"?stop>entry&&target<entry:false;if(!valid)conflicts.push("Entry/stop/target levels do not fit the selected trade direction.");}
 const directionEvidence=structure.events.filter(e=>e.direction===direction),signalEvidence=signals.filter(s=>String(s.direction||s.side||"").toLowerCase()===direction);
 if(direction&&directionEvidence.length===0)warnings.push("Structure does not provide a matching direction confirmation in this simplified pass.");
 if(direction&&signalEvidence.length===0)warnings.push("No supplied ETI signal aligns with the proposed direction.");
 if(rr!==null&&rr<1.5)warnings.push("Proposed risk/reward is below the coach's configurable default 1.5:1 review threshold.");
 const decision=conflicts.length?"REJECT / REASSESS":warnings.length>=3?"WAIT / INSUFFICIENT CONFLUENCE":warnings.length?"CAUTION / WAIT FOR CONFIRMATION":"CONFLUENCE REVIEW PASSED";
 return {timestamp:new Date().toISOString(),decision,marketStructure:structure,indicators,behavior,institutionalMarketIntelligence:{status:institutional.status||"not_supplied",summary:institutional.summary||null,events:institutional.events||[],limitations:["Institutional activity attribution and intent must be sourced and independently validated."]},transactionFlow:{count:transactions.length,transactions},signals:signals.slice(0,30),tradePlanReview:{direction:direction||"not specified",entry,stop,target,riskReward:rr,validLevels:!conflicts.length,conflicts},confluence:{confirmations,warnings,conflicts,score:clamp(confirmations.length*12-warnings.length*10-conflicts.length*25,0,100)},recommendation:conflicts.length?"Do not use these invalid levels. Recalculate the plan.":warnings.length?"Wait for fresh, aligned evidence; review the market data and ETI signal gates before entry.":"Evidence is aligned in this submitted snapshot. Still validate risk, execution conditions and stop before placing an order.",forecastDisclaimer:"Forecasts are probabilistic; this coach cannot guarantee profitable or successful trades. This assessment is informational and never executes orders."};
}
