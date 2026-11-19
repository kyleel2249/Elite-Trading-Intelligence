/** Supervised agent permission gate. This API only emits decisions; live orders require external human approval. */
export function superviseAgent(input:any){
 const requested=["analyze","paper_trade","live_trade"].includes(input?.requestedAction)?input.requestedAction:"analyze";
 const vetoes:string[]=[];if(input?.killSwitch===true)vetoes.push("kill_switch_active");if(input?.riskApproved!==true)vetoes.push("risk_not_approved");if(input?.signalFresh!==true)vetoes.push("signal_stale_or_missing");if(input?.confidence!==undefined&&(!Number.isFinite(Number(input.confidence))||Number(input.confidence)<0||Number(input.confidence)>100))vetoes.push("invalid_confidence");
 const paperBlocked=vetoes.some(x=>["kill_switch_active","risk_not_approved","signal_stale_or_missing","invalid_confidence"].includes(x));
 let approvedAction="analyze",approved=false;
 if(requested==="paper_trade"&&!paperBlocked){approvedAction="paper_trade";approved=true;}
 if(requested==="live_trade"){if(input?.userPermission!==true)vetoes.push("permission_not_granted");approvedAction="pending_human_approval";approved=false;}
 return {asOf:Date.now(),requestedAction:requested,approvedAction,approved,requiresHumanApproval:requested==="live_trade",vetoes,mode:"supervised",liveExecutionAuthorized:false,policy:"This endpoint never executes or places an order."};
}
