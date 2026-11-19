/** Approximate market-impact estimator from supplied top-of-book/depth snapshots; no order placement. */
export function estimateExecution(input:any){
 if(!input||!Number.isFinite(Number(input.price))||Number(input.price)<=0||!Number.isFinite(Number(input.sizeUsd))||Number(input.sizeUsd)<=0)throw new Error("positive_price_and_size_required");
 const price=Number(input.price),size=Number(input.sizeUsd),spreadBps=Math.max(0,Math.min(5000,Number(input.spreadBps??0))),depthUsd=Math.max(0,Number(input.depthUsd??0)),side=input.side==="sell"?"sell":"buy",feesBps=Math.max(0,Math.min(100,Number(input.feeBps??0)));
 const impactBps=depthUsd>0?Math.min(1000,(size/depthUsd)*10000*0.5):null,impactAvailable=impactBps!==null,estimatedSlippageBps=impactAvailable?spreadBps/2+impactBps:spreadBps/2;
 const costBps=estimatedSlippageBps+feesBps,avgFillPrice=price*(1+(side==="buy"?1:-1)*estimatedSlippageBps/10000),costUsd=size*costBps/10000,participationPct=depthUsd?size/depthUsd*100:null;
 const warnings:string[]=[];if(!impactAvailable)warnings.push("depth_missing_slippage_underestimates_impact");if(participationPct!==null&&participationPct>10)warnings.push("large_depth_participation");if(spreadBps>30)warnings.push("wide_spread");
 return {side,notionalUsd:size,referencePrice:price,spreadBps,depthUsd,estimatedImpactBps:impactBps,estimatedSlippageBps,feeBps:feesBps,estimatedTotalCostBps:costBps,estimatedCostUsd:costUsd,estimatedAverageFillPrice:avgFillPrice,participationPct,warnings,executionQuality:costBps<10?"good":costBps<40?"fair":"poor",mode:"estimate_only"};
}
