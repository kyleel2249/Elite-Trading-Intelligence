/** Deterministic EMA crossover candle replay with explicit fee/slippage assumptions. */
export function replayEmaStrategy(input:unknown,opts:{fast?:number;slow?:number;feeBps?:number;slippageBps?:number}={}){
 if(!Array.isArray(input)||input.length<30||input.length>2000)throw new Error("backtest_requires_30_to_2000_candles");
 const fast=Math.floor(opts.fast??12),slow=Math.floor(opts.slow??26),fee=Math.max(0,Math.min(100,Number(opts.feeBps??8)))/10000,slip=Math.max(0,Math.min(100,Number(opts.slippageBps??5)))/10000;
 if(fast<2||slow<=fast||slow>200)throw new Error("invalid_ema_periods");
 const candles=input.map((c:any)=>({time:Number(c?.time),close:Number(c?.close)}));for(let i=0;i<candles.length;i++)if(!Number.isFinite(candles[i].time)||!Number.isFinite(candles[i].close)||candles[i].close<=0||(i>0&&candles[i].time<=candles[i-1].time))throw new Error("invalid_backtest_candle");
 const ema=(period:number)=>{const k=2/(period+1),out:number[]=[];let v=candles[0].close;out.push(v);for(let i=1;i<candles.length;i++){v=candles[i].close*k+v*(1-k);out.push(v);}return out;};
 const f=ema(fast),s=ema(s);let position=0,entry=0,entryTime=0,equity=1,peak=1,maxDD=0;const trades:{entryTime:number;exitTime:number;side:"long"|"short";returnPct:number}[]=[];
 for(let i=1;i<candles.length;i++){const next=f[i]>s[i]?1:-1;if(next===position)continue;
  if(position!==0){const exitPrice=candles[i].close*(position>0?1-slip:1+slip),gross=position*(exitPrice-entry)/entry,net=gross-2*fee;equity*=Math.max(0,1+net);trades.push({entryTime,exitTime:candles[i].time,side:position>0?"long":"short",returnPct:net*100});peak=Math.max(peak,equity);maxDD=Math.max(maxDD,1-equity/peak);}
  position=next;entry=candles[i].close*(position>0?1+slip:1-slip);entryTime=candles[i].time;
 }
 const wins=trades.filter(t=>t.returnPct>0),losses=trades.filter(t=>t.returnPct<=0),grossWin=wins.reduce((a,t)=>a+t.returnPct,0),grossLoss=Math.abs(losses.reduce((a,t)=>a+t.returnPct,0);
 return {method:"EMA crossover replay",periods:{fast,slow},assumptions:{feeBps:fee*10000,slippageBps:slip*10000,startingEquity:1},trades:trades.length,wins:wins.length,losses:losses.length,winRatePct:trades.length?wins.length/trades.length*100:0,netReturnPct:(equity-1)*100,profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?null:0,maxDrawdownPct:maxDD*100,averageTradePct:trades.length?trades.reduce((a,t)=>a+t.returnPct,0)/trades.length:0,openPosition:position?"unclosed_"+(position>0?"long":"short"):"flat",closedTrades:trades.slice(-200)};
}
