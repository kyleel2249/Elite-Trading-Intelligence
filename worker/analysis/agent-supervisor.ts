/** Supervised agent permission gate; explicitly vetoes stale signals, kill switch, risk veto, missing user permission. */
export function superviseAgent(input:any){
 const actions=["analyze","paper_trade","live_trade"],requested=actions.includes(input?.requestedAction)?input.requestedAction:"analyze";
 const flags:string[]=[];if(input?.killSwitch===true)flags.push("kill_switch_active");if(input?.riskApproved!==true)flags.push("risk_not_approved");if(input?.signalFresh!==true)flags.push("signal_stale_or_missing");if(input?.userPermission!==true)flags.push("permission_not_granted");if(input?.confidence!==undefined&&(!Number.isFinite(Number(input.confidence))||Number(input.confidence)<0||Number(input.confidence)>100))flags.push("invalid_confidence");
 const action=requested==="live_trade"?(flags.length?"analyze":"live_trade"):requested==="paper_trade"?(flags.includes("kill_switch_active")?"analyze":"paper_trade"):"analyze";
 return {asOf:Date.now(),requestedAction:requested,approvedAction:action,approved:action===requested,requiresHumanApproval:requested==="live_trade",vetoes:flags,mode:"supervised",liveExecutionAuthorized:false,policy:"This endpoint never executes or places an order."};
}
