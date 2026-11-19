/** Fuse already-computed modules into a compact, transparent desk summary. */
export function fuseIntelligence(input:any){
 const sections=["forecast","whales","signal","risk","execution","agent"],missing=sections.filter(k=>input?.[k]==null);
 const f=input?.forecast,w=input?.whales,s=input?.signal,r=input?.risk,e=input?.execution,a=input?.agent;
 const direction=f?.directionalBias??s?.direction??"unknown",riskBlocked=r?.entryAllowed===false||r?.approved===false,agentVeto=a?.vetoes?.length>0||a?.approvedAction==="analyze";
 const flags:string[]=[];if(missing.length)flags.push("missing_inputs:"+missing.join(","));if(f?.stale===true)flags.push("forecast_stale");if(riskBlocked)flags.push("risk_veto");if(agentVeto)flags.push("agent_restricted");if(w?.netFlowUsd<0)flags.push("net_wallet_outflow");
 const scoreParts=[Number(f?.confidence)||0,Number(s?.confidence)||0,Math.max(0,100-Number(e?.estimatedTotalCostBps||0)*2),riskBlocked?0:100].filter(Number.isFinite);
 const readiness=scoreParts.length?Math.round(scoreParts.reduce((x,y)=>x+y,0)/scoreParts.length):0;
 return {asOf:Date.now(),status:missing.length?"partial":"complete",missingInputs:missing,directionalBias:direction,riskBlocked,agentRestricted:agentVeto,readinessScore:readiness,flags,components:{forecast:f??null,whales:w??null,signal:s??null,risk:r??null,execution:e??null,agent:a??null},summary:missing.length?"Partial intelligence fusion; supply missing component results.":riskBlocked?"Risk controls veto new entries.":agentVeto?"Agent is limited to analysis.":"Intelligence fused; treat output as decision support, not an order."};
}
