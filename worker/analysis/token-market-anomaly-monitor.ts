/**
 * ETI Token Market Anomaly Monitor.
 * Provider-reported DEX snapshots are compared with persisted prior snapshots.
 * Alerts are informational and never execute trades.
 */
const CHAIN_IDS:Record<string,string>={ethereum:"ethereum",base:"base",arbitrum:"arbitrum",polygon:"polygon",optimism:"optimism",solana:"solana"};
const asNum=(x:any)=>Number.isFinite(Number(x))?Number(x):0;
export interface TokenMarketSnapshot {priceUsd:number;liquidityUsd:number;volume24hUsd:number;change24hPct:number;fdvUsd:number|null;marketCapUsd:number|null;pairAddress:string|null;source:string}
export function selectMarketSnapshot(pairs:any[]):TokenMarketSnapshot|null{
 const usable=(Array.isArray(pairs)?pairs:[]).filter(p=>p?.baseToken?.address&&p?.priceUsd&&p?.liquidity?.usd!=null);
 if(!usable.length)return null;
 usable.sort((a,b)=>asNum(b.liquidity?.usd)-asNum(a.liquidity?.usd));
 const p=usable[0];return {priceUsd:asNum(p.priceUsd),liquidityUsd:asNum(p.liquidity?.usd),volume24hUsd:asNum(p.volume?.h24),change24hPct:asNum(p.priceChange?.h24),fdvUsd:p.fdv!=null?asNum(p.fdv):null,marketCapUsd:p.marketCap!=null?asNum(p.marketCap):null,pairAddress:p.pairAddress||null,source:"DexScreener"};
}
export function detectMarketAnomalies(previous:TokenMarketSnapshot|null,current:TokenMarketSnapshot|null){
 if(!previous||!current)return [];
 const pricePct=previous.priceUsd>0?(current.priceUsd-previous.priceUsd)/previous.priceUsd*100:0,liqPct=previous.liquidityUsd>0?(current.liquidityUsd-previous.liquidityUsd)/previous.liquidityUsd*100:0,volRatio=previous.volume24hUsd>0?current.volume24hUsd/previous.volume24hUsd:0,alerts:any[]=[];
 if(Math.abs(pricePct)>=10)alerts.push({kind:pricePct>0?"price_surge":"price_drop",severity:Math.abs(pricePct)>=20?"high":"medium",changePct:Number(pricePct.toFixed(2)),summary:"Price moved "+pricePct.toFixed(2)+"% since the previous ETI snapshot."});
 if(previous.volume24hUsd>0&&volRatio>=3)alerts.push({kind:"volume_surge",severity:volRatio>=5?"high":"medium",ratio:Number(volRatio.toFixed(2)),summary:"Reported 24h volume is "+volRatio.toFixed(2)+"x the previous ETI snapshot."});
 if(liqPct<=-20)alerts.push({kind:"liquidity_drop",severity:liqPct<=-40?"high":"medium",changePct:Number(liqPct.toFixed(2)),summary:"Reported liquidity declined "+Math.abs(liqPct).toFixed(2)+"% since the previous ETI snapshot."});
 return alerts;
}
export async function fetchTokenMarketSnapshot(chain:string,address:string,fetcher:typeof fetch=fetch):Promise<TokenMarketSnapshot|null>{
 const id=CHAIN_IDS[chain];if(!id)return null;
 const r=await fetcher("https://api.dexscreener.com/token-pairs/v1/"+encodeURIComponent(id)+"/"+encodeURIComponent(address),{headers:{accept:"application/json"},signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error("dexscreener_http_"+r.status);const data=await r.json();return selectMarketSnapshot(Array.isArray(data)?data:[]);
}
export async function runTokenMarketAnomalyCycle(env:any,now=Date.now(),fetcher:typeof fetch=fetch){
 const db=env.ETI_PORTFOLIO_DB;if(!db?.prepare)return {scanned:0,alerts:0,failures:0};
 await db.prepare("CREATE TABLE IF NOT EXISTS eti_token_market_snapshots (owner_id TEXT NOT NULL,watch_id TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,price_usd REAL NOT NULL,liquidity_usd REAL NOT NULL,volume24h_usd REAL NOT NULL,fdv_usd REAL,market_cap_usd REAL,pair_address TEXT,source TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner_id,watch_id))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS eti_token_alerts (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,watch_id TEXT NOT NULL,chain TEXT NOT NULL,token_address TEXT NOT NULL,tx_hash TEXT NOT NULL,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL,acknowledged_at INTEGER)").run();
 const watches=await db.prepare("SELECT w.owner_id,w.watch_id,w.chain,w.token_address,w.token_symbol,w.token_name FROM eti_token_watchlist w LEFT JOIN eti_token_market_snapshots m ON m.owner_id=w.owner_id AND m.watch_id=w.watch_id ORDER BY COALESCE(m.updated_at,0) ASC LIMIT 5").all(),rows=watches.results||[];let alerts=0,failures=0;
 for(let i=0;i<rows.length;i+=2){await Promise.all(rows.slice(i,i+2).map(async(w:any)=>{try{const current=await fetchTokenMarketSnapshot(w.chain,w.token_address,fetcher);if(!current)return;const old=await db.prepare("SELECT price_usd,liquidity_usd,volume24h_usd,fdv_usd,market_cap_usd,pair_address,source,updated_at FROM eti_token_market_snapshots WHERE owner_id=? AND watch_id=?").bind(w.owner_id,w.watch_id).first(),previous=old?{priceUsd:asNum(old.price_usd),liquidityUsd:asNum(old.liquidity_usd),volume24hUsd:asNum(old.volume24h_usd),fdvUsd:old.fdv_usd,marketCapUsd:old.market_cap_usd,pairAddress:old.pair_address,source:old.source}:null;
 const findings=detectMarketAnomalies(previous,current),bucket=Math.floor(now/300000);
 for(const anomaly of findings){const id=w.owner_id+":"+w.watch_id+":metric:"+anomaly.kind+":"+bucket,detail=JSON.stringify({tokenSymbol:w.token_symbol,tokenName:w.token_name,chain:w.chain,address:w.token_address,marketSnapshot:current,previousSnapshot:previous,anomaly,source:"ETI market monitor",windowMinutes:5});const result=await db.prepare("INSERT OR IGNORE INTO eti_token_alerts(id,owner_id,watch_id,chain,token_address,tx_hash,kind,detail,created_at,acknowledged_at) VALUES(?,?,?,?,?,?,?,?,?,NULL)").bind(id,w.owner_id,w.watch_id,w.chain,w.token_address,"metric:"+bucket,anomaly.kind,detail,now).run();alerts+=Number(result.meta?.changes||0);}
 await db.prepare("INSERT INTO eti_token_market_snapshots(owner_id,watch_id,chain,token_address,price_usd,liquidity_usd,volume24h_usd,fdv_usd,market_cap_usd,pair_address,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,watch_id) DO UPDATE SET chain=excluded.chain,token_address=excluded.token_address,price_usd=excluded.price_usd,liquidity_usd=excluded.liquidity_usd,volume24h_usd=excluded.volume24h_usd,fdv_usd=excluded.fdv_usd,market_cap_usd=excluded.market_cap_usd,pair_address=excluded.pair_address,source=excluded.source,updated_at=excluded.updated_at").bind(w.owner_id,w.watch_id,w.chain,w.token_address,current.priceUsd,current.liquidityUsd,current.volume24hUsd,current.fdvUsd,current.marketCapUsd,current.pairAddress,current.source,now).run();
 }catch{failures++;}}));}
 return {scanned:rows.length,alerts,failures};
}
