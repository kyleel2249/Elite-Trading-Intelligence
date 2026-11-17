export const BITGET_CLIENT_JS = String.raw`(function(){
"use strict";
var HOSTS=["https://api.bitget.com","https://capi.bitget.com"];
var V3_INTERVAL={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1D","1w":"1W"};
var SPOT_GRAN={"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","4h":"4h","6h":"6Hutc","12h":"12Hutc","1d":"1Dutc","1w":"1Wutc"};
var MIX_GRAN={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1Dutc","1w":"1Wutc"};
var PRODUCT_TYPES=["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"];
function q(obj){var a=[];Object.keys(obj).forEach(function(k){if(obj[k]!==undefined&&obj[k]!==null&&obj[k]!=="")a.push(encodeURIComponent(k)+"="+encodeURIComponent(String(obj[k])))});return a.join("&")}
function num(v){var n=Number(v);return Number.isFinite(n)?n:null}
function millis(v){var n=num(v);return n===null?null:n<1e12?n*1000:n}
function goodStatus(x){if(x===undefined||x===null||x==="")return true;return ["online","normal","trading","1"].indexOf(String(x).toLowerCase())>=0}
function truth(v){return v===true||["true","yes","1"].indexOf(String(v==null?"":v).toLowerCase())>=0}
async function request(pathV3,pathsV2){
 var paths=[];if(pathV3)paths.push({path:pathV3,version:"v3"});(pathsV2||[]).forEach(function(p){paths.push({path:p,version:"v2"})});
 var attempts=[];
 for(var h=0;h<HOSTS.length;h++){
  for(var i=0;i<paths.length;i++){
   var full=HOSTS[h]+paths[i].path;
   try{
    var res=await fetch(full,{method:"GET",mode:"cors",credentials:"omit",cache:"no-store",headers:{accept:"application/json"},signal:AbortSignal.timeout(10000)});
    var body=await res.json().catch(function(){return null});
    attempts.push(full+":"+res.status);
    if(res.ok&&body&&body.code==="00000"&&body.data!==undefined)return {data:body.data,host:HOSTS[h],version:paths[i].version};
   }catch(e){attempts.push(full+":"+(e&&e.name?e.name:"network_or_cors_error"))}
  }
 }
 throw new Error("Bitget browser connection failed (network, CORS or exchange restriction). "+attempts.join(" | "));
}
function parseCandles(data){
 return (Array.isArray(data)?data:[]).map(function(r){
  if(!Array.isArray(r))return null;
  var row=[millis(r[0]),num(r[1]),num(r[2]),num(r[3]),num(r[4]),num(r[5])];
  return row.every(function(x){return x!==null})&&row[0]>0&&row[1]>0&&row[2]>=Math.max(row[1],row[4])&&row[3]<=Math.min(row[1],row[4])&&row[2]>=row[3]&&row[3]>0&&row[5]>=0?row:null;
 }).filter(Boolean).sort(function(a,b){return a[0]-b[0]});
}
function candleRequest(symbol,interval,limit,market,category){
 var futures=market==="futures",cat=futures?category:"SPOT",gran=(futures?MIX_GRAN:SPOT_GRAN)[interval],v3iv=V3_INTERVAL[interval];
 if(!gran||!v3iv)throw new Error("Unsupported Bitget candle interval: "+interval);
 var v3="/api/v3/market/candles?"+q({category:cat,symbol:symbol,interval:v3iv,limit:limit});
 var v2limit=futures?Math.min(limit,200):Math.min(limit,1000);
 var v2q={symbol:symbol,granularity:gran,limit:v2limit};
 var v2=futures?"/api/v2/mix/market/"+(["1m","3m","5m"].indexOf(interval)>=0?"candles":"history-candles")+"?"+q(Object.assign({},v2q,{productType:cat})):"/api/v2/spot/market/candles?"+q(v2q);
 return {v3:v3,v2:v2,gran:gran,futures:futures,category:cat};
}
async function candles(opts){
 var symbol=String(opts.symbol||"").toUpperCase(),interval=String(opts.interval||"1m"),limit=Math.max(210,Math.min(1000,Number(opts.limit)||300)),market=opts.market==="futures"?"futures":"spot",category=opts.category||"USDT-FUTURES";
 if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error("Invalid Bitget symbol");
 var paths=candleRequest(symbol,interval,limit,market,category),first=await request(paths.v3,[paths.v2]),rows=parseCandles(first.data);
 if(first.version==="v2"&&paths.futures&&rows.length<limit&&rows.length){
  var remaining=limit-rows.length,oldest=rows[0][0],history="/api/v2/mix/market/history-candles?"+q({symbol:symbol,productType:category,granularity:paths.gran,limit:Math.min(200,remaining),endTime:Math.max(1,oldest-1)});
  try{var older=await request(null,[history]);rows=parseCandles(older.data).concat(rows).sort(function(a,b){return a[0]-b[0]})}catch(e){}
 }
 if(!rows.length)throw new Error("Bitget returned no candle rows");
 const latest=rows[rows.length-1],tfMs={"1m":60000,"3m":180000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"4h":14400000,"6h":21600000,"12h":43200000,"1d":86400000,"1w":604800000}[interval],age=Date.now()-latest[0];
 if(age < -60000 || age > tfMs*3)throw new Error("Bitget "+interval+" candles are stale ("+Math.round(age/1000)+"s old)");
 return rows.slice(-limit);
}
function parseDepth(data){
 var d=data||{},b=(d.bids||[]).map(function(x){return [num(x[0]),num(x[1])]}).filter(function(x){return x[0]!==null&&x[1]!==null&&x[0]>0&&x[1]>0}),a=(d.asks||[]).map(function(x){return [num(x[0]),num(x[1])]}).filter(function(x){return x[0]!==null&&x[1]!==null&&x[0]>0&&x[1]>0});
 return {bids:b,asks:a,timestamp:Date.now()};
}
function parseTrades(data){
 return (Array.isArray(data)?data:[]).map(function(t){
  if(Array.isArray(t))return {T:millis(t[0])||0,m:String(t[3]||"").toLowerCase()==="sell",p:String(t[1]||""),q:String(t[2]||"")};
  return {T:millis(t.ts||t.time||t.cTime||t.uTime)||0,m:String(t.side||"").toLowerCase()==="sell",p:String(t.price||t.fillPrice||""),q:String(t.size||t.baseVolume||t.qty||"")};
 }).filter(function(t){return t.T>0&&Number(t.p)>0&&Number(t.q)>0}).sort(function(a,b){return b.T-a.T}).slice(0,100);
}
function parseTicker(data){
 var t=Array.isArray(data)?data[0]:(data||{}),last=num(t.lastPr||t.lastPrice),open=num(t.open||t.open24h||t.openPrice24h),pct=num(t.priceChangePercent||t.change24h);
 if(pct!==null)pct=pct*100;else pct=open&&last!==null?(last-open)/open*100:0;
 return {lastPrice:last,highPrice:num(t.highPrice24h||t.high24h),lowPrice:num(t.lowPrice24h||t.low24h),volume:num(t.baseVolume||t.volume24h||t.baseVol),quoteVolume:num(t.quoteVolume||t.turnover24h||t.usdtVolume),priceChangePercent:pct,fundingRate:num(t.fundingRate),openInterest:num(t.openInterest||t.holdingAmount),timestamp:millis(t.ts||t.timestamp||t.time)||Date.now()};
}
async function context(opts){
 var symbol=String(opts.symbol||"").toUpperCase(),market=opts.market==="futures"?"futures":"spot",category=market==="futures"?(opts.category||"USDT-FUTURES"):"SPOT",futures=market==="futures",depthLimit=Math.max(5,Math.min(100,Number(opts.depthLimit)||20)),tradeLimit=Math.max(1,Math.min(100,Number(opts.tradeLimit)||50));
 var v3d="/api/v3/market/orderbook?"+q({category:category,symbol:symbol,limit:depthLimit}),v2d=futures?"/api/v2/mix/market/merge-depth?"+q({symbol:symbol,productType:category,limit:depthLimit}):"/api/v2/spot/market/orderbook?"+q({symbol:symbol,type:"step0",limit:depthLimit});
 var v3t="/api/v3/market/fills?"+q({category:category,symbol:symbol,limit:tradeLimit}),v2t=futures?"/api/v2/mix/market/fills?"+q({symbol:symbol,productType:category,limit:tradeLimit}):"/api/v2/spot/market/fills?"+q({symbol:symbol,limit:tradeLimit});
 var v3k="/api/v3/market/tickers?"+q({category:category,symbol:symbol}),v2k=futures?"/api/v2/mix/market/ticker?"+q({symbol:symbol,productType:category}):"/api/v2/spot/market/tickers?"+q({symbol:symbol});
 var results=await Promise.allSettled([request(v3d,[v2d]),request(v3t,[v2t]),request(v3k,[v2k])]),failures={};
 var depth=results[0].status==="fulfilled"?parseDepth(results[0].value.data):null,trades=results[1].status==="fulfilled"?parseTrades(results[1].value.data):[],ticker=results[2].status==="fulfilled"?parseTicker(results[2].value.data):null;
 ["depth","trades","ticker"].forEach(function(k,i){if(results[i].status==="rejected")failures[k]=results[i].reason&&results[i].reason.message||"unavailable"});
 return {depth:depth,trades:trades,ticker:ticker,derivatives:futures&&ticker?{fundingRate:ticker.fundingRate,openInterest:ticker.openInterest,timestamp:ticker.timestamp,source:"bitget-browser"}:null,failures:failures};
}
async function marketData(opts){
 var c=await candles(opts),x=await context(opts);
 if(!c.length)throw new Error("Bitget returned no candles");
 return {candles:c,depth:x.depth||{bids:[],asks:[]},trades:x.trades,ticker:x.ticker||{lastPrice:c[c.length-1][4],volume:c[c.length-1][5],priceChangePercent:0},derivatives:x.derivatives,failures:x.failures,provider:"bitget-browser"};
}
function categoryOf(base,quote){return "crypto"}
function instrumentRows(data,market,productType){
 return (Array.isArray(data)?data:[]).filter(function(x){return x&&goodStatus(x.status||x.symbolStatus||x.symbolStatusText)&&/^[A-Z0-9]{5,20}$/.test(String(x.symbol||""))&&String(x.baseCoin||"")&&String(x.quoteCoin||"")&&(!productType||!x.type||["perpetual","delivery"].indexOf(String(x.type).toLowerCase())>=0)}).map(function(x){
  var symbol=String(x.symbol).toUpperCase(),base=String(x.baseCoin).toUpperCase(),quote=String(x.quoteCoin).toUpperCase(),row=[symbol,base,quote,market,categoryOf(base,quote),"bitget"];
  if(productType)row.push(productType,String(x.type||x.symbolType||"perpetual").toLowerCase());
  return row;
 });
}
async function symbols(kind){
 var jobs=[];
 if(kind==="all"||kind==="spot")jobs.push({market:"spot",category:"SPOT",v2:"/api/v2/spot/public/symbols"});
 if(kind==="all"||kind==="futures")PRODUCT_TYPES.forEach(function(pt){jobs.push({market:"futures",category:pt,v2:"/api/v2/mix/market/contracts?productType="+encodeURIComponent(pt),pt:pt})});
 if(kind==="margin")jobs.push({market:"margin",category:"MARGIN",v2:"/api/v2/margin/currencies"});
 var settled=await Promise.allSettled(jobs.map(function(j){return request("/api/v3/market/instruments?category="+encodeURIComponent(j.category),[j.v2]).then(function(r){return {job:j,data:r.data}})})),rows=[],warnings=[];
 settled.forEach(function(r){if(r.status!=="fulfilled"){warnings.push(r.reason&&r.reason.message||"catalogue unavailable");return}
  var j=r.value.job,data=Array.isArray(r.value.data)?r.value.data:[];
  if(j.market==="margin"){
   data.filter(function(x){return x&&goodStatus(x.status||"online")&&/^[A-Z0-9]{5,20}$/.test(String(x.symbol||""))}).forEach(function(x){
    var base=String(x.baseCoin||"").toUpperCase(),quote=String(x.quoteCoin||"").toUpperCase(),cross=x.isCrossBorrowable===undefined?Number(x.maxCrossedLeverage)>0:truth(x.isCrossBorrowable),iso=x.isIsolatedBaseBorrowable===undefined&&x.isIsolatedQuoteBorrowable===undefined?Number(x.maxIsolatedLeverage)>0:truth(x.isIsolatedBaseBorrowable)||truth(x.isIsolatedQuoteBorrowable);
    rows.push([String(x.symbol).toUpperCase(),base,quote,"margin",categoryOf(base,quote),"bitget",null,null,cross,iso,Number(x.maxCrossedLeverage)||0,Number(x.maxIsolatedLeverage)||0,truth(x.isIsolatedBaseBorrowable),truth(x.isIsolatedQuoteBorrowable),x.isCrossBorrowable===undefined?cross:truth(x.isCrossBorrowable)]);
   });
  }else rows.push.apply(rows,instrumentRows(data,j.market,j.pt));
 });
 var seen={};rows=rows.filter(function(r){var key=r[0]+"|"+(r[6]||"")+"|"+r[3];if(seen[key])return false;seen[key]=1;return true}).sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0});
 if(kind==="margin"&&!rows.length)warnings.push("Bitget returned no margin-eligible pairs for the selected account/product region");
 if(!rows.length&&warnings.length)throw new Error("Bitget catalogue unavailable: "+warnings.join("; "));
 return {data:{symbols:rows,warnings:warnings},provider:"bitget-browser",failover:false};
}
async function loadSignalInputs(opts){
 var intervals=["1m","5m","15m","30m","1h","4h","1d","1w"],entries=await Promise.all(intervals.map(async function(iv){return [iv,await candles({symbol:opts.symbol,interval:iv,limit:300,market:opts.market,category:opts.category})]})),candleMap={};
 entries.forEach(function(x){candleMap[x[0]]=x[1]});
 var x=await context(opts);
 return {candles:candleMap,depth:x.depth,derivatives:x.derivatives,provider:"bitget-browser",market:opts.market,category:opts.category,failures:x.failures};
}
window.ETIBitget={request:request,candles:candles,context:context,marketData:marketData,symbols:symbols,loadSignalInputs:loadSignalInputs};
})();`;
