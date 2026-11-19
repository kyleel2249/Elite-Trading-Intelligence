/** Capital guard: advisory sizing and vetoes only. Never submits or modifies orders. */
export function evaluateCapitalRisk(input:any){
 if(!input||typeof input!=="object"||!Number.isFinite(Number(input.equity))||Number(input.equity)<=0)throw new Error("positive_equity_required");
 const equity=Number(input.equity),riskPct=Math.min(2,Math.max(0,Number(input.riskPct??0.5))),riskUsd=equity*riskPct/100;
 const dailyLossPct=Math.max(0,Number(input.dailyLossPct||0)),drawdownPct=Math.max(0,Number(input.drawdownPct||0)),leverage=Math.max(0,Number(input.leverage||1));
 const positions=Array.isArray(input.positions)?input.positions.slice(0,100):[],exposure=positions.reduce((sum,p)=>sum+Math.max(0,Number(p?.notionalUsd)||0),0),exposurePct=exposure/equity*100;
 const limits={maxDailyLossPct:Math.min(10,Math.max(0,Number(input.maxDailyLossPct??2))),maxDrawdownPct:Math.min(50,Math.max(0,Number(input.maxDrawdownPct??10))),maxExposurePct:Math.min(1000,Math.max(1,Number(input.maxExposurePct??100))),maxLeverage:Math.min(100,Math.max(1,Number(input.maxLeverage??5))),maxPositions:Math.min(100,Math.max(1,Math.floor(Number(input.maxPositions??5))))};
 const reasons:string[]=[];if(dailyLossPct>=limits.maxDailyLossPct)reasons.push("daily_loss_limit");if(drawdownPct>=limits.maxDrawdownPct)reasons.push("drawdown_limit");if(exposurePct>=limits.maxExposurePct)reasons.push("exposure_limit");if(leverage>limits.maxLeverage)reasons.push("leverage_limit");if(positions.length>=limits.maxPositions)reasons.push("position_count_limit");
 const entryAllowed=reasons.length===0,stopDistancePct=Math.max(0.05,Math.min(20,Number(input.stopDistancePct??1))),notional=riskUsd/(stopDistancePct/100),capNotional=Math.max(0,equity*limits.maxExposurePct/100-exposure),suggestedNotional=Math.min(notional,capNotional),qty=Number(input.price)>0?suggestedNotional/Number(input.price):null;
 return {asOf:Date.now(),entryAllowed,reasons,equity,riskBudgetUsd:riskUsd,requestedRiskPct:riskPct,stopDistancePct,suggestedNotionalUsd:suggestedNotional,suggestedQuantity:qty,exposureUsd:exposure,exposurePct,limits,leverage,mode:"advisory_no_execution"};
}
