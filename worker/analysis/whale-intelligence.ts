/** Wallet-flow heuristics; source records must be supplied by an upstream on-chain collector. */
export type WalletFlow={wallet:string;amountUsd:number;direction:"inflow"|"outflow";timestamp:number;counterparty?:string;exchange?:boolean};
export function scoreWalletFlows(input:unknown,now=Date.now()){
 if(!Array.isArray(input)||input.length>1000)throw new Error("flows_require_array_max_1000");
 const rows=input as WalletFlow[];const valid=rows.filter(x=>x&&typeof x.wallet==="string"&&x.wallet.length<=160&&Number.isFinite(x.amountUsd)&&x.amountUsd>0&&["inflow","outflow"].includes(x.direction)&&Number.isFinite(x.timestamp)&&x.timestamp>0&&now-x.timestamp<=7*86400000&&now>=x.timestamp);
 const walletMap=new Map<string,{inflow:number;outflow:number;count:number;exchange:boolean;latest:number}>();
 for(const x of valid){const v=walletMap.get(x.wallet)||{inflow:0,outflow:0,count:0,exchange:false,latest:0};v[x.direction]+=x.amountUsd;v.count++;v.exchange=v.exchange||x.exchange===true;v.latest=Math.max(v.latest,x.timestamp);walletMap.set(x.wallet,v);}
 const wallets=[...walletMap].map(([wallet,v])=>({wallet,netFlowUsd:v.inflow-v.outflow,inflowUsd:v.inflow,outflowUsd:v.outflow,transactions:v.count,exchangeTagged:v.exchange,lastSeen:v.latest,signal:v.inflow>v.outflow*1.5?"accumulation":v.outflow>v.inflow*1.5?"distribution":"mixed",score:Math.min(100,Math.round(Math.log10(Math.max(1,v.inflow+v.outflow))*12+Math.abs(v.inflow-v.outflow)/(v.inflow+v.outflow)*50))})).sort((a,b)=>b.score-a.score);
 return {asOf:now,validEvents:valid.length,ignoredEvents:rows.length-valid.length,netFlowUsd:valid.reduce((s,x)=>s+(x.direction==="inflow"?x.amountUsd:-x.amountUsd),0),largeFlows:valid.filter(x=>x.amountUsd>=100000).length,exchangeInflowUsd:valid.filter(x=>x.exchange&&x.direction==="inflow").reduce((s,x)=>s+x.amountUsd,0),exchangeOutflowUsd:valid.filter(x=>x.exchange&&x.direction==="outflow").reduce((s,x)=>s+x.amountUsd,0),wallets:wallets.slice(0,100)};
}
