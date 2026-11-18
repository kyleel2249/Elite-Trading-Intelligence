export const BITGET_CLIENT_JS = String.raw`(function(){
"use strict";
var HOSTS=["https://api.bitget.com","https://capi.bitget.com"];
var V3_INTERVAL={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1D","1w":"1W"};
var SPOT_GRAN={"1m":"1min","3m":"3min","5m":"5min","15m":"15min","30m":"30min","1h":"1h","4h":"4h","6h":"6Hutc","12h":"12Hutc","1d":"1Dutc","1w":"1Wutc"};
var MIX_GRAN={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1Dutc","1w":"1Wutc"};
var PRODUCT_TYPES=["USDT-FUTURES","USDC-FUTURES","COIN-FUTURES"];
function q(obj){var a=[];Object.keys(obj).forEach(function(k){if(obj[k]!==undefined&&obj[k]!==null&&obj[k]!=="")a.push(encodeURIComponent(k)+"="+encodeURIComponent(String(obj[k])))});return a.join("&")}
function num(v){if(v===undefined||v===null||v==="")return null;var n=Number(v);return Number.isFinite(n)?n:null}
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
 throw new Error("Bitget public REST failed after trying V3/V2 endpoints and both public hosts. Check browser network/CORS restrictions. "+attempts.join(" | "));
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
 return {bids:b,asks:a,timestamp:millis(d.ts||d.timestamp||d.time)||Date.now()};
}
function parseTrades(data){
 return (Array.isArray(data)?data:[]).map(function(t){
  if(Array.isArray(t))return {T:millis(t[0])||0,m:String(t[3]||"").toLowerCase()==="sell",p:String(t[1]||""),q:String(t[2]||"")};
  return {T:millis(t.T||t.ts||t.time||t.cTime||t.uTime)||0,m:String(t.S||t.side||"").toLowerCase()==="sell",p:String(t.p||t.price||t.fillPrice||""),q:String(t.v||t.size||t.baseVolume||t.qty||"")};
 }).filter(function(t){return t.T>0&&Number(t.p)>0&&Number(t.q)>0}).sort(function(a,b){return b.T-a.T}).slice(0,100);
}
function firstNumber(){for(var i=0;i<arguments.length;i++){var n=num(arguments[i]);if(n!==null)return n}return null}
function parseTicker(data){
 var t=Array.isArray(data)?data[0]:(data||{}),last=firstNumber(t.lastPr,t.lastPrice),open=firstNumber(t.openPrice24h,t.open,t.open24h),pct=firstNumber(t.price24hPcnt,t.priceChangePercent,t.change24h);
 if(pct!==null)pct=pct*100;else pct=open&&last!==null?(last-open)/open*100:0;
 return {lastPrice:last,highPrice:firstNumber(t.highPrice24h,t.high24h),lowPrice:firstNumber(t.lowPrice24h,t.low24h),volume:firstNumber(t.baseVolume,t.volume24h,t.baseVol),quoteVolume:firstNumber(t.quoteVolume,t.turnover24h,t.usdtVolume),priceChangePercent:pct,fundingRate:firstNumber(t.fundingRate),openInterest:firstNumber(t.openInterest,t.holdingAmount),markPrice:firstNumber(t.markPrice),indexPrice:firstNumber(t.indexPrice),bidPrice:firstNumber(t.bid1Price,t.bidPr),askPrice:firstNumber(t.ask1Price,t.askPr),timestamp:millis(t.ts||t.timestamp||t.time)||Date.now()};
}
async function context(opts){
 var symbol=String(opts.symbol||"").toUpperCase(),market=opts.market==="futures"?"futures":"spot",category=market==="futures"?(opts.category||"USDT-FUTURES"):"SPOT",futures=market==="futures",depthLimit=Math.max(5,Math.min(100,Number(opts.depthLimit)||20)),tradeLimit=Math.max(1,Math.min(100,Number(opts.tradeLimit)||50));
 var v3d="/api/v3/market/orderbook?"+q({category:category,symbol:symbol,limit:depthLimit}),v2d=futures?"/api/v2/mix/market/merge-depth?"+q({symbol:symbol,productType:category,limit:depthLimit}):"/api/v2/spot/market/orderbook?"+q({symbol:symbol,type:"step0",limit:depthLimit});
 var v3t="/api/v3/market/fills?"+q({category:category,symbol:symbol,limit:tradeLimit}),v2t=futures?"/api/v2/mix/market/fills?"+q({symbol:symbol,productType:category,limit:tradeLimit}):"/api/v2/spot/market/fills?"+q({symbol:symbol,limit:tradeLimit});
 var v3k="/api/v3/market/tickers?"+q({category:category,symbol:symbol}),v2k=futures?"/api/v2/mix/market/ticker?"+q({symbol:symbol,productType:category}):"/api/v2/spot/market/tickers?"+q({symbol:symbol});
 var results=await Promise.allSettled([request(v3d,[v2d]),request(v3t,[v2t]),request(v3k,[v2k])]),failures={};
 var depth=results[0].status==="fulfilled"?parseDepth(results[0].value.data):null,trades=results[1].status==="fulfilled"?parseTrades(results[1].value.data):[],ticker=results[2].status==="fulfilled"?parseTicker(results[2].value.data):null;
 ["depth","trades","ticker"].forEach(function(k,i){if(results[i].status==="rejected")failures[k]=results[i].reason&&results[i].reason.message||"unavailable"});
 var now=Date.now();
 if(depth&&(now-depth.timestamp>180000||depth.timestamp-now>60000)){depth=null;failures.depth="stale order-book snapshot"}
 if(ticker&&(now-ticker.timestamp>180000||ticker.timestamp-now>60000)){ticker=null;failures.ticker="stale ticker snapshot"}
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
var LAST_GOOD={},LAST_GOOD_AT={};
async function symbols(kind){
 var jobs=[];
 if(kind==="all"||kind==="spot")jobs.push({market:"spot",category:"SPOT",v2:"/api/v2/spot/public/symbols"});
 if(kind==="all"||kind==="futures")PRODUCT_TYPES.forEach(function(pt){jobs.push({market:"futures",category:pt,v2:"/api/v2/mix/market/contracts?productType="+encodeURIComponent(pt),pt:pt})});
 if(kind==="margin")jobs.push({market:"margin",category:"MARGIN",v2:"/api/v2/margin/currencies"});
 var settled=await Promise.allSettled(jobs.map(function(j){return request("/api/v3/market/instruments?category="+encodeURIComponent(j.category),[j.v2]).then(function(r){return {job:j,data:r.data,host:r.host,version:r.version}})})),rows=[],warnings=[],sources={},now=Date.now();
 settled.forEach(function(r,idx){var j=jobs[idx],jr=[];
  if(r.status!=="fulfilled"){
   var kept=LAST_GOOD[j.category]||[];
   if(kept.length){rows.push.apply(rows,kept);warnings.push(j.category+" refresh failed; retained last successful catalogue");sources[j.category]={count:kept.length,fetchedAt:LAST_GOOD_AT[j.category]||null,stale:true,error:r.reason&&r.reason.message||"unavailable"};}
   else{warnings.push(j.category+" catalogue unavailable: "+(r.reason&&r.reason.message||"upstream error"));sources[j.category]={count:0,fetchedAt:null,stale:true,error:r.reason&&r.reason.message||"unavailable"};}
   return;
  }
  var data=Array.isArray(r.value.data)?r.value.data:[];
  if(j.market==="margin"){
   data.filter(function(x){return x&&goodStatus(x.status||"online")&&/^[A-Z0-9]{5,20}$/.test(String(x.symbol||""))}).forEach(function(x){
    var base=String(x.baseCoin||"").toUpperCase(),quote=String(x.quoteCoin||"").toUpperCase(),cross=x.isCrossBorrowable===undefined?Number(x.maxCrossedLeverage)>0:truth(x.isCrossBorrowable),iso=x.isIsolatedBaseBorrowable===undefined&&x.isIsolatedQuoteBorrowable===undefined?Number(x.maxIsolatedLeverage)>0:truth(x.isIsolatedBaseBorrowable)||truth(x.isIsolatedQuoteBorrowable);
    if(!base||!quote)return;
    jr.push([String(x.symbol).toUpperCase(),base,quote,"margin",categoryOf(base,quote),"bitget",null,null,cross,iso,Number(x.maxCrossedLeverage)||0,Number(x.maxIsolatedLeverage)||0,truth(x.isIsolatedBaseBorrowable),truth(x.isIsolatedQuoteBorrowable),x.isCrossBorrowable===undefined?cross:truth(x.isCrossBorrowable)]);
   });
  }else jr=instrumentRows(data,j.market,j.pt);
  if(!jr.length){var previous=LAST_GOOD[j.category]||[];if(previous.length){rows.push.apply(rows,previous);warnings.push(j.category+" returned an empty active catalogue; retained last successful catalogue");sources[j.category]={count:previous.length,fetchedAt:LAST_GOOD_AT[j.category]||null,stale:true,error:"empty_active_catalogue",host:r.value.host,apiVersion:r.value.version};return;}if(j.market!=="margin"){warnings.push(j.category+" returned no active contracts");sources[j.category]={count:0,fetchedAt:now,stale:true,error:"empty_active_catalogue",host:r.value.host,apiVersion:r.value.version};return;}}
  LAST_GOOD[j.category]=jr;LAST_GOOD_AT[j.category]=now;rows.push.apply(rows,jr);
  sources[j.category]={count:jr.length,fetchedAt:now,stale:false,host:r.value.host,apiVersion:r.value.version};
 });
 var seen={};rows=rows.filter(function(r){var key=r[0]+"|"+(r[6]||"")+"|"+r[3];if(seen[key])return false;seen[key]=1;return true}).sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:String(a[6]||"").localeCompare(String(b[6]||""));});
 if(kind==="margin"&&!rows.length)warnings.push("Bitget returned no margin-eligible pairs for the selected account/product region");
 if(!rows.length&&warnings.length)throw new Error("Bitget catalogue unavailable: "+warnings.join("; "));
 return {data:{symbols:rows,warnings:warnings,sources:sources,generatedAt:now,stale:Object.keys(sources).some(function(k){return sources[k].stale}),count:rows.length},provider:"bitget-browser",failover:false};
}
async function loadSignalInputs(opts){
 var intervals=["1m","5m","15m","30m","1h","4h","1d","1w"],entries=await Promise.all(intervals.map(async function(iv){try{return [iv,await candles({symbol:opts.symbol,interval:iv,limit:300,market:opts.market,category:opts.category})]}catch(e){return [iv,[]]}})),candleMap={};
 entries.forEach(function(x){candleMap[x[0]]=x[1]});
 var x=await context(opts);
 return {candles:candleMap,depth:x.depth,derivatives:x.derivatives,provider:"bitget-browser",market:opts.market,category:opts.category,failures:x.failures};
}

var WS_URL="wss://ws.bitget.com/v3/ws/public";
var WS_INTERVAL={"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1D"};
function streamProduct(market,category){if(market!=="futures")return "spot";return String(category||"USDT-FUTURES").toLowerCase();}
function streamTime(v){var n=num(v);return n===null?Date.now():millis(n)||Date.now();}
function streamCandle(row){if(Array.isArray(row)){var a=[streamTime(row[0]),num(row[1]),num(row[2]),num(row[3]),num(row[4]),num(row[5])];return a.every(function(x){return x!==null})?a:null;}var x=row||{},a=[streamTime(x.start||x.startTime||x.ts||x.time),num(x.open||x.o),num(x.high||x.h),num(x.low||x.l),num(x.close||x.c),num(x.volume||x.baseVolume||x.v)];return a.every(function(v){return v!==null})?a:null;}
function subscribe(opts,handlers){
 opts=opts||{};handlers=handlers||{};
 var symbol=String(opts.symbol||"").toUpperCase(),market=opts.market==="futures"?"futures":"spot",category=market==="futures"?(opts.category||"USDT-FUTURES"):"SPOT",interval=String(opts.interval||"1m"),product=streamProduct(market,category);
 if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error("Invalid Bitget WebSocket symbol");
 var args=[{instType:product,topic:"ticker",symbol:symbol},{instType:product,topic:"books5",symbol:symbol},{instType:product,topic:"publicTrade",symbol:symbol}];
 if(WS_INTERVAL[interval])args.push({instType:product,topic:"kline",symbol:symbol,interval:WS_INTERVAL[interval]});
 var ws=null,closed=false,retry=0,retryTimer=null,pingTimer=null,watchdog=null,lastMessageAt=0,connected=false;
 function status(state,detail){if(typeof handlers.onStatus==="function")handlers.onStatus({state:state,detail:detail||"",connected:connected,lastMessageAt:lastMessageAt,retry:retry});}
 function emit(type,data,raw){if(typeof handlers.onMessage==="function")handlers.onMessage({type:type,data:data,timestamp:Date.now(),raw:raw||null});}
 function stopTimers(){if(pingTimer)clearInterval(pingTimer);if(watchdog)clearInterval(watchdog);pingTimer=null;watchdog=null;}
 function scheduleReconnect(reason){if(closed)return;connected=false;stopTimers();status("reconnecting",reason);if(retryTimer)clearTimeout(retryTimer);var wait=Math.min(30000,1000*Math.pow(2,Math.min(retry,5)));retry++;retryTimer=setTimeout(connect,wait);}
 function connect(){
  if(closed)return;
  status("connecting");
  try{ws=new WebSocket(WS_URL);}catch(e){scheduleReconnect(e&&e.message||"websocket_unavailable");return;}
  var current=ws;
  current.onopen=function(){if(closed||ws!==current)return;connected=true;retry=0;lastMessageAt=Date.now();status("connected");current.send(JSON.stringify({op:"subscribe",args:args}));pingTimer=setInterval(function(){if(ws===current&&current.readyState===1)try{current.send("ping")}catch(e){}},25000);watchdog=setInterval(function(){if(ws===current&&connected&&Date.now()-lastMessageAt>60000){try{current.close()}catch(e){}}},10000);};
  current.onmessage=function(event){if(ws!==current||closed)return;lastMessageAt=Date.now();var raw=event.data;if(raw==="pong"||raw==="ping")return;var msg;try{msg=typeof raw==="string"?JSON.parse(raw):raw}catch(e){return;}if(!msg||msg.event==="subscribe"||msg.event==="unsubscribe")return;if(msg.event==="error"){status("error",String(msg.msg||msg.code||"subscription_error"));return;}var arg=msg.arg||{},rows=Array.isArray(msg.data)?msg.data:[],topic=String(arg.topic||"");
   if(topic==="ticker"&&rows.length){var ticker=parseTicker(rows[0]);ticker.timestamp=streamTime(msg.ts||rows[0].ts);emit("ticker",ticker,msg);}
   else if(topic==="kline"&&rows.length){rows.forEach(function(row){var candle=streamCandle(row);if(candle)emit("candle",candle,msg);});}
   else if(topic==="books5"&&rows.length){var d=rows[0]||{},depth=parseDepth(d);depth.timestamp=streamTime(msg.ts||d.ts);if(depth.bids.length&&depth.asks.length&&depth.bids[0][0]<depth.asks[0][0])emit("depth",depth,msg);}
   else if(topic==="publicTrade"&&rows.length){var trades=parseTrades(rows);if(trades.length)emit("trades",trades,msg);}
  };
  current.onerror=function(){if(ws===current&&!closed)try{current.close()}catch(e){}};
  current.onclose=function(){if(ws!==current||closed)return;connected=false;ws=null;scheduleReconnect("socket_closed");};
 }
 connect();
 return {close:function(){closed=true;connected=false;if(retryTimer)clearTimeout(retryTimer);stopTimers();if(ws){var current=ws;ws=null;try{current.close()}catch(e){}}status("closed");},getState:function(){return {connected:connected,lastMessageAt:lastMessageAt,retry:retry,symbol:symbol,market:market,category:category,interval:interval,product:product};}};
}


function subscribePrivate(opts,handlers){
 opts=opts||{};handlers=handlers||{};

 var ws=null,closed=false,retry=0,retryTimer=null,pingTimer=null,watchdog=null,lastMessageAt=0,connected=false,authenticated=false;
 var url=opts.url||((window.location&&window.location.protocol==="https:"?"wss:":"ws:")+"//"+(window.location&&window.location.host||"")+"/api/bitget/ws/private?environment="+encodeURIComponent(opts.environment==="demo"?"demo":"production")+"&account="+encodeURIComponent(opts.account==="classic"?"classic":"uta"));
 function status(state,detail){if(typeof handlers.onStatus==="function")handlers.onStatus({state:state,detail:detail||"",connected:connected,authenticated:authenticated,lastMessageAt:lastMessageAt,retry:retry});}
 function emit(type,data,raw){if(typeof handlers.onMessage==="function")handlers.onMessage({type:type,data:data,timestamp:Date.now(),raw:raw||null});}
 function stopTimers(){if(pingTimer)clearInterval(pingTimer);if(watchdog)clearInterval(watchdog);pingTimer=null;watchdog=null;}
 function scheduleReconnect(reason){if(closed)return;connected=false;authenticated=false;stopTimers();status("reconnecting",reason);if(retryTimer)clearTimeout(retryTimer);var wait=Math.min(30000,1000*Math.pow(2,Math.min(retry,5)));retry++;retryTimer=setTimeout(connect,wait);}
 function connect(){
  if(closed)return;status("connecting");
  try{ws=new WebSocket(url);}catch(e){scheduleReconnect(e&&e.message||"websocket_unavailable");return;}
  var current=ws;
  current.onopen=function(){if(closed||ws!==current)return;connected=true;lastMessageAt=Date.now();status("connecting");pingTimer=setInterval(function(){if(ws===current&&current.readyState===1)try{current.send("ping")}catch(e){}},30000);watchdog=setInterval(function(){if(ws===current&&connected&&Date.now()-lastMessageAt>65000){try{current.close()}catch(e){}}},10000);};
  current.onmessage=function(event){if(ws!==current||closed)return;lastMessageAt=Date.now();var raw=event.data;if(raw==="pong"||raw==="ping")return;var msg;try{msg=typeof raw==="string"?JSON.parse(raw):raw}catch(e){emit("raw",raw,null);return;}if(!msg)return;if(msg.event==="status"){authenticated=msg.state==="authenticated";status(msg.state);emit("status",msg,null);return;}if(msg.event==="error"){emit("error",msg,msg);if(msg.code==="unauthorized"||msg.code==="bitget_login_rejected")try{current.close()}catch(e){}return;}var topic=String((msg.arg||{}).topic||"");if(topic==="account"||topic==="order"||topic==="position"||topic==="fill")emit(topic,{action:msg.action||null,ts:streamTime(msg.ts),data:Array.isArray(msg.data)?msg.data:[]},msg);else emit("raw",msg,msg);};
  current.onerror=function(){if(ws===current&&!closed)try{current.close()}catch(e){}};
  current.onclose=function(){if(ws!==current||closed)return;connected=false;ws=null;scheduleReconnect("socket_closed");};
 }
 connect();
 return {close:function(){closed=true;connected=false;authenticated=false;if(retryTimer)clearTimeout(retryTimer);stopTimers();if(ws){var current=ws;ws=null;try{current.close()}catch(e){}}status("closed");},getState:function(){return {connected:connected,authenticated:authenticated,lastMessageAt:lastMessageAt,retry:retry};}};
}

function transportEndpoint(environment,account,protocol){
 if(protocol==="sbe"){if(account!=="uta")throw new Error("SBE is only supported for UTA public market data");if(environment!=="production")throw new Error("SBE demo endpoint is not documented");return "wss://ws.bitget.com/v3/ws/public/sbe";}
 if(account==="classic"){if(environment==="demo")throw new Error("Classic V2 demo endpoint is not documented");return "wss://ws.bitget.com/v2/ws/public";}
 return environment==="demo"?"wss://wspap.bitget.com/v3/ws/public":"wss://ws.bitget.com/v3/ws/public";
}
function transportArgs(opts){
 var symbol=String(opts.symbol||"").toUpperCase(),account=opts.account==="classic"?"classic":"uta",market=opts.market==="futures"?"futures":"spot",category=opts.category||"USDT-FUTURES",iv=String(opts.interval||"1m");
 if(!/^[A-Z0-9]{5,20}$/.test(symbol))throw new Error("Invalid Bitget WebSocket symbol");
 if(account==="classic"){
  var inst=market==="futures"?String(category).toUpperCase():"SPOT",v2iv=({"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1D","1w":"1W"})[iv]||"1m",candle="candle"+v2iv;
  return [{instType:inst,channel:"ticker",instId:symbol},{instType:inst,channel:"books5",instId:symbol},{instType:inst,channel:"trade",instId:symbol},{instType:inst,channel:candle,instId:symbol}];
 }
 var product=market==="futures"?String(category).toLowerCase():"spot";
 return [{instType:product,topic:"ticker",symbol:symbol},{instType:product,topic:"books5",symbol:symbol},{instType:product,topic:"publicTrade",symbol:symbol},{instType:product,topic:"kline",symbol:symbol,interval:({"1m":"1m","3m":"3m","5m":"5m","15m":"15m","30m":"30m","1h":"1H","4h":"4H","6h":"6H","12h":"12H","1d":"1D","1w":"1W"})[iv]||"1m"}];
}
function decodeSbeFrame(raw){
 var bytes=raw instanceof ArrayBuffer?new Uint8Array(raw):ArrayBuffer.isView(raw)?new Uint8Array(raw.buffer,raw.byteOffset,raw.byteLength):null;
 if(!bytes||bytes.length<8)throw new Error("sbe_frame_too_short");
 var v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),bl=v.getUint16(0,true),tid=v.getUint16(2,true),schema=v.getUint16(4,true),ver=v.getUint16(6,true);
 if(schema!==1)throw new Error("unsupported_sbe_schema");
 function i64(o){return Number(v.getBigInt64(o,true))}function u64(o){return Number(v.getBigUint64(o,true))}
 function text(o){var n=v.getUint8(o);if(o+1+n>bytes.length)throw new Error("sbe_string_truncated");return new TextDecoder().decode(bytes.subarray(o+1,o+1+n))}
 function scale(x,e){return x*Math.pow(10,e)}
 var out={header:{blockLength:bl,templateId:tid,schemaId:schema,version:ver}};
 if(tid===1002){
  if(bl<56||bytes.length<8+bl+1)throw new Error("sbe_bbo_truncated");
  var o=8,pe=v.getInt8(o+40),se=v.getInt8(o+41);
  out.type="books1";out.ts=u64(o);out.bids=[[scale(i64(o+8),pe),scale(i64(o+16),se)]];out.asks=[[scale(i64(o+24),pe),scale(i64(o+32),se)]];out.priceExponent=pe;out.sizeExponent=se;out.seq=u64(o+42);out.symbol=text(8+bl);return out;
 }
 if(tid===1001){
  var o=8;if(bl<24)throw new Error("sbe_depth_root_invalid");
  out.type="books50";out.ts=u64(o);out.seq=u64(o+8);out.priceExponent=v.getInt8(o+16);out.sizeExponent=v.getInt8(o+17);
  var p=o+bl;function group(){if(p+4>bytes.length)throw new Error("sbe_group_truncated");var eb=v.getUint16(p,true),n=v.getUint16(p+2,true);p+=4;if(eb<16||p+eb*n>bytes.length)throw new Error("sbe_entries_truncated");var a=[];for(var i=0;i<n;i++){a.push([scale(i64(p),out.priceExponent),scale(i64(p+8),out.sizeExponent)]);p+=eb;}return a;}
  out.asks=group();out.bids=group();out.symbol=text(p);
  if(ver>=5&&bl>=40){out.sts=u64(o+18);out.category=v.getUint8(o+26);out.pseq=u64(o+27);out.depthAction=v.getUint8(o+35);}
  return out;
 }
 if(tid===1003){
  var o=8;if(bl<8)throw new Error("sbe_trade_root_invalid");out.type="publicTrade";out.priceExponent=v.getInt8(o);out.sizeExponent=v.getInt8(o+1);
  var p=o+bl;if(p+4>bytes.length)throw new Error("sbe_trade_group_truncated");var eb=v.getUint16(p,true),n=v.getUint16(p+2,true);p+=4;if(eb<33||p+eb*n>bytes.length)throw new Error("sbe_trade_entries_truncated");
  out.trades=[];for(var i=0;i<n;i++){out.trades.push({ts:u64(p),execId:String(u64(p+8)),price:scale(i64(p+16),out.priceExponent),size:scale(i64(p+24),out.sizeExponent),side:v.getUint8(p+32)===0?"buy":"sell",isRPI:eb>33&&v.getUint8(p+33)===1});p+=eb;}
  if(bl>=16){out.sts=u64(o+2);out.category=v.getUint8(o+10);}out.symbol=text(p);return out;
 }
 throw new Error("unsupported_sbe_template_"+tid);
}
function subscribeTransport(opts,handlers){
 opts=opts||{};handlers=handlers||{};
 var environment=opts.environment==="demo"?"demo":"production",account=opts.account==="classic"?"classic":"uta",protocol=opts.protocol==="sbe"?"sbe":"json",symbol=String(opts.symbol||"").toUpperCase(),args=transportArgs(opts),url=transportEndpoint(environment,account,protocol);
 if(protocol==="sbe"&&account!=="uta")throw new Error("SBE is UTA-only");
 if(protocol==="sbe"){var inst=opts.market==="futures"?String(opts.category||"USDT-FUTURES").toLowerCase():"spot";args=[{instType:inst,topic:"books50",symbol:symbol},{instType:inst,topic:"books1",symbol:symbol},{instType:inst,topic:"publicTrade",symbol:symbol}];}
 var ws=null,closed=false,retry=0,retryTimer=null,ping=null,watchdog=null,last=0,connected=false;
 function status(s,d){if(handlers.onStatus)handlers.onStatus({state:s,detail:d||"",connected:connected,retry:retry,environment:environment,account:account,protocol:protocol});}
 function emit(type,data,raw){if(handlers.onMessage)handlers.onMessage({type:type,data:data,timestamp:Date.now(),raw:raw||null,environment:environment,account:account,protocol:protocol});}
 function stop(){if(ping)clearInterval(ping);if(watchdog)clearInterval(watchdog);ping=watchdog=null;}
 function reconnect(reason){if(closed)return;connected=false;stop();status("reconnecting",reason);var wait=Math.min(30000,1000*Math.pow(2,Math.min(retry++,5)));retryTimer=setTimeout(connect,wait);}
 function connect(){if(closed)return;status("connecting");try{ws=new WebSocket(url);ws.binaryType="arraybuffer";}catch(e){reconnect("websocket_unavailable");return;}var cur=ws;
  cur.onopen=function(){if(closed||ws!==cur)return;connected=true;retry=0;last=Date.now();status("connected");cur.send(JSON.stringify({op:"subscribe",args:args}));ping=setInterval(function(){if(ws===cur&&cur.readyState===1)try{cur.send("ping")}catch(e){}},30000);watchdog=setInterval(function(){if(ws===cur&&connected&&Date.now()-last>65000)try{cur.close()}catch(e){}},10000);};
  cur.onmessage=function(ev){if(closed||ws!==cur)return;last=Date.now();if(ev.data==="pong"||ev.data==="ping")return;
   if(protocol==="sbe"&&typeof ev.data!=="string"){try{var d=decodeSbeFrame(ev.data);if(d.type==="books1"||d.type==="books50")emit("depth",{bids:d.bids,asks:d.asks,timestamp:d.ts/1000,sequence:d.seq,pseq:d.pseq,action:d.depthAction===0?"snapshot":d.depthAction===1?"update":null,symbol:d.symbol},d);else if(d.type==="publicTrade")emit("trades",d.trades.map(function(t){return {T:t.ts/1000,p:String(t.price),q:String(t.size),m:t.side==="sell",execId:t.execId,isRPI:t.isRPI}}),d);}catch(e){emit("error",{code:"sbe_decode_failed",message:e.message},null);}return;}
   var m;try{m=JSON.parse(ev.data)}catch(e){emit("raw",ev.data,null);return;}if(m.event==="error"){emit("error",m,m);return;}if(m.event==="subscribe"||m.event==="login")return;
   var a=m.arg||{},topic=String(a.topic||a.channel||""),rows=Array.isArray(m.data)?m.data:[];
   if(topic==="ticker"&&rows.length)emit("ticker",parseTicker(rows[0]),m);
   else if(topic==="books5"&&rows.length){var dep=parseDepth(rows[0]);if(dep.bids.length&&dep.asks.length)emit("depth",dep,m);}
   else if(topic==="publicTrade"||topic==="trade"){var tr=parseTrades(rows);if(tr.length)emit("trades",tr,m);}
   else if(topic==="kline"||/^candle/.test(topic)){rows.forEach(function(row){var ca=streamCandle(row);if(ca)emit("candle",ca,m);});}
   else emit("raw",m,m);
  };
  cur.onerror=function(){if(ws===cur)try{cur.close()}catch(e){}};
  cur.onclose=function(){if(ws===cur&&!closed){ws=null;reconnect("socket_closed")}};
 }
 connect();
 return {close:function(){closed=true;connected=false;if(retryTimer)clearTimeout(retryTimer);stop();if(ws){var cur=ws;ws=null;try{cur.close()}catch(e){}}status("closed");},getState:function(){return {connected:connected,environment:environment,account:account,protocol:protocol,symbol:symbol,url:url,retry:retry}}};
}

window.ETIBitget={request:request,candles:candles,context:context,marketData:marketData,symbols:symbols,loadSignalInputs:loadSignalInputs,subscribe:subscribe,subscribePrivate:subscribePrivate,subscribeTransport:subscribeTransport,decodeSbeFrame:decodeSbeFrame};
})();`;
