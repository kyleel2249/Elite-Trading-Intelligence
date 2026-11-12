/**
 * ETI Cloudflare-native edge application.
 *
 * The dashboard and lightweight read-only market APIs run directly on Workers.
 * No FastAPI origin / BACKEND_URL is required. Brokerage credentials are never
 * accepted by these public market-data routes.
 *
 * Optional: when BACKEND_URL is set to an HTTP(S) origin, any route this Worker does not
 * handle itself is forwarded to that origin (see proxyToBackend). When it is unset the
 * Worker answers unknown routes with a JSON 404, exactly as before.
 */
import { withMotion } from "./ui/motion.ts";
import { handleExecution } from "./execution.ts";
import { handlePortfolio } from "./portfolio/routes.ts";
import { PORTFOLIO_CSS, PORTFOLIO_HTML, PORTFOLIO_JS, PLAN_HTML } from "./portfolio/ui.ts";
import type { ExecutionEnv } from "./execution.ts";
import { handleMarket } from "./market.ts";
import { handleSignals } from "./signals.ts";
import { handleAlgoSignal } from "./algo/api.ts";
import { handleOmnisignal } from "./algo/omni-api.ts";
import { handlePaper } from "./algo/paper-api.ts";
import { handleOmniUi } from "./algo/omni-ui.ts";
import { handleTestnetExecute } from "./algo/testnet-api.ts";
import { handleManage } from "./algo/manage.ts";
import { handleAlerts } from "./algo/alerts-api.ts";
import { handleAnalysis } from "./analysis/api.ts";
import type { AnalysisEnv } from "./analysis/fundamental-sources.ts";
import { handleKnowledge } from "./knowledge.ts";
import { handleReadiness } from "./readiness/api.ts";
import { handleCalc } from "./calc.ts";
import type { ReadinessEnv } from "./readiness/api.ts";
import type { MarketEnv } from "./market.ts";
import { handleAlpha, type AlphaEnv } from "./alpha/routes.ts";
import { handleAuth } from "./auth/routes.ts";

export interface Env extends ExecutionEnv, MarketEnv, ReadinessEnv, AlphaEnv, AnalysisEnv {
  ETI_EDGE?: string;
  MARKET_CACHE?: KVNamespace;
  BACKEND_URL?: string;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);

/** Optional reverse proxy for routes this Worker does not implement. Only used when BACKEND_URL is configured. */
async function proxyToBackend(request: Request, backend: string): Promise<Response> {
  let targetBase: URL;
  try {
    targetBase = new URL(backend);
  } catch {
    return new Response(JSON.stringify({ error: "BACKEND_URL is not a valid absolute URL" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  if (!["http:", "https:"].includes(targetBase.protocol) || targetBase.username || targetBase.password || targetBase.pathname !== "/" || targetBase.search || targetBase.hash) {
    return new Response(JSON.stringify({ error: "BACKEND_URL must be an HTTP(S) origin without credentials, path, query or fragment" }), { status: 500, headers: { "content-type": "application/json" } });
  }
  const incoming = new URL(request.url);
  // Component assignment keeps even network-path references on the configured host.
  const target = new URL(targetBase);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  if (target.origin !== targetBase.origin) {
    return new Response("Invalid proxy target", { status: 400 });
  }
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.replace(":", ""));
  const init: RequestInit = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    (init as any).duplex = "half"; // required for streaming bodies in some runtimes
  }
  try {
    const upstream = await fetch(target.toString(), init);
    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("x-eti-proxy", "cloudflare-worker");
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
  } catch {
    return new Response(JSON.stringify({ error: "backend_unreachable", message: "upstream fetch failed", backend: targetBase.origin }), { status: 502, headers: { "content-type": "application/json; charset=utf-8" } });
  }
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETI — Elite Trading Intelligence</title>
<style>
:root{color-scheme:dark;--bg:#080d16;--panel:#111b2b;--line:#24334a;--muted:#8fa3bd;--green:#21d69a;--red:#ff637d;--blue:#56a8ff}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#14233b,#080d16 55%);color:#eaf2ff;font:14px Inter,system-ui,sans-serif}
header{padding:20px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:22px;margin:0}small,.muted{color:var(--muted)}main{padding:22px 4vw;max-width:1600px;margin:auto}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}input,select,button{background:#0b1422;color:#eaf2ff;border:1px solid var(--line);border-radius:8px;padding:10px}button{cursor:pointer}button.active{border-color:var(--green);color:var(--green)}
.grid{display:grid;grid-template-columns:minmax(0,7fr) minmax(280px,3fr);gap:14px;align-items:start}.panel{background:linear-gradient(145deg,#121e30,#0d1624);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.panel h2{font-size:15px;margin:0 0 12px}.chart{height:350px;width:100%}canvas{width:100%;height:100%}.lower{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 5px;text-align:right;border-bottom:1px solid #1d2a3e;font-size:12px}th:first-child,td:first-child{text-align:left}.bid{color:var(--green)}.ask,.sell{color:var(--red)}.buy{color:var(--green)}.status{color:var(--green)}.meta{display:flex;gap:16px;flex-wrap:wrap;color:var(--muted);margin:8px 0 14px}.scroll{max-height:360px;overflow:auto}
@media(max-width:1100px){.lower{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:700px){.grid,.lower{grid-template-columns:1fr}.chart{height:280px}}

.execution-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.execution-grid label{display:flex;flex-direction:column;gap:5px;color:var(--muted);font-size:12px}.execution-grid input,.execution-grid select{width:100%;min-width:0}.execution-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.execution-actions button{font-weight:650}.btn-buy{background:#123b32;border-color:#1c8d6c;color:#62e6b7}.btn-sell{background:#401e2a;border-color:#a63e58;color:#ff8da0}.btn-live{border-color:#b65c38;color:#ffb08c}.execution-note{font-size:12px;color:var(--muted);line-height:1.5}.execution-output{white-space:pre-wrap;overflow-wrap:anywhere;background:#09111d;border:1px solid var(--line);border-radius:8px;padding:10px;min-height:42px}.history-table{max-height:320px;overflow:auto}
.execpanel{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;padding:14px}.execpanel .execution-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.execpanel .execution-grid input,.execpanel .execution-grid select{padding:8px}.execpanel summary{cursor:pointer;color:var(--muted);font-size:12px}.execpanel details{margin:0 0 10px}.execpanel .meta{margin:6px 0 10px;gap:6px 14px}
.authbanner{margin:0 0 8px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#0b1422;font-size:12px;color:var(--muted)}.authbanner.warn{border-color:#b65c38;color:#ffb08c;background:#2a1710}.authbanner.ok{border-color:#1c8d6c;color:#8ff0c8}.authenvs{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}.authenvs span{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.authenvs span.on{border-color:#1c8d6c;color:#8ff0c8}.authenvs span.off{border-color:#8a3a4a;color:#ff9db0}
.pxbar{display:flex;gap:8px 14px;flex-wrap:wrap;align-items:center;color:var(--muted);margin:0 0 8px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:#0b1422}.pxbar b{color:#eaf2ff;font-variant-numeric:tabular-nums}.pxbar button{padding:3px 8px;font-size:12px;margin-left:auto}
.execpanel .execution-actions{position:sticky;bottom:-14px;background:linear-gradient(#0d1624d9,#0d1624);padding:10px 0 12px;margin:10px 0 0;z-index:2}.execpanel .execution-actions button{flex:1 1 30%}
@media(max-width:1024px){.execpanel .execution-grid{grid-template-columns:1fr}.execpanel .execution-grid>label[style*="span 2"]{grid-column:auto!important}}
@media(max-width:700px){.execpanel{position:static;max-height:none;overflow:visible}.execpanel .execution-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.execpanel .execution-actions{position:static;padding:0;background:none}}

.legend{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 10px}.legend button{padding:4px 10px;font-size:12px;border-radius:999px;color:var(--muted)}.legend button.on{border-color:var(--blue);color:#cfe3ff;background:#10223a}
.stack{position:relative}.stack canvas{display:block}.chart.big{height:430px}.paneBox{height:96px;border-top:1px solid #1d2a3e}
.tip{position:absolute;display:none;z-index:5;pointer-events:none;background:#0b1422f2;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.55;white-space:nowrap;box-shadow:0 6px 24px #0008}
.sigcharts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin:8px 0 14px}.sigcharts canvas{height:210px}.sigcharts .execution-note{margin-bottom:4px}
.ev{margin:6px 0 0;padding-left:18px}.dot{display:inline-block;width:12px;height:12px;border-radius:50%;margin:0 3px 3px 0;background:#4a5d78;vertical-align:middle}.dot.win{background:#21d69a}.dot.loss{background:#ff637d}.dot.hc{outline:2px solid #f0c674}
@media(max-width:700px){.chart.big{height:320px}.sigcharts{grid-template-columns:1fr}.paneBox{height:84px}}
${PORTFOLIO_CSS}
</style></head><body>
<header><div><h1>ETI <span style="color:var(--blue)">Elite Trading Intelligence</span></h1><small>Market structure • Liquidity • Price discovery</small></div><div style="display:flex;gap:12px;align-items:center"><a href="/alpha" style="color:var(--blue)">Global Alpha Center</a><a href="/journal" style="color:var(--blue)">Trade Journal</a><a href="/sports" style="color:var(--blue)">Sports Betting Intelligence</a><div id="connection" class="status">Connecting…</div></div></header>
<main>
<div class="toolbar"><select id="symMarket" aria-label="Market type" title="Spot pairs, USDT/USDC-margined perpetual futures, or Metals: gold, silver, platinum, palladium, copper and gold-backed tokens from both Binance markets"><option value="spot">Spot</option><option value="futures">Futures (perpetual)</option><option value="metals">Metals (gold, silver, copper)</option></select><select id="symCat" aria-label="Contract category" style="display:none"><option value="">All types</option></select><input id="symSearch" type="search" placeholder="Search any coin or pair" aria-label="Search Binance pairs" autocomplete="off" style="width:150px"><select id="symQuote" aria-label="Quote currency filter" title="Show pairs by quote currency"><option value="">All quotes</option></select><select id="symbol"><option>BTCUSDT</option><option>ETHUSDT</option><option>BNBUSDT</option><option>SOLUSDT</option><option>XRPUSDT</option></select><span id="symEti" class="muted" aria-live="polite" style="font-size:12px;display:none"></span><span id="symCount" class="muted" aria-live="polite" style="font-size:12px"></span>
<select id="interval"><option>1m</option><option>5m</option><option>15m</option><option>1h</option><option>4h</option><option>1d</option><option>1w</option></select>
<button id="refresh" class="active">Refresh market</button><span class="muted" id="stamp">Waiting for market data…</span></div>
<div class="grid"><section class="panel"><h2>Live Market Chart</h2><div class="meta"><span>Last <b id="last">—</b></span><span>24h volume <b id="volume">—</b></span><span>24h change <b id="change">—</b></span><span>Provider <b id="provider">—</b></span><span id="stale" role="status" style="display:none;color:#ffb08c;border:1px solid #b65c38;border-radius:6px;padding:0 8px"></span></div><div id="legend" class="legend" role="group" aria-label="Chart layers"><button class="on" data-layer="ema" aria-pressed="true">EMA 20/50/200 + 20-bar range</button><button class="on" data-layer="bb" aria-pressed="true">Bollinger bands</button><button class="on" data-layer="levels" aria-pressed="true">Entry / stop / targets</button><button class="on" data-layer="markers" aria-pressed="true">Signal flips</button><button class="on" data-layer="replay" aria-pressed="true">Replay trades</button><button class="on" data-layer="ribbon" aria-pressed="true">Engine ribbon</button><button class="on" data-layer="volume" aria-pressed="true">Volume rule</button><button class="on" data-layer="trades" aria-pressed="true">My trades and orders</button></div>
<span id="overlayNote" role="status" style="display:none;color:#ffb08c;border:1px solid #b65c38;border-radius:6px;padding:0 8px;margin-bottom:8px"></span>
<div id="stack" class="stack"><div class="chart big"><canvas id="chart" role="img" aria-label="Candlestick chart with ETI signal engine overlays"></canvas></div><div class="paneBox"><canvas id="paneRsi" role="img" aria-label="RSI 14 with engine momentum zones"></canvas></div><div class="paneBox"><canvas id="paneMacd" role="img" aria-label="MACD histogram and lines"></canvas></div><div class="paneBox"><canvas id="paneAdx" role="img" aria-label="ADX 14 trend strength"></canvas></div><div class="paneBox"><canvas id="paneScore" role="img" aria-label="ETI engine score per candle"></canvas></div><div id="tip" class="tip" role="status"></div></div>
<div id="chartTicket" class="chartticket" role="region" aria-label="Trade from the chart">
<style>.chartticket{margin-top:10px;border:1px solid var(--line);border-radius:10px;padding:10px;background:#0b1422}.chartticket .ct-row{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:8px}.chartticket label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}.chartticket input{width:130px}.calcgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:8px}.calcgrid label{display:flex;flex-direction:column;gap:3px;font-size:12px;color:var(--muted)}.calckpi{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin:10px 0}.calckpi div{border:1px solid var(--line);border-radius:8px;padding:8px;background:#0b1422}.calckpi b{display:block;font-size:15px;color:var(--text)}@media(max-width:600px){.chartticket input{width:100%}.chartticket .ct-row>*{flex:1 1 120px}}</style>
<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>Trade from the chart</b><span class="muted" id="ctCursor" aria-live="off">Click the chart to pick a price, or type one.</span></div>
<div class="ct-row"><label>Price<input id="ctPrice" type="number" min="0" step="any" aria-label="Chart order price"></label><label>Quantity<input id="ctQty" type="number" min="0" step="any" aria-label="Chart order quantity"></label><button type="button" id="ctSize" title="Use the quantity from the calculator below">Calculator size</button></div>
<div class="ct-row"><button type="button" id="ctBuyLimit" class="btn-buy">Buy limit at price</button><button type="button" id="ctSellLimit" class="btn-sell">Sell limit at price</button><button type="button" id="ctBuyMkt" class="btn-buy">Buy market</button><button type="button" id="ctSellMkt" class="btn-sell">Sell market</button><button type="button" id="ctClear">Clear</button></div>
<div class="execution-note" id="ctHint" style="margin-top:8px">Orders use the same paper / testnet safeguards and confirmation as the Order Execution panel. No real money is used.</div>
</div>
<div class="execution-note" style="margin-top:8px">Every layer is the engine's own per-candle output. Ribbon: colour = BUY/SELL lean, opacity = |score|. Triangles: filled = high-conviction (|score| 55+) setup, hollow = lean flip. Green/red boxes = reward/risk of the latest signal (1R/2R/3R). Dashed green/red = prior 20-candle high/low. Dots with ✓/✕ = walk-forward replay trades (TP1 before stop).</div></section>
<aside class="panel execpanel" id="executionPanel" aria-label="Order Execution">
<h2>Order Execution</h2>
<div class="pxbar" aria-live="polite"><span>Chart symbol <b id="orderChartSymbol">—</b></span><span>Market price <b id="orderMarketPrice">—</b></span><button type="button" id="useMarketPrice" title="Copy the live chart price into the limit price field">Use as limit</button></div>
<div class="meta"><span>Execution status <b id="executionStatus">Checking…</b></span><span>Broker <b id="brokerStatus">Checking…</b></span><span>Safeguards <b id="safeguardStatus">Checking…</b></span><span>Kill switch <b id="killSwitchStatus">Checking…</b></span></div>
<details class="execution-note"><summary>Execution safeguards (read before trading)</summary><p class="execution-note">Orders are sent only after you preview and confirm them. ETI Internal Paper and exchange testnets authenticate automatically with short-lived server-side sessions: nothing to type, and nothing stored in this page. Exchange testnet keys are read from Worker secrets; if they are missing or rejected, orders run in ETI Internal Paper and this panel says so. Live mode stays disabled and needs the live switch, live broker keys, the execution token and the separate live activation secret. Protect this dashboard with Cloudflare Access. Never enter withdrawal or transfer credentials here.</p></details>
<div class="execution-grid">
<label>Venue<select id="orderBroker"><option value="eti_paper">ETI Internal Paper (automatic)</option><option value="alpaca">Alpaca paper (exchange testnet)</option><option value="binance">Binance testnet (exchange)</option></select></label>
<label>Symbol<input id="orderSymbol" value="BTCUSDT" maxlength="24" autocomplete="off" list="symbolList"><datalist id="symbolList"></datalist></label>
<label>Order type<select id="orderType"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop-loss (sell, Internal Paper)</option></select></label>
<label>Quantity<input id="orderQuantity" type="number" min="0" step="any" placeholder="Enter quantity"></label>
<label>Amount (<span id="orderQuote">USDT</span>)<input id="orderAmount" type="number" min="0" step="any" inputmode="decimal" placeholder="Enter amount to trade"><small id="orderAmountNote" class="mut" aria-live="polite">Type an amount and the quantity is filled in at the reference price.</small></label>
<label id="limitPriceWrap" style="display:none">Limit price<input id="orderLimitPrice" type="number" min="0" step="any" placeholder="Enter limit price"></label>
<label id="stopPriceWrap" style="display:none">Stop price<input id="orderStopPrice" type="number" min="0" step="any" placeholder="Trigger price"></label>
<label>Time in force<select id="orderTif"><option value="gtc">GTC</option><option value="day">DAY (Alpaca)</option><option value="ioc">IOC (Binance)</option></select></label>
<label>Operator ID<input id="operatorId" value="dashboard-operator" maxlength="80"></label>
${PLAN_HTML}
</div>
<div id="authBanner" class="authbanner" role="status" aria-live="polite">Starting authenticated sessions…</div>
<div id="authEnvs" class="authenvs" aria-label="Execution environments"></div>
<div id="manualAuth" class="execution-grid" style="margin-top:10px;display:none">
<label style="grid-column:span 2">Execution token (not saved; only needed when automatic sessions are off)<input id="executionToken" type="password" autocomplete="off" placeholder="Paste ETI_EXECUTION_TOKEN"></label>
</div>
<div class="execution-actions">
<button id="previewOrder" class="active">Preview order</button>
<button id="buyOrder" class="btn-buy">Buy</button>
<button id="sellOrder" class="btn-sell">Sell</button>
<button id="clearExecutionSecrets" title="Clears anything typed here and restarts the automatic sessions with fresh tokens">Reset sessions</button>
</div>
<div style="margin-top:12px"><strong>Order preview / response</strong><div id="orderOutput" class="execution-output" style="margin-top:7px">No order prepared.</div></div>
</aside>
</div>
<section class="panel" id="calcPanel" style="margin-top:14px">
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Profit &amp; Leverage Calculator</h2><span class="muted" id="calcMeta">Estimates only</span></div>
<p class="execution-note">For USDT-margined contracts with isolated margin. It never places an order. Leverage magnifies losses as well as profits. Liquidation is an estimate that ignores fees, funding and tiered maintenance margins: confirm with the exchange before relying on it.</p>
<div class="calcgrid">
<label>Side<select id="calcSide"><option value="long">Long (buy)</option><option value="short">Short (sell)</option></select></label>
<label>Entry price<input id="calcEntry" type="number" min="0" step="any"></label>
<label>Target price (optional)<input id="calcTarget" type="number" min="0" step="any"></label>
<label>Stop price (optional)<input id="calcStop" type="number" min="0" step="any"></label>
<label>Leverage: <b id="calcLevOut">10x</b><input id="calcLev" type="range" min="1" max="150" value="10" aria-label="Leverage"></label>
<label>Size by<select id="calcSizeBy"><option value="margin">Margin (USDT)</option><option value="quantity">Quantity</option><option value="risk">Risk % of balance</option></select></label>
<label id="calcMarginWrap">Margin (USDT)<input id="calcMargin" type="number" min="0" step="any" value="1000"></label>
<label id="calcQtyWrap" style="display:none">Quantity<input id="calcQty" type="number" min="0" step="any"></label>
<label id="calcBalWrap" style="display:none">Balance (USDT)<input id="calcBalance" type="number" min="0" step="any" value="10000"></label>
<label id="calcRiskWrap" style="display:none">Risk % per trade<input id="calcRisk" type="number" min="0" step="any" value="1"></label>
<label>Taker fee (bps)<input id="calcFee" type="number" min="0" step="any" value="5"></label>
<label>Maintenance margin %<input id="calcMmr" type="number" min="0" step="any" value="0.5"></label>
</div>
<div class="execution-actions" style="margin-top:10px"><button type="button" id="calcLastPx">Use last price as entry</button><button type="button" id="calcRun" class="active">Calculate</button><label style="display:inline-flex;gap:6px;align-items:center;flex-direction:row"><input id="calcShow" type="checkbox" checked> Show levels on chart</label><button type="button" id="calcToTicket">Send size to chart ticket</button></div>
<div id="calcOut" role="status" aria-live="polite"><span class="muted">Enter an entry price and press Calculate.</span></div>
</section>
${PORTFOLIO_HTML}
<div class="lower"><section class="panel"><h2>Live Market Trade Tape</h2><div id="trades" class="scroll"></div></section><section class="panel"><h2>Order Book Depth</h2><div class="meta"><span>Bid <b class="bid" id="bid">—</b></span><span>Ask <b class="ask" id="ask">—</b></span><span>Spread <b id="spread">—</b></span></div><div id="book" class="scroll"></div></section><section class="panel"><h2>Cumulative Market Depth</h2><div class="chart" style="height:260px"><canvas id="depth" role="img" aria-label="Cumulative market depth by price with ETI signal levels"></canvas></div><div class="execution-note" id="depthNote" style="margin-top:6px"></div><small>Aggregated visible bid and ask liquidity by price. Not a full exchange order queue.</small></section></div>


<section class="panel" id="signalPanel" style="margin-top:14px">
<h2>ETI AI Signal Engine</h2>
<div class="meta"><span>Decision <b id="signalAction">ANALYSING…</b></span><span>Score <b id="signalScore">—</b></span><span>Conviction <b id="signalConviction">—</b></span><span>Historical win rate <b id="signalWinRate">Not validated</b></span><span>Provider <b id="signalProvider">—</b></span></div>
<div class="sigcharts">
<div><div class="execution-note">Engine score gauge (thresholds 30 / 55)</div><canvas id="gauge" role="img" aria-label="Engine score gauge"></canvas></div>
<div><div class="execution-note">Score breakdown: points per factor</div><canvas id="components" role="img" aria-label="Score contribution by factor"></canvas></div>
<div><div class="execution-note">Trade ladder in R multiples</div><canvas id="ladder" role="img" aria-label="Entry, stop and target ladder"></canvas></div>
</div>
<div class="execution-note" id="replayStrip" style="margin-bottom:12px"></div>
<div class="lower" style="margin-top:0">
<div><div class="execution-note">Entry / reference</div><strong id="signalEntry">—</strong><div class="execution-note" style="margin-top:8px">Stop loss</div><strong id="signalStop">—</strong></div>
<div><div class="execution-note">Take-profit levels</div><div id="signalTargets" class="execution-output">Awaiting validated candles…</div></div>
</div>
<div class="execution-note" id="signalSummary" style="margin-top:10px">Market-derived indicator confluence, not a guaranteed prediction.</div>
<div class="execution-note" id="signalEvidence" style="margin-top:8px"></div>
<div class="execution-note" id="signalAttribution" style="margin-top:8px"></div>
</section>
<section class="panel" id="readinessPanel" style="margin-top:14px">
<style>.rdgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin-top:10px}.rdcard{border:1px solid var(--line);border-radius:10px;padding:10px;background:#0b1422}.rdchip{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11px;border:1px solid currentColor;white-space:nowrap}.rdhours{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:4px;margin-top:8px}.rdhours span{height:26px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:10px;color:#06101c;font-weight:700}.rdtable td,.rdtable th{text-align:left;vertical-align:top}.rdtable details{margin-top:4px;color:var(--muted)}@media(max-width:850px){.rdhours{grid-template-columns:repeat(6,minmax(0,1fr))}}</style>
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">ETI Market Readiness Engine</h2><span class="muted" id="rdMeta">Loading...</span></div>
<p class="execution-note">Decides whether trading is advisable at all: now, today, tomorrow, in a session or in a particular hour. Standing aside is a valid outcome. Factors that cannot be verified are shown as not evaluated and lower the verdict instead of being assumed safe.</p>
<div class="toolbar">
<select id="rdMarket" aria-label="Market"><option value="crypto">Crypto</option><option value="forex">Forex</option><option value="equities">Equities</option></select>
<input id="rdSymbol" placeholder="Symbol: BTCUSDT, EURUSD, AAPL" maxlength="20" autocomplete="off" style="width:170px" aria-label="Readiness symbol">
<select id="rdScope" aria-label="Window"><option value="now">Next 2 hours</option><option value="today">Today (UTC day)</option><option value="tomorrow">Tomorrow (UTC day)</option><option value="session">A trading session</option><option value="hour">A specific hour (UTC)</option></select>
<select id="rdSession" style="display:none" aria-label="Session"><option value="asian">Asian session</option><option value="london">London session</option><option value="new_york">New York session</option><option value="london_ny_overlap">London/New York overlap</option><option value="sydney">Sydney session</option></select>
<input id="rdHour" type="number" min="0" max="23" value="0" style="display:none;width:90px" aria-label="UTC hour">
<button id="rdRefresh" class="active">Assess readiness</button><button id="rdTextBtn">Text report</button></div>
<div id="rdOut" role="status" aria-live="polite"><span class="muted">Waiting for assessment...</span></div>
<pre id="rdText" class="execution-output" style="display:none"></pre>
<section class="panel" id="intelPanel" style="margin-top:14px">
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Analysis Intelligence</h2><span class="muted" id="intelMeta">Technical, multi-timeframe, fundamental and news engines, weighed by a central intelligence layer</span></div>
<div class="toolbar"><select id="intelStrategy"><option value="intraday">Intraday</option><option value="scalp">Scalp</option><option value="swing">Swing</option><option value="position">Position</option></select><select id="intelDetail" title="Lite skips the heaviest detectors to fit Workers Free CPU limits"><option value="full">Full detail</option><option value="lite">Lite (low CPU)</option></select><button id="intelRun">Run analysis for selected symbol</button></div>
<div id="intelOut" class="execution-note">Not run yet. Analysis is evidence for review, not an instruction to trade; it never places orders.</div>
</section>
<section class="panel" style="margin-top:14px">
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">ETI Execution Audit History</h2><button id="refreshExecutionHistory">Refresh audit history</button></div>
<p class="execution-note">Shows every ETI order recorded in KV, newest first: executed orders with the broker's order ID and status, orders ETI refused (never sent to a broker) with the reason, and broker rejections. This is separate from the public Binance market trade tape above.</p>
<div id="executionHistory" class="history-table"><span class="muted">Enter your execution token, then refresh.</span></div>
</section>
<section class="panel" id="traderPanel" style="margin-top:14px">
<div class="toolbar" style="justify-content:space-between;align-items:center"><h2 style="margin:0">Elite Trader Intelligence</h2><span class="muted" id="traderMeta">Loading…</span></div>
<div class="toolbar"><input id="traderSearch" placeholder="Search traders, tags, principles" style="min-width:220px"><select id="traderSelect" style="min-width:220px"></select></div>
<p class="execution-note">Built from documented public methods only. Every performance, win-rate and net-worth note is labelled verified, reported, estimate or speculation; missing sources are shown as missing. Educational research, not financial advice.</p>
<div id="traderDetail" class="scroll execution-note">Loading profiles…</div>
</section>
<p class="muted">Market panels use public exchange data. Order entry submits broker orders only after authenticated preview and explicit confirmation. Market data may be delayed or interrupted. ETI does not request or use withdrawal, transfer, funding, or wallet-management permissions.</p>
</main>
<script>
const $=id=>document.getElementById(id);let socket=null, candles=[], book={bids:[],asks:[]}, trades=[];
const fmt=n=>Number(n).toLocaleString(undefined,{maximumFractionDigits:6});
function resize(c){const dpr=devicePixelRatio||1, r=c.getBoundingClientRect();c.width=r.width*dpr;c.height=r.height*dpr;const x=c.getContext('2d');x.scale(dpr,dpr);return {x,w:r.width,h:r.height};}
/* ===== ETI signal-engine chart layer: every chart draws the engine's own per-candle output (/api/signals chart payload) ===== */
const BARS=120,PAD_R=116,FUTURE=14,FONT='11px Inter,system-ui,sans-serif';
const C={up:'#21d69a',down:'#ff637d',ema20:'#f0c674',ema50:'#56a8ff',ema200:'#c792ea',grid:'#24334a',muted:'#8fa3bd',text:'#eaf2ff',entry:'#e6edf7',amber:'#f0c674'};
const layers={ema:true,bb:true,levels:true,markers:true,replay:true,ribbon:true,volume:true,trades:true};
let sig=null,sigSeq=0,sigWantProvider=null,sigTimer=null,hoverIdx=-1,chartLines=[],chartScale=null;
function fp(v){v=Number(v);if(!isFinite(v))return '—';const a=Math.abs(v),d=a>=1000?2:a>=100?3:a>=1?4:6;return v.toLocaleString(undefined,{minimumFractionDigits:Math.min(d,2),maximumFractionDigits:d});}
const sg=v=>(v>0?'+':'')+v;
function rgba(hex,a){const n=parseInt(hex.slice(1),16);return 'rgba('+((n>>16)&255)+','+((n>>8)&255)+','+(n&255)+','+a+')';}
function sigValid(){return !!(sig&&sig.chart&&sig.symbol===$('symbol').value&&sig.interval===$('interval').value);}
function alignIdx(){const m=new Map();sig.chart.times.forEach((t,i)=>m.set(t,i));return candles.map(v=>m.has(v[0])?m.get(v[0]):-1);}
function geom(w,n){const plotW=Math.max(40,w-PAD_R),step=plotW/(n+FUTURE);return {plotW,step,x:i=>(i+.5)*step};}
function pts(arr,J,g,py){return J.map((j,i)=>{const v=j<0?null:arr[j];return v==null?null:[g.x(i),py(v)];});}
function stroke(x,p,color,wid,dash){x.beginPath();let pen=false;for(const q of p){if(!q){pen=false;continue;}if(pen)x.lineTo(q[0],q[1]);else x.moveTo(q[0],q[1]);pen=true;}x.strokeStyle=color;x.lineWidth=wid||1;x.setLineDash(dash||[]);x.stroke();x.setLineDash([]);}
function pill(x,px0,y,text,color,textColor){x.font=FONT;const tw=x.measureText(text).width+10;x.fillStyle=color;x.fillRect(px0,y-8,tw,16);x.fillStyle=textColor||'#06101c';x.textBaseline='middle';x.fillText(text,px0+5,y);x.textBaseline='alphabetic';}
function spread(labels,gap,lo,hi){labels.sort((a,b)=>a.y-b.y);for(let i=0;i<labels.length;i++){labels[i].ly=Math.max(lo,i?Math.max(labels[i].y,labels[i-1].ly+gap):labels[i].y);}for(let i=labels.length-1;i>=0;i--){labels[i].ly=Math.min(labels[i].ly,hi-(labels.length-1-i)*gap);}return labels;}
function updateOverlayNote(){const e=$('overlayNote');if(sigValid()&&provider&&sig.provider!==provider){e.style.display='inline-block';e.textContent='Overlays computed on '+sig.provider+' candles; chart candles from '+provider;}else e.style.display='none';}

function drawChart(){
 updateOverlayNote();
 const c=$('chart'),r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);
 if(!candles.length){x.fillStyle=C.muted;x.font=FONT;x.fillText('Waiting for candle data…',12,24);drawPanes();return;}
 const n=candles.length,g=geom(w,n),ok=sigValid(),ch=ok?sig.chart:null,J=ok?alignIdx():null;
 const cIdx=new Map(candles.map((v,i)=>[v[0],i]));
 const volH=layers.volume?Math.round(h*.18):0,top=ok&&layers.ribbon?18:10,bot=h-volH-8;
 let lo=Infinity,hi=-Infinity;
 candles.forEach(v=>{if(v[3]<lo)lo=v[3];if(v[2]>hi)hi=v[2];});
 if(ok&&layers.levels){const L=ch.levels;[L.stopLoss,L.entry].concat(L.targets).forEach(v=>{if(v<lo)lo=v;if(v>hi)hi=v;});}
 if(layers.trades)pfRange(candles[n-1][4]).forEach(v=>{if(v<lo)lo=v;if(v>hi)hi=v;});
 chartLines.forEach(l=>{if(l.price>0&&Math.abs(l.price-candles[n-1][4])<candles[n-1][4]*.35){if(l.price<lo)lo=l.price;if(l.price>hi)hi=l.price;}});
 const pad=(hi-lo)*.05||1;lo-=pad;hi+=pad;
 const py=v=>bot-(v-lo)/(hi-lo)*(bot-top);chartScale={top:top,bot:bot,lo:lo,hi:hi,plotW:g.plotW};
 x.font=FONT;x.lineWidth=1;
 for(let i=0;i<=5;i++){const y=top+i*(bot-top)/5;x.strokeStyle=C.grid;x.beginPath();x.moveTo(0,y);x.lineTo(g.plotW,y);x.stroke();x.fillStyle=C.muted;x.fillText(fp(hi-(hi-lo)*i/5),g.plotW+6,y+4);}
 const bw=Math.max(1,Math.min(14,g.step*.62));
 // engine conviction ribbon: one cell per candle, colour = BUY/SELL lean, opacity = |score|
 if(ok&&layers.ribbon){for(let i=0;i<n;i++){const j=J[i];if(j<0)continue;const s=ch.score[j];x.fillStyle=rgba(ch.direction[j]===1?C.up:C.down,.12+.88*Math.min(1,Math.abs(s)/100));x.fillRect(g.x(i)-g.step/2+.5,3,Math.max(1,g.step-1),8);}x.fillStyle=C.muted;x.font='9px Inter,system-ui,sans-serif';x.fillText('ENGINE LEAN',g.plotW+6,10);x.font=FONT;}
 x.save();x.beginPath();x.rect(0,top-6,g.plotW,bot-top+12);x.clip();
 if(ok&&layers.bb){const u=pts(ch.bbUpper,J,g,py),l=pts(ch.bbLower,J,g,py),m=pts(ch.bbMiddle,J,g,py),idx=[];u.forEach((p,i)=>{if(p&&l[i])idx.push(i);});
  if(idx.length>1){x.beginPath();idx.forEach((i,k)=>{if(k)x.lineTo(u[i][0],u[i][1]);else x.moveTo(u[i][0],u[i][1]);});for(let k=idx.length-1;k>=0;k--)x.lineTo(l[idx[k]][0],l[idx[k]][1]);x.closePath();x.fillStyle='rgba(86,168,255,.07)';x.fill();}
  stroke(x,u,'rgba(86,168,255,.45)',1);stroke(x,l,'rgba(86,168,255,.45)',1);stroke(x,m,'rgba(86,168,255,.25)',1,[3,3]);}
 if(ok&&layers.ema){stroke(x,pts(ch.ema200,J,g,py),C.ema200,1.4);stroke(x,pts(ch.ema50,J,g,py),C.ema50,1.4);stroke(x,pts(ch.ema20,J,g,py),C.ema20,1.4);
  stroke(x,pts(ch.breakoutHigh,J,g,py),'rgba(33,214,154,.55)',1,[4,3]);stroke(x,pts(ch.breakoutLow,J,g,py),'rgba(255,99,125,.55)',1,[4,3]);}
 let x0=g.plotW;if(ok){const k=candles.findIndex(v=>v[0]===ch.levels.asOf);if(k>=0)x0=g.x(k);}
 const labels=[];
 if(ok&&layers.levels){const L=ch.levels,E=py(L.entry),S=py(L.stopLoss),T=L.targets.map(py);
  x.fillStyle='rgba(33,214,154,.09)';x.fillRect(x0,Math.min(E,T[2]),g.plotW-x0,Math.abs(E-T[2]));
  x.fillStyle='rgba(255,99,125,.11)';x.fillRect(x0,Math.min(E,S),g.plotW-x0,Math.abs(E-S));
  const hl=(y,col,dash)=>{x.lineWidth=1.2;x.strokeStyle=col;x.setLineDash(dash);x.globalAlpha=.3;x.beginPath();x.moveTo(0,y);x.lineTo(x0,y);x.stroke();x.globalAlpha=1;x.beginPath();x.moveTo(x0,y);x.lineTo(g.plotW,y);x.stroke();x.setLineDash([]);};
  hl(E,C.entry,[5,4]);hl(S,C.down,[]);T.forEach(y=>hl(y,C.up,[]));
  labels.push({y:E,t:'ENTRY '+fp(L.entry),c:C.entry},{y:S,t:'STOP '+fp(L.stopLoss),c:C.down});L.targets.forEach((p,i)=>labels.push({y:T[i],t:'TP'+(i+1)+' '+fp(p),c:C.up}));}
 candles.forEach((v,i)=>{const up=v[4]>=v[1],col=up?C.up:C.down,cx=g.x(i);x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.beginPath();x.moveTo(cx,py(v[2]));x.lineTo(cx,py(v[3]));x.stroke();const t=py(Math.max(v[1],v[4])),b=py(Math.min(v[1],v[4]));x.fillRect(cx-bw/2,t,bw,Math.max(1,b-t));});
 if(ok&&layers.replay)ch.replay.forEach(t=>{const i=cIdx.get(t.time);if(i===undefined)return;const ex=t.exitTime===null?undefined:cIdx.get(t.exitTime),col=t.outcome==='win'?C.up:t.outcome==='loss'?C.down:C.muted;
  x.strokeStyle=col;x.fillStyle=col;x.lineWidth=1;x.globalAlpha=.85;x.beginPath();x.arc(g.x(i),py(t.entry),3,0,6.2832);x.fill();
  if(ex!==undefined){const yy=py(t.outcome==='win'?t.tp1:t.stop);x.setLineDash([2,2]);x.beginPath();x.moveTo(g.x(i),py(t.entry));x.lineTo(g.x(ex),yy);x.stroke();x.setLineDash([]);x.font='bold 12px Inter,system-ui,sans-serif';x.textAlign='center';x.fillText(t.outcome==='win'?'✓':'✕',g.x(ex),yy+((t.outcome==='win')===(t.label==='BUY')?-4:12));x.textAlign='left';x.font=FONT;}
  x.globalAlpha=1;});
 if(ok&&layers.markers)ch.markers.forEach(m=>{const i=cIdx.get(m.time);if(i===undefined)return;const v=candles[i],buy=m.label==='BUY',s=m.kind==='high'?7:5,cx=g.x(i),col=buy?C.up:C.down,y=buy?py(v[3])+6:py(v[2])-6;
  x.beginPath();if(buy){x.moveTo(cx,y);x.lineTo(cx-s,y+s*1.6);x.lineTo(cx+s,y+s*1.6);}else{x.moveTo(cx,y);x.lineTo(cx-s,y-s*1.6);x.lineTo(cx+s,y-s*1.6);}x.closePath();
  if(m.kind==='high'){x.fillStyle=col;x.fill();x.font='10px Inter,system-ui,sans-serif';x.textAlign='center';x.fillText(sg(m.score),cx,buy?y+s*1.6+11:y-s*1.6-4);x.textAlign='left';x.font=FONT;}else{x.strokeStyle=col;x.lineWidth=1.4;x.stroke();}});
 pfDrawTrades(x,g,py,labels);drawChartLines(x,g,py,labels);
 x.restore();
 const lp=candles[n-1][4],ly=py(lp),lup=candles[n-1][4]>=candles[n-1][1];
 x.strokeStyle=lup?C.up:C.down;x.setLineDash([2,3]);x.lineWidth=1;x.beginPath();x.moveTo(0,ly);x.lineTo(g.plotW,ly);x.stroke();x.setLineDash([]);
 spread(labels,16,top,bot).forEach(l=>pill(x,g.plotW+4,l.ly,l.t,l.c));
 if(!(ok&&layers.levels&&Math.abs(ly-py(ch.levels.entry))<10))pill(x,g.plotW+4,ly,fp(lp),lup?C.up:C.down);
 if(volH){const vTop=bot+12,vb=h-3;let vm=0;candles.forEach(v=>{if(v[5]>vm)vm=v[5];});vm=vm||1;const vy=q=>vb-q/vm*(vb-vTop);
  candles.forEach((v,i)=>{const j=ok?J[i]:-1,vr=j>=0?ch.volumeRatio[j]:null,hot=vr!==null&&vr>=1.25;x.globalAlpha=hot?1:(ok?.42:.7);x.fillStyle=v[4]>=v[1]?C.up:C.down;x.fillRect(g.x(i)-bw/2,vy(v[5]),bw,Math.max(1,vb-vy(v[5])));x.globalAlpha=1;});
  if(ok){x.save();x.beginPath();x.rect(0,vTop-2,g.plotW,vb-vTop+4);x.clip();stroke(x,candles.map((v,i)=>{const j=J[i],q=j<0?null:ch.volumeRatio[j];return q>0?[g.x(i),vy(v[5]/q*1.25)]:null;}),C.amber,1,[3,3]);x.restore();}
  x.fillStyle=C.muted;x.fillText(ok?'Volume · bright = at least 1.25x avg (engine rule) · dotted = 1.25x threshold':'Volume',6,vTop+2);}
 if(ok){const s=sig;pill(x,8,top+14,s.label+' '+sg(s.score)+' · '+s.conviction.toUpperCase()+(s.tradeable?' · SETUP':' · LEAN'),s.label==='BUY'?C.up:C.down);}
 if(hoverIdx>=0&&hoverIdx<n){x.strokeStyle='rgba(234,242,255,.35)';x.lineWidth=1;x.beginPath();x.moveTo(g.x(hoverIdx),0);x.lineTo(g.x(hoverIdx),h);x.stroke();}
 drawPanes();
}

function paneCtx(id){const c=$(id),r=resize(c);r.x.clearRect(0,0,r.w,r.h);r.n=candles.length;r.g=geom(r.w,r.n);r.ok=r.n>0&&sigValid();r.J=r.ok?alignIdx():null;
 if(!r.ok){r.x.fillStyle=C.muted;r.x.font=FONT;r.x.fillText(r.n?'Signal engine series loading…':'Waiting for data…',8,16);}return r;}
function paneTitle(r,t){r.x.fillStyle=C.muted;r.x.font=FONT;r.x.fillText(t,6,13);}
function paneCross(r){if(hoverIdx>=0&&hoverIdx<r.n){r.x.strokeStyle='rgba(234,242,255,.35)';r.x.lineWidth=1;r.x.beginPath();r.x.moveTo(r.g.x(hoverIdx),0);r.x.lineTo(r.g.x(hoverIdx),r.h);r.x.stroke();}}
function axisLabel(r,y,t,col){r.x.fillStyle=col||C.muted;r.x.font='10px Inter,system-ui,sans-serif';r.x.fillText(t,r.g.plotW+6,y+3);}
function lastAligned(r){for(let i=r.n-1;i>=0;i--)if(r.J[i]>=0)return i;return -1;}
function hline(r,y,col,dash){r.x.strokeStyle=col;r.x.lineWidth=1;r.x.setLineDash(dash||[]);r.x.beginPath();r.x.moveTo(0,y);r.x.lineTo(r.g.plotW,y);r.x.stroke();r.x.setLineDash([]);}
function drawRsi(){const r=paneCtx('paneRsi');if(!r.ok)return;const x=r.x,ch=sig.chart,top=20,bot=r.h-6,py=v=>bot-(v/100)*(bot-top);
 x.fillStyle='rgba(33,214,154,.09)';x.fillRect(0,py(70),r.g.plotW,py(52)-py(70));x.fillStyle='rgba(255,99,125,.09)';x.fillRect(0,py(48),r.g.plotW,py(30)-py(48));
 [70,50,30].forEach(v=>{hline(r,py(v),v===50?'#35465f':C.muted,[3,4]);axisLabel(r,py(v),String(v));});
 const p=pts(ch.rsi,r.J,r.g,py);
 for(let i=1;i<p.length;i++){if(!p[i]||!p[i-1])continue;const v=ch.rsi[r.J[i]];x.strokeStyle=(v>=52&&v<=70)?C.up:(v<=48&&v>=30)?C.down:'#9fb4d0';x.lineWidth=1.6;x.beginPath();x.moveTo(p[i-1][0],p[i-1][1]);x.lineTo(p[i][0],p[i][1]);x.stroke();}
 paneTitle(r,'RSI 14 · shaded = engine momentum zones: 52-70 bullish (+10), 30-48 bearish (-10)');
 const k=lastAligned(r);if(k>=0){const v=ch.rsi[r.J[k]];pill(x,r.g.plotW+4,py(v),v.toFixed(1),'#9fb4d0');}
 paneCross(r);}
function drawMacd(){const r=paneCtx('paneMacd');if(!r.ok)return;const x=r.x,ch=sig.chart,top=20,bot=r.h-6,mid=(top+bot)/2;let m=0;
 r.J.forEach(j=>{if(j>=0)m=Math.max(m,Math.abs(ch.macd[j]),Math.abs(ch.macdSignal[j]),Math.abs(ch.macdHistogram[j]));});m=m||1;
 const py=v=>mid-v/m*(bot-top)/2*.95,bw=Math.max(1,Math.min(14,r.g.step*.62));hline(r,mid,'#35465f');
 r.J.forEach((j,i)=>{if(j<0)return;const v=ch.macdHistogram[j];x.fillStyle=v>0?rgba(C.up,.75):rgba(C.down,.75);x.fillRect(r.g.x(i)-bw/2,Math.min(py(v),mid),bw,Math.max(1,Math.abs(py(v)-mid)));});
 stroke(x,pts(ch.macd,r.J,r.g,py),C.ema50,1.4);stroke(x,pts(ch.macdSignal,r.J,r.g,py),C.amber,1.4);
 paneTitle(r,'MACD 12/26/9 · histogram above zero = +14 momentum confirmation, otherwise -14');
 const k=lastAligned(r);if(k>=0){const v=ch.macdHistogram[r.J[k]];pill(x,r.g.plotW+4,py(v),(v>0?'+':'')+Number(v.toPrecision(3)),v>0?C.up:C.down);}
 paneCross(r);}
function drawAdx(){const r=paneCtx('paneAdx');if(!r.ok)return;const x=r.x,ch=sig.chart,top=20,bot=r.h-6;let m=40;r.J.forEach(j=>{if(j>=0&&ch.adx[j]>m)m=ch.adx[j];});m*=1.08;
 const py=v=>bot-(v/m)*(bot-top);x.fillStyle='rgba(86,168,255,.07)';x.fillRect(0,top,r.g.plotW,py(20)-top);hline(r,py(20),C.muted,[3,4]);axisLabel(r,py(20),'20');hline(r,py(25),C.muted,[3,4]);axisLabel(r,py(25),'25');
 const RC={trend:'#56a8ff',range:'#f0c674',transition:'#6f829c'};r.J.forEach((j,i)=>{if(j<0)return;x.fillStyle=rgba(RC[ch.regime[j]]||'#6f829c',.85);x.fillRect(r.g.x(i)-r.g.step/2+.5,r.h-5,Math.max(1,r.g.step-1),4);});
 const p=pts(ch.adx,r.J,r.g,py);
 for(let i=1;i<p.length;i++){if(!p[i]||!p[i-1])continue;x.strokeStyle=ch.adx[r.J[i]]>=20?C.ema50:'#6f829c';x.lineWidth=1.6;x.beginPath();x.moveTo(p[i-1][0],p[i-1][1]);x.lineTo(p[i][0],p[i][1]);x.stroke();}
 paneTitle(r,'ADX 14 · 20+ = trend present (+/-6) · strip = regime: blue trend 25+, amber range under 20, grey transition (breakouts suppressed in range, reversals in trend)');
 const k=lastAligned(r);if(k>=0){const v=ch.adx[r.J[k]];pill(x,r.g.plotW+4,py(v),v.toFixed(1),v>=20?C.ema50:'#6f829c');}
 paneCross(r);}
function drawScorePane(){const r=paneCtx('paneScore');if(!r.ok)return;const x=r.x,ch=sig.chart,top=20,bot=r.h-6,mid=(top+bot)/2,half=(bot-top)/2,py=v=>mid-v/100*half,bw=Math.max(1,Math.min(14,r.g.step*.62));
 x.fillStyle='rgba(33,214,154,.06)';x.fillRect(0,py(100),r.g.plotW,py(55)-py(100));x.fillStyle='rgba(255,99,125,.06)';x.fillRect(0,py(-55),r.g.plotW,py(-100)-py(-55));
 hline(r,mid,'#35465f');[55,30,-30,-55].forEach(v=>{hline(r,py(v),Math.abs(v)===55?C.muted:'#3b4c66',[3,4]);axisLabel(r,py(v),sg(v));});
 r.J.forEach((j,i)=>{if(j<0)return;const s=ch.score[j],cv=ch.conviction[j];x.fillStyle=rgba(ch.direction[j]===1?C.up:C.down,cv==='high'?1:cv==='medium'?.62:.32);x.fillRect(r.g.x(i)-bw/2,Math.min(py(s),mid),bw,Math.max(1,Math.abs(py(s)-mid)));if(ch.downgraded[j]){x.fillStyle=C.amber;x.beginPath();x.arc(r.g.x(i),py(s)+(s>=0?-4:4),2.4,0,6.2832);x.fill();}});
 paneTitle(r,'ETI engine score · bar opacity = conviction (low under 30, medium 30-54, high 55 and above = tradeable setup) · amber dot = lowered by method disagreement');
 const k=lastAligned(r);if(k>=0){const s=ch.score[r.J[k]];pill(x,r.g.plotW+4,py(s),sg(s),ch.direction[r.J[k]]===1?C.up:C.down);}
 paneCross(r);}
function drawPanes(){drawRsi();drawMacd();drawAdx();drawScorePane();}

function edgeTag(x,t,col,xx,yy,right){x.font=FONT;const tw=x.measureText(t).width+8,x0=right?xx-tw:xx;x.fillStyle='rgba(8,13,22,.85)';x.fillRect(x0,yy-10,tw,15);x.fillStyle=col;x.textAlign='left';x.fillText(t,x0+4,yy+1);}
function drawDepth(){
 const c=$('depth'),r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);x.font=FONT;
 const bids=[...book.bids].sort((a,b)=>b[0]-a[0]),asks=[...book.asks].sort((a,b)=>a[0]-b[0]),note=$('depthNote');
 if(!bids.length||!asks.length){x.fillStyle=C.muted;x.fillText('Waiting for order book…',12,24);note.textContent='';return;}
 const lo=bids[bids.length-1][0],hi=asks[asks.length-1][0],bc=[],ac=[];let t=0;
 bids.forEach(v=>{t+=Number(v[1]);bc.push([v[0],t]);});const bt=t;t=0;asks.forEach(v=>{t+=Number(v[1]);ac.push([v[0],t]);});const at=t;
 const maxC=Math.max(bt,at)||1,padL=8,padR=8,padT=22,padB=22,px=p=>padL+(p-lo)/((hi-lo)||1)*(w-padL-padR),py=q=>h-padB-q/maxC*(h-padT-padB);
 const area=(levels,col)=>{x.beginPath();x.moveTo(px(levels[0][0]),py(0));let prev=0;levels.forEach(l=>{x.lineTo(px(l[0]),py(prev));x.lineTo(px(l[0]),py(l[1]));prev=l[1];});x.lineTo(px(levels[levels.length-1][0]),py(0));x.closePath();x.fillStyle=rgba(col,.16);x.fill();x.strokeStyle=col;x.lineWidth=1.6;x.stroke();};
 area(bc,C.up);area(ac,C.down);
 const mid=(bids[0][0]+asks[0][0])/2;x.strokeStyle='rgba(234,242,255,.45)';x.setLineDash([3,3]);x.lineWidth=1;x.beginPath();x.moveTo(px(mid),padT-6);x.lineTo(px(mid),h-padB);x.stroke();x.setLineDash([]);
 x.fillStyle=C.muted;x.textAlign='center';x.fillText('mid '+fp(mid),px(mid),h-6);x.textAlign='left';x.fillText(fp(lo),padL,h-6);x.textAlign='right';x.fillText(fp(hi),w-padR,h-6);x.textAlign='left';
 let txt='Visible book: bids '+fmt(bt)+' vs asks '+fmt(at)+' ('+(bt/at).toFixed(2)+'x). ';
 if(sigValid()){const L=sig.chart.levels,defs=[['ENTRY',L.entry,C.entry],['STOP',L.stopLoss,C.down]].concat(L.targets.map((p,i)=>['TP'+(i+1),p,C.up]));let lowSide=0,highSide=0;
  defs.forEach(d=>{const p=d[1],pct=(p-mid)/mid*100,inside=p>=lo&&p<=hi;
   if(inside){x.strokeStyle=d[2];x.lineWidth=1.4;x.setLineDash([5,3]);x.beginPath();x.moveTo(px(p),padT-6);x.lineTo(px(p),h-padB);x.stroke();x.setLineDash([]);x.fillStyle=d[2];x.textAlign='center';x.fillText(d[0],px(p),padT-9);x.textAlign='left';}
   else if(p<lo){edgeTag(x,'◀ '+d[0]+' '+(pct>0?'+':'')+pct.toFixed(2)+'%',d[2],padL,padT+10+lowSide*16,false);lowSide++;}
   else{edgeTag(x,d[0]+' '+(pct>0?'+':'')+pct.toFixed(2)+'% ▶',d[2],w-padR,padT+10+highSide*16,true);highSide++;}});
  const ratio=bt/at,lean=ratio>1.1?'BUY':ratio<.9?'SELL':'balanced';
  txt+='Book leans '+lean+'; engine says '+sig.label+(lean==='balanced'?' (book balanced).':lean===sig.label?' (aligned).':' (conflict: liquidity opposes the signal).')+' Levels outside the visible book are shown as edge arrows with % distance from mid.';}
 else txt+='Signal levels appear here once the engine responds.';
 note.textContent=txt;
}

function drawGauge(){const c=$('gauge'),r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);
 if(!sig){x.fillStyle=C.muted;x.font=FONT;x.fillText('Awaiting engine…',12,24);return;}
 const cx=w/2,cy=h-62,rad=Math.max(30,Math.min(w/2-30,h-90)),lw=16,ang=s=>Math.PI+(s+100)/200*Math.PI;
 const seg=(a,b,col,wid)=>{x.beginPath();x.arc(cx,cy,rad,ang(a),ang(b),false);x.strokeStyle=col;x.lineWidth=wid||lw;x.stroke();};
 seg(-100,-55,C.down);seg(-55,-30,rgba(C.down,.45));seg(-30,30,'#33445d');seg(30,55,rgba(C.up,.45));seg(55,100,C.up);
 const pos=sig.components.filter(k=>k.id!=='breakdown'&&k.id!=='bearStack').reduce((a,k)=>a+k.max,0),neg=Math.min(100,sig.components.reduce((a,k)=>a+k.max,0));
 if(pos<100)seg(pos,100,'rgba(8,13,22,.72)',lw+2);
 x.font='10px Inter,system-ui,sans-serif';x.fillStyle=C.muted;x.textAlign='center';
 [[-55,'-55'],[55,'+55'],[0,'0']].forEach(a=>{const an=ang(a[0]),rr=rad+lw/2+9;x.fillText(a[1],cx+Math.cos(an)*rr,cy+Math.sin(an)*rr+3);});
 const s=sig.score,col=s>=0?C.up:C.down,an=ang(s);x.strokeStyle=C.text;x.lineWidth=3;x.lineCap='round';x.beginPath();x.moveTo(cx,cy);x.lineTo(cx+Math.cos(an)*(rad-lw/2-2),cy+Math.sin(an)*(rad-lw/2-2));x.stroke();x.lineCap='butt';
 x.fillStyle=C.text;x.beginPath();x.arc(cx,cy,5,0,6.2832);x.fill();
 x.fillStyle=col;x.font='bold 24px Inter,system-ui,sans-serif';x.fillText(sg(s),cx,cy+28);
 x.font=FONT;x.fillStyle=C.muted;x.fillText(sig.label+' · '+sig.conviction.toUpperCase()+(sig.tradeable?' · tradeable setup':' · lean only'),cx,cy+44);
 x.fillText('reachable range: BUY up to +'+pos+', SELL down to -'+neg,cx,h-4);x.textAlign='left';}
function drawComponents(){const c=$('components'),r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);
 if(!sig){x.fillStyle=C.muted;x.font=FONT;x.fillText('Awaiting engine…',12,24);return;}
 const rows=sig.components,labelW=Math.min(150,w*.42),barW=Math.max(20,w-labelW-48),zero=labelW+barW/2,mx=Math.max.apply(null,rows.map(k=>k.max)),sc=(barW/2)/mx,rowH=Math.floor((h-26)/rows.length);
 x.font=FONT;x.strokeStyle='#35465f';x.lineWidth=1;x.beginPath();x.moveTo(zero,2);x.lineTo(zero,rowH*rows.length+2);x.stroke();
 rows.forEach((k,i)=>{const y=2+i*rowH,my=y+rowH/2;x.fillStyle='rgba(255,255,255,.04)';x.fillRect(zero-k.max*sc,y+3,k.max*2*sc,rowH-6);
  x.fillStyle=k.points>0?C.up:k.points<0?C.down:'#52627b';const bwid=Math.abs(k.points)*sc;x.fillRect(Math.min(zero,zero+k.points*sc),y+5,Math.max(2,bwid),rowH-10);
  x.fillStyle=C.muted;x.textAlign='left';x.fillText(k.label,4,my+4);x.fillStyle=k.points>0?C.up:k.points<0?C.down:C.muted;x.textAlign='right';x.fillText(sg(k.points),w-4,my+4);});
 const sum=rows.reduce((a,k)=>a+k.points,0);x.fillStyle=C.muted;x.textAlign='left';x.fillText('Sum '+sg(sum)+(sum!==sig.score?' → clamped to '+sg(sig.score):' = engine score')+' · grey = factor limit',4,h-6);}
function drawLadder(){const c=$('ladder'),r=resize(c),x=r.x,w=r.w,h=r.h;x.clearRect(0,0,w,h);
 if(!sigValid()){x.fillStyle=C.muted;x.font=FONT;x.fillText(sig?'Matching candles…':'Awaiting engine…',12,24);return;}
 const L=sig.chart.levels,R=Math.abs(L.entry-L.stopLoss),now=candles.length?candles[candles.length-1][4]:L.entry;
 const levels=[{k:'TP3',p:L.targets[2],c:C.up,r:'+3R'},{k:'TP2',p:L.targets[1],c:C.up,r:'+2R'},{k:'TP1',p:L.targets[0],c:C.up,r:'+1R'},{k:'ENTRY',p:L.entry,c:C.entry,r:'0'},{k:'STOP',p:L.stopLoss,c:C.down,r:'-1R'}];
 const all=levels.map(l=>l.p).concat([now]);let lo=Math.min.apply(null,all),hi=Math.max.apply(null,all);const pad=(hi-lo)*.08||1;lo-=pad;hi+=pad;
 const top=12,bot=h-28,py=p=>bot-(p-lo)/(hi-lo)*(bot-top),x0=62,x1=w-96;
 x.fillStyle='rgba(33,214,154,.09)';x.fillRect(x0,Math.min(py(L.entry),py(L.targets[2])),x1-x0,Math.abs(py(L.entry)-py(L.targets[2])));
 x.fillStyle='rgba(255,99,125,.12)';x.fillRect(x0,Math.min(py(L.entry),py(L.stopLoss)),x1-x0,Math.abs(py(L.entry)-py(L.stopLoss)));
 x.font=FONT;levels.forEach(l=>{const y=py(l.p);x.strokeStyle=l.c;x.lineWidth=l.k==='ENTRY'?1.2:1.6;x.setLineDash(l.k==='ENTRY'?[5,4]:[]);x.beginPath();x.moveTo(x0,y);x.lineTo(x1,y);x.stroke();x.setLineDash([]);
  x.fillStyle=l.c;x.textAlign='left';x.fillText(l.k+' '+l.r,4,y+4);const pct=(l.p-L.entry)/L.entry*100;x.fillText(fp(l.p),x1+6,y-1);x.fillStyle=C.muted;x.fillText((pct>0?'+':'')+pct.toFixed(2)+'%',x1+6,y+11);});
 const ny=py(now);x.fillStyle=C.amber;x.beginPath();x.moveTo(x0-2,ny);x.lineTo(x0-10,ny-5);x.lineTo(x0-10,ny+5);x.closePath();x.fill();
 x.fillStyle=C.amber;x.fillText('▶ current price',4,h-20);x.fillStyle=C.muted;x.fillText('1R = '+fp(R)+' ('+(R/L.entry*100).toFixed(2)+'%) = max(1.5 x ATR, 0.2%)',4,h-6);}
function renderReplayStrip(){const e=$('replayStrip');if(!sigValid()){e.textContent='';return;}const rp=sig.chart.replay;
 if(!rp.length){e.textContent='No walk-forward replay trades fall inside the visible window.';return;}
 e.innerHTML='<span class="muted">Walk-forward replay in view ('+rp.filter(t=>t.outcome==='win').length+' win · '+rp.filter(t=>t.outcome==='loss').length+' loss · '+rp.filter(t=>t.outcome==='unresolved').length+' unresolved; outlined = high conviction): </span>'+rp.map(t=>'<span class="dot '+t.outcome+(t.conviction==='high'?' hc':'')+'" title="'+esc(t.label+' '+sg(t.score)+' · '+t.outcome+' · '+new Date(t.time).toLocaleString())+'"></span>').join('');}
function renderSignalCharts(){drawGauge();drawComponents();drawLadder();drawDepth();renderReplayStrip();}

/* hover crosshair + tooltip shared by the price chart and all panes */
function hoverFrom(e){const r=$('chart').getBoundingClientRect(),n=candles.length;if(!n)return -1;const i=Math.floor((e.clientX-r.left)/((r.width-PAD_R)/(n+FUTURE)));return i>=0&&i<n?i:-1;}
function showTip(e,i){const t=$('tip');if(!e||i<0){t.style.display='none';return;}
 const v=candles[i],ok=sigValid(),j=ok?alignIdx()[i]:-1,ch=j>=0?sig.chart:null;
 let html='<b>'+esc(new Date(v[0]).toLocaleString())+'</b><br>O '+fp(v[1])+' · H '+fp(v[2])+' · L '+fp(v[3])+' · C '+fp(v[4])+'<br>Volume '+fmt(v[5]);
 if(ch){const lab=ch.direction[j]===1?'BUY':'SELL',col=ch.direction[j]===1?C.up:C.down;
  html+='<br>Engine <b style="color:'+col+'">'+lab+' '+sg(ch.score[j])+'</b> · '+ch.conviction[j].toUpperCase()+'<br>EMA20 '+fp(ch.ema20[j])+' · EMA50 '+fp(ch.ema50[j])+' · EMA200 '+fp(ch.ema200[j])+'<br>BB '+fp(ch.bbLower[j])+' – '+fp(ch.bbUpper[j])+' · 20-bar range '+fp(ch.breakoutLow[j])+' – '+fp(ch.breakoutHigh[j])+'<br>RSI '+Number(ch.rsi[j]).toFixed(1)+' · MACD hist '+Number(ch.macdHistogram[j].toPrecision(3))+' · ADX '+Number(ch.adx[j]).toFixed(1)+' · Rel vol '+Number(ch.volumeRatio[j]).toFixed(2)+'x<br>Regime '+ch.regime[j]+' · methods '+ch.supporting[j]+' for / '+ch.opposing[j]+' against'+(ch.downgraded[j]?' · conviction lowered':'');}
 else if(ok)html+='<br><span class="muted">No engine data for this candle (newer than the last signal).</span>';
 t.innerHTML=html;t.style.display='block';
 const s=$('stack').getBoundingClientRect(),tw=t.offsetWidth,th=t.offsetHeight;
 t.style.left=Math.max(4,Math.min(s.width-tw-4,e.clientX-s.left+14))+'px';t.style.top=Math.max(4,Math.min(s.height-th-4,e.clientY-s.top+12))+'px';}
function wireChartInteractions(){const st=$('stack');
 st.addEventListener('pointermove',e=>{const i=hoverFrom(e);if(i!==hoverIdx){hoverIdx=i;drawChart();}showTip(e,i);});
 st.addEventListener('pointerleave',()=>{hoverIdx=-1;drawChart();showTip(null,-1);});
 document.querySelectorAll('#legend button').forEach(b=>{b.onclick=()=>{layers[b.dataset.layer]=!layers[b.dataset.layer];b.classList.toggle('on',layers[b.dataset.layer]);b.setAttribute('aria-pressed',String(layers[b.dataset.layer]));drawChart();};});}
function scheduleSignal(){clearTimeout(sigTimer);sigTimer=setTimeout(loadSignal,1500);}
function syncSignalProvider(){if(provider&&sig&&sig.provider!==provider&&sigWantProvider!==provider){sigWantProvider=provider;loadSignal();}}
function renderBook(){const bids=book.bids.slice(0,15),asks=book.asks.slice(0,15);if(bids.length)$('bid').textContent=fmt(bids[0][0]);if(asks.length)$('ask').textContent=fmt(asks[0][0]);if(bids.length&&asks.length)$('spread').textContent=fmt(asks[0][0]-bids[0][0]);let rows='<table><tr><th>Side</th><th>Price</th><th>Quantity</th></tr>';for(const a of [...asks].reverse())rows+='<tr><td class="ask">ASK</td><td>'+fmt(a[0])+'</td><td>'+fmt(a[1])+'</td></tr>';for(const b of bids)rows+='<tr><td class="bid">BID</td><td>'+fmt(b[0])+'</td><td>'+fmt(b[1])+'</td></tr>';rows+='</table>';$('book').innerHTML=rows;drawDepth();}
function renderTrades(){$('trades').innerHTML='<table><tr><th>Time</th><th>Side</th><th>Price</th><th>Quantity</th></tr>'+trades.slice(0,50).map(t=>'<tr><td>'+new Date(t.T).toLocaleTimeString()+'</td><td class="'+(t.m?'sell':'buy')+'">'+(t.m?'SELL':'BUY')+'</td><td>'+fmt(t.p)+'</td><td>'+fmt(t.q)+'</td></tr>').join('')+'</table>';}
let provider=null,failCount=0,loadTimer=null,wsRetry=0,wsTimer=null,reqSeq=0,lastGoodAt=null,lastGoodKey='';
function setConn(t,c){$('connection').textContent=t;$('connection').style.color=c;}
function setStale(msg){const e=$('stale');e.style.display=msg?'inline-block':'none';e.textContent=msg||'';}
function symMkt(){const e=$('symMarket');if(!e)return 'spot';if(e.value!=='metals')return e.value;const s=$('symbol').value,sp=SYM.all.filter(r=>r[0]===s&&r[4]==='metals');return sp.some(r=>r[3]==='spot')?'spot':sp.length?'futures':'spot';}
function mkt(){return symMkt()==='futures'?'&market=futures':'';}
async function getJson(url){const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(10000)}),txt=await r.text();let j=null;try{j=JSON.parse(txt);}catch(e){}if(!r.ok){let why=j&&j.detail?j.detail:txt.slice(0,160);if(j&&j.attempts)why+=' ['+j.attempts.map(a=>a.provider+':'+(a.errorClass||'ok')).join(', ')+']';throw Error(url.split('?')[0].replace('/api/market/','')+' HTTP '+r.status+' — '+why);}if(j===null)throw Error('Invalid JSON from '+url.split('?')[0]);return {data:j,provider:r.headers.get('x-eti-provider'),failover:r.headers.get('x-eti-failover')==='true'};}
function schedule(ms){clearTimeout(loadTimer);loadTimer=setTimeout(load,ms);}
async function load(){
 const seq=++reqSeq,s=$('symbol').value,i=$('interval').value,key=s+'|'+i+'|'+mkt(),q='symbol='+encodeURIComponent(s)+mkt();
 try{
  const k=await getJson('/api/market/klines?'+q+'&interval='+encodeURIComponent(i)+'&limit='+BARS);
  if(seq!==reqSeq)return;
  const rows=k.data;if(!Array.isArray(rows)||!rows.length)throw Error('klines returned no candles');
  candles=rows.map(v=>v.map(Number));provider=k.provider;lastGoodAt=Date.now();lastGoodKey=key;syncSignalProvider();
  const pq='&provider='+encodeURIComponent(provider||'');
  const [d,t,tk]=await Promise.allSettled([getJson('/api/market/depth?'+q+'&limit=20'+pq),getJson('/api/market/trades?'+q+'&limit=50'+pq),getJson('/api/market/ticker?'+q+pq)]);
  if(seq!==reqSeq)return;
  const problems=[];
  if(d.status==='fulfilled'){book={bids:d.value.data.bids,asks:d.value.data.asks};}else problems.push('depth: '+d.reason.message);
  if(t.status==='fulfilled'){trades=t.value.data.map(v=>({T:Number(v.time),m:!!v.isBuyerMaker,p:String(v.price),q:String(v.qty)}));}else problems.push('trades: '+t.reason.message);
  if(tk.status==='fulfilled'){const x=tk.value.data;$('volume').textContent=fmt(x.volume);const c=Number(x.priceChangePercent);$('change').textContent=(c>=0?'+':'')+c.toFixed(2)+'%';$('change').style.color=c>=0?'#21d69a':'#ff637d';}else{$('volume').textContent=fmt(candles.at(-1)[5])+' (last candle)';$('change').textContent='—';problems.push('ticker: '+tk.reason.message);}
  drawChart();renderBook();renderTrades();
  $('last').textContent=fmt(candles.at(-1)[4]);$('provider').textContent=provider+(k.failover?' (failover)':'');
  failCount=0;setStale(problems.length?'Partial data — '+problems[0].slice(0,140):'');
  $('stamp').textContent='Updated '+new Date().toLocaleTimeString()+' via '+provider;
  setConn(provider==='binance'&&socket&&socket.readyState===1?'Live stream + REST ('+provider+')':'REST feed connected ('+provider+')',k.failover?'#f59e0b':'#21d69a');
  if(provider==='binance'){if(!socket||socket.readyState>1)connectWs();}else if(socket){socket.onclose=null;socket.close();socket=null;}
  schedule(provider==='binance'?15000:5000);
 }catch(e){
  if(seq!==reqSeq)return;
  failCount++;const wait=Math.min(60000,2000*Math.pow(2,failCount-1));
  const have=candles.length&&lastGoodKey===key;
  if(have)setStale('STALE — showing last valid data from '+new Date(lastGoodAt).toLocaleTimeString()+' · '+e.message.slice(0,160));
  else{candles=[];drawChart();setStale('');}
  setConn('Market data unavailable · retry in '+Math.round(wait/1000)+'s','#ff637d');
  $('stamp').textContent=e.message;schedule(wait);
 }
}
function connectWs(){
 if(provider!=='binance')return;
 clearTimeout(wsTimer);if(socket){socket.onclose=null;socket.close();}
 const s=$('symbol').value.toLowerCase(),sock=new WebSocket('wss://data-stream.binance.vision/stream?streams='+s+'@trade/'+s+'@depth20@100ms/'+s+'@kline_'+$('interval').value);socket=sock;
 sock.onopen=()=>{wsRetry=0;setConn('Live WebSocket + REST (binance)','#21d69a');};
 sock.onmessage=e=>{const msg=JSON.parse(e.data),d=msg.data;if(msg.stream.includes('@trade')){trades.unshift({T:d.T,m:d.m,p:d.p,q:d.q});trades=trades.slice(0,100);renderTrades();$('last').textContent=fmt(d.p);}else if(msg.stream.includes('@depth')){book={bids:d.bids.map(v=>v.map(Number)),asks:d.asks.map(v=>v.map(Number))};renderBook();}else if(msg.stream.includes('@kline')){const k=d.k,row=[k.t,k.o,k.h,k.l,k.c,k.v].map(Number);if(candles.length&&candles.at(-1)[0]===row[0])candles[candles.length-1]=row;else if(candles.length&&row[0]>candles.at(-1)[0]){candles.push(row);scheduleSignal();}candles=candles.slice(-BARS);drawChart();}};
 sock.onclose=()=>{if(socket!==sock)return;const wait=Math.min(30000,1000*Math.pow(2,wsRetry++));setConn('WebSocket disconnected · REST polling active · reconnect in '+Math.round(wait/1000)+'s','#f59e0b');wsTimer=setTimeout(connectWs,wait);};
 sock.onerror=()=>sock.close();
}
function resetAndLoad(){sig=null;sigWantProvider=null;hoverIdx=-1;reqSeq++;candles=[];trades=[];book={bids:[],asks:[]};provider=null;failCount=0;lastGoodKey='';setStale('');drawChart();renderBook();renderTrades();renderSignalCharts();if(socket){socket.onclose=null;socket.close();socket=null;}loadSignal();load();}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
let preparedOrder=null, executionStatus=null;
/* ---- automatic, server-side execution sessions (HttpOnly cookies: this page never sees or stores a token) ---- */
let authInfo=null,testnetOk=false,refreshTimers={},manualNeeded=false;
function authBanner(t,kind){const b=$('authBanner');b.textContent=t;b.className='authbanner'+(kind?' '+kind:'');}
function updateManualAuth(){$('manualAuth').style.display=manualNeeded?'grid':'none';}
function scheduleRefresh(env,refreshAfter){clearTimeout(refreshTimers[env]);const wait=Math.max(5000,refreshAfter-Date.now());refreshTimers[env]=setTimeout(async()=>{try{const r=await fetch('/api/auth/refresh',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:env})}),d=await r.json();if(r.ok)scheduleRefresh(env,d.refreshAfter);else await startSessions();}catch(e){authBanner('Session refresh failed; retrying…','warn');refreshTimers[env]=setTimeout(startSessions,15000);}},wait);}
async function authPost(env){const r=await fetch('/api/auth/session',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:env})});return {r,d:await r.json().catch(()=>({}))};}
async function startSessions(){
 try{
  const p=await authPost('paper');
  if(p.r.status===403&&p.d.error==='automatic_sessions_disabled'){manualNeeded=true;updateManualAuth();authBanner('Automatic sessions are disabled on this Worker (ETI_AUTO_SESSIONS=off). Enter the execution token to trade.','warn');return renderAuthEnvs();}
  if(!p.r.ok){authBanner('Could not start the internal paper session: '+(p.d.message||p.d.error||('HTTP '+p.r.status)),'warn');return renderAuthEnvs();}
  scheduleRefresh('paper',p.d.refreshAfter);
  const t=await authPost('testnet');testnetOk=t.r.ok&&t.d.environment==='testnet';
  if(testnetOk)scheduleRefresh('testnet',t.d.refreshAfter);
  const notes=(t.d.notices||[]).join(' ');
  authBanner(testnetOk?'Authenticated automatically: ETI Internal Paper and exchange testnet sessions are active.':('ETI Internal Paper is active and authenticated. '+(notes||'Exchange testnet is unavailable.')),testnetOk?'ok':'warn');
  if(!testnetOk&&$('orderBroker').value!=='eti_paper')$('orderBroker').value='eti_paper';
 }catch(e){authBanner('Session service unreachable: '+e.message,'warn');}
 await renderAuthEnvs();updateManualAuth();
}
async function renderAuthEnvs(){
 try{
  const r=await fetch('/api/auth/status?validate=1',{credentials:'same-origin',cache:'no-store'}),d=await r.json();authInfo=d;
  const e=d.environments,bk=e.exchange_testnet.brokers||{},chips=[];
  const sess=x=>x&&x.active?' · session until '+new Date(x.expiresAt).toLocaleTimeString():' · no session';
  chips.push('<span class="'+(e.internal_paper.ready&&e.internal_paper.session&&e.internal_paper.session.active?'on':'off')+'">INTERNAL PAPER'+sess(e.internal_paper.session)+'</span>');
  chips.push('<span class="'+(e.exchange_testnet.session&&e.exchange_testnet.session.active?'on':'off')+'">EXCHANGE TESTNET · Alpaca '+esc((bk.alpaca||{}).status||'?')+' · Binance '+esc((bk.binance||{}).status||'?')+sess(e.exchange_testnet.session)+'</span>');
  chips.push('<span class="off">LIVE · '+esc(e.live.status)+' (no sessions, no withdrawals or transfers)</span>');
  $('authEnvs').innerHTML=chips.join('');
 }catch(err){$('authEnvs').textContent='Environment status unavailable.';}
}

function selectedOrder(){
 const broker=$('orderBroker').value, type=$('orderType').value;
 const quantity=Number($('orderQuantity').value), symbol=$('orderSymbol').value.trim().toUpperCase();
 const order={broker,symbol,type,quantity,side:window.etiSelectedSide||'buy',timeInForce:$('orderTif').value};
 if(type==='limit') order.limitPrice=Number($('orderLimitPrice').value);
 if(type==='stop') order.stopPrice=Number($('orderStopPrice').value);
 return order;
}
function orderValidation(o,requireCredentials=true){
 if(symMkt()==='futures')return 'Futures pairs are chart-only here. Switch Market to Spot to place an order.';
 if(!/^[A-Z0-9._-]{2,24}$/.test(o.symbol))return 'Enter a valid symbol.';
 if(!Number.isFinite(o.quantity)||o.quantity<=0)return 'Enter a quantity greater than zero.';
 if(o.type==='limit'&&(!Number.isFinite(o.limitPrice)||o.limitPrice<=0))return 'Enter a valid limit price.';
 if(o.type==='stop'&&o.broker!=='eti_paper')return 'Stop-loss orders are available on ETI Internal Paper only. On exchange testnet use the alert-only levels.';
 if(o.type==='stop'&&o.side!=='sell')return 'A stop-loss order protects a long position: use Sell.';
 if(o.type==='stop'&&(!Number.isFinite(o.stopPrice)||o.stopPrice<=0))return 'Enter a valid stop price.';
 if(!$('operatorId').value.trim())return 'Enter an operator ID for the audit record.';
 return '';
}
function renderPreview(o){
 const summary={venue:o.broker==='eti_paper'?'ETI INTERNAL PAPER (simulated, no exchange)':o.broker,mode:o.broker==='eti_paper'?'internal paper (simulated)':'exchange paper/testnet',symbol:o.symbol,side:o.side,type:o.type,quantity:o.quantity};
 if(o.type==='limit')summary.limitPrice=o.limitPrice;
 {const px=o.type==='limit'?o.limitPrice:o.type==='stop'?o.stopPrice:orderRefPrice();if(px>0&&o.quantity>0){summary.referencePrice=px;summary['estimatedAmount_'+orderQuoteName()]=Math.round(o.quantity*px*100)/100;}}
 summary.executionSource={actorType:'manual_user',actorId:$('operatorId').value.trim(),sourceName:'ETI Dashboard',triggerReason:'Manually submitted from dashboard'};
 $('orderOutput').textContent='Review this order carefully before submission: | '+JSON.stringify(summary,null,2);
}
function describeOutcome(r,d){
 if(d&&d.ok&&d.outcome==='executed')return d.broker==='eti_paper'?'FILLED in ETI Internal Paper (simulated; no exchange contacted)'+(d.fill?' · '+d.fill.quantity+' @ '+Number(d.fill.price).toFixed(4):''):'EXECUTED on '+(d.mode==='testnet'?'Binance testnet':'Alpaca paper')+' · broker order '+d.brokerOrderId+' · status '+d.brokerStatus;
 if(d&&d.ok&&d.outcome==='resting')return 'ACCEPTED into the ETI internal paper book (simulated): it fills only when the market trades through its price';
 if(d&&d.outcome==='rejected')return 'REFUSED by ETI safeguards ('+(d.stage||'check')+'): '+((d.reasons&&d.reasons[0])||d.error)+' · the broker was NOT contacted';
 if(d&&d.outcome==='broker_rejected')return 'REJECTED by the broker (HTTP '+d.status+') · see the broker response below';
 if(d&&d.outcome==='unknown')return 'BROKER OUTCOME UNKNOWN: check the broker before retrying; this order ID stays reserved';
 if(d&&d.error==='execution_disabled')return 'BLOCKED: emergency kill switch is active · the broker was NOT contacted';
 if(r.status===401)return 'REFUSED: the execution token was not accepted · the broker was NOT contacted';
 return 'NOT EXECUTED: '+((d&&(d.message||d.error))||('HTTP '+r.status));
}
async function refreshExecutionStatus(){
 try{
  const r=await fetch('/api/execution/status',{cache:'no-store'}),d=await r.json();executionStatus=d;
  const b=$('orderBroker').value,internal=b==='eti_paper';
  const ready=internal||(b==='alpaca'?d.alpaca_paper_configured:d.binance_testnet_configured), name=internal?'ETI Internal Paper':b==='alpaca'?'Alpaca Paper':'Binance Testnet';
  const sg=d.safeguards||{}, ok=!d.kill_switch&&(internal||(ready&&d.audit_log_configured))&&d.audit_log_configured;
  $('executionStatus').textContent=d.kill_switch?'Halted (kill switch)':ok?'Ready · paper/testnet only':!d.audit_log_configured?'Needs audit log (KV binding)':'Needs '+name+' credentials (internal paper still works)';
  $('executionStatus').style.color=ok?'#21d69a':'#ffb08c';
  if($('brokerStatus')){$('brokerStatus').textContent=name+(internal?' · simulated, no exchange':ready?' · credentials set':' · not configured');$('brokerStatus').style.color=ready?'#21d69a':'#ffb08c';}
  if($('safeguardStatus')){$('safeguardStatus').textContent=sg.engine==='in_process'?'In-process · max qty '+(sg.max_order_quantity==null?'unset':sg.max_order_quantity)+' · duplicate window '+sg.duplicate_window_seconds+'s'+(d.live_flag_ignored?' · live flag ignored':'')+(d.legacy_gateway_config_ignored?' · old gateway settings ignored (safe to delete)':''):'Unknown';$('safeguardStatus').style.color=sg.engine==='in_process'?'#21d69a':'#ff637d';}
  $('killSwitchStatus').textContent=d.kill_switch?'ACTIVE':'Inactive';
  $('killSwitchStatus').style.color=d.kill_switch?'#ff637d':'#21d69a';
 }catch(e){$('executionStatus').textContent='Status unavailable';$('executionStatus').style.color='#ff637d';}
}
async function refreshExecutionHistory(){
 const token=$('executionToken').value,env=$('orderBroker').value==='eti_paper'?'internal_paper':'exchange_testnet';
 $('executionHistory').textContent='Loading audit records…';
 try{
  const r=await fetch('/api/execution/history?environment='+env,{credentials:'same-origin',headers:token?{Authorization:'Bearer '+token}:{},cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.message||d.error||('HTTP '+r.status));
  const records=d.records||[];
  if(!records.length){$('executionHistory').textContent='No ETI execution records found.';return;}
  const label=v=>v.outcome==='rejected'?'Refused (not sent)':v.outcome==='broker_rejected'?'Broker rejected':v.outcome==='unknown'?'Outcome unknown':v.outcome==='resting'?'Resting (simulated book)':'Executed';
  const detail=v=>v.outcome==='executed'?(v.brokerOrderId||v.clientOrderId)+(v.brokerStatus?' · '+v.brokerStatus:''):((v.reasons&&v.reasons[0])||v.error||'');
  $('executionHistory').innerHTML='<table><tr><th>Time (UTC)</th><th>Outcome</th><th>Broker / Mode</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Initiator</th><th>Broker order / reason</th></tr>'+records.map(v=>{const q=v.request||v,src=v.executionSource||{};return '<tr><td>'+esc(v.at||v.executedAt)+'</td><td>'+esc(label(v))+'</td><td>'+esc(v.broker||q.broker)+' / '+esc(v.mode)+'</td><td>'+esc(v.symbol||q.symbol)+'</td><td class="'+((v.side||q.side)==='buy'?'buy':'sell')+'">'+esc(v.side||q.side)+'</td><td>'+esc(v.quantity!=null?v.quantity:q.quantity)+'</td><td>'+esc(src.sourceName)+' ('+esc(src.actorId)+')</td><td>'+esc(detail(v))+'</td></tr>';}).join('')+'</table>';
 }catch(e){$('executionHistory').textContent='Could not load history: '+e.message;}
}
async function submitOrder(side){
 const o=selectedOrder();o.side=side;window.etiSelectedSide=side;
 const problem=orderValidation(o);if(problem){$('orderOutput').textContent=problem;return;}
 if(executionStatus&&executionStatus.kill_switch){$('orderOutput').textContent='Execution blocked: emergency kill switch is active.';return;}
 renderPreview(o);
 const modeLabel=o.broker==='eti_paper'?'INTERNAL PAPER, SIMULATED':'EXCHANGE '+(o.broker==='binance'?'BINANCE TESTNET':'ALPACA PAPER');
 const detail=side.toUpperCase()+' '+o.quantity+' '+o.symbol+' via '+o.broker.toUpperCase()+' ('+modeLabel+', '+o.type.toUpperCase()+')';
 if(!window.confirm('FINAL ORDER CONFIRMATION |  | '+detail+' |  | This submits a PAPER / TESTNET order. No real money is used. Continue?'))return;
 const clientOrderId='eti'+crypto.randomUUID().replace(/-/g,'').slice(0,29);
 const body={broker:o.broker,symbol:o.symbol,side:o.side,type:o.type,quantity:o.quantity,timeInForce:o.timeInForce,clientOrderId,riskConfirmed:true,executionSource:{actorType:'manual_user',actorId:$('operatorId').value.trim(),sourceName:'ETI Dashboard',triggerReason:'Manually submitted from dashboard'}};
 if(o.type==='limit')body.limitPrice=o.limitPrice;
 if(o.type==='stop')body.stopPrice=o.stopPrice;
 if(side==='buy'){const pl=pfPlanFromForm();if(pl)body.plan=pl;}
 $('orderOutput').textContent='Submitting order…';
 try{
  const headers={'content-type':'application/json'};
  if($('executionToken').value)headers.Authorization='Bearer '+$('executionToken').value;
  const send=()=>fetch('/api/orders',{method:'POST',credentials:'same-origin',headers,body:JSON.stringify(body)});
  let r=await send();
  if(r.status===401&&!$('executionToken').value){await startSessions();r=await send();}
  const d=await r.json().catch(()=>({}));
  if(d.fallback&&d.notice)authBanner(d.notice,'warn');
  $('orderOutput').textContent=describeOutcome(r,d)+' | '+JSON.stringify(d,null,2);
  await refreshExecutionHistory();refreshExecutionStatus();pfKick();
 }catch(e){$('orderOutput').textContent='Order submission failed before a response was received: '+e.message+' | Check the audit history before retrying.';pfKick();}
}
$('orderType').onchange=()=>{const t=$('orderType').value;$('limitPriceWrap').style.display=t==='limit'?'flex':'none';$('stopPriceWrap').style.display=t==='stop'?'flex':'none';};
$('orderBroker').onchange=()=>{if($('orderBroker').value!=='eti_paper'&&!testnetOk&&!manualNeeded){$('orderBroker').value='eti_paper';authBanner('Exchange testnet is not available (credentials missing or rejected), so orders stay in ETI Internal Paper. No exchange testnet order will be placed.','warn');}$('orderTif').value=$('orderBroker').value==='binance'?'gtc':'day';refreshExecutionStatus();};
/* ===== Chart trading + profit & leverage calculator ===== */
function drawChartLines(x,g,py,labels){chartLines.forEach(l=>{if(!(l.price>0))return;const y=py(l.price);x.lineWidth=1.2;x.strokeStyle=l.color;x.setLineDash(l.dash||[4,3]);x.beginPath();x.moveTo(0,y);x.lineTo(g.plotW,y);x.stroke();x.setLineDash([]);labels.push({y:y,t:l.label,c:l.color});});}
function setChartLines(src,lines){chartLines=chartLines.filter(l=>l.src!==src).concat(lines.map(l=>Object.assign({src:src},l)));drawChart();}
function ctLast(){return Number(String($('last').textContent).replace(/,/g,''));}
function ctRound(p){const a=Math.abs(p),d=a>=1000?2:a>=100?3:a>=1?4:6;return Number(p.toFixed(d));}
function ctPriceAt(e){const s=chartScale;if(!s)return null;const r=$('chart').getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x<0||x>s.plotW||y<s.top||y>s.bot)return null;return s.hi-(y-s.top)/(s.bot-s.top)*(s.hi-s.lo);}
function ctRefresh(){const p=Number($('ctPrice').value),last=ctLast();
 if(Number.isFinite(p)&&p>0){setChartLines('order',[{price:p,label:'ORDER '+fp(p),color:'#f0c674',dash:[6,3]}]);
  const rel=Number.isFinite(last)&&last>0?(p>last?'above':p<last?'below':'at'):'';
  $('ctHint').textContent=rel?('Price '+fp(p)+' is '+rel+' the last price '+fp(last)+'. A buy limit below (or sell limit above) the market waits to be filled; the other way round it fills immediately at the market price. Same paper/testnet safeguards and confirmation as the Order Execution panel.'):'Orders use the same paper / testnet safeguards and confirmation as the Order Execution panel.';}
 else setChartLines('order',[]);}
function ctSubmit(side,type){
 const q=Number($('ctQty').value);
 if(!(q>0)){$('orderOutput').textContent='Enter a quantity in the chart ticket first.';$('ctQty').focus();return;}
 $('orderSymbol').value=$('symbol').value;$('orderQuantity').value=q;
 if(type==='limit'){const p=Number($('ctPrice').value);if(!(p>0)){$('orderOutput').textContent='Click the chart or type a price first.';$('ctPrice').focus();return;}$('orderType').value='limit';$('orderLimitPrice').value=p;}
 else $('orderType').value='market';
 $('orderType').onchange();submitOrder(side);}
(function wireChartTicket(){const st=$('stack');st.style.cursor='crosshair';
 st.addEventListener('pointermove',e=>{const p=ctPriceAt(e);$('ctCursor').textContent=p===null?'Click the chart to pick a price, or type one.':'Cursor price '+fp(p)+' (click to use it)';});
 st.addEventListener('click',e=>{const p=ctPriceAt(e);if(p===null)return;$('ctPrice').value=ctRound(p);ctRefresh();$('ctCursor').textContent='Price '+fp(ctRound(p))+' selected';});
 $('ctPrice').oninput=ctRefresh;$('ctQty').oninput=()=>{$('orderQuantity').value=$('ctQty').value;};
 $('ctBuyLimit').onclick=()=>ctSubmit('buy','limit');$('ctSellLimit').onclick=()=>ctSubmit('sell','limit');$('ctBuyMkt').onclick=()=>ctSubmit('buy','market');$('ctSellMkt').onclick=()=>ctSubmit('sell','market');
 $('ctClear').onclick=()=>{$('ctPrice').value='';ctRefresh();$('ctCursor').textContent='Click the chart to pick a price, or type one.';};
 $('ctSize').onclick=()=>{if(calcResult&&calcResult.ok){$('ctQty').value=Number(calcResult.position.quantity.toFixed(6));$('orderQuantity').value=$('ctQty').value;}else $('ctHint').textContent='Run the calculator first to get a position size.';};
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('ctPrice').value){$('ctClear').onclick();}});})();
let calcResult=null,calcTimer=null;
function calcNum(id){const v=$(id).value;return v===''?undefined:Number(v);}
function calcBody(){return {side:$('calcSide').value,entry:calcNum('calcEntry'),target:calcNum('calcTarget'),stop:calcNum('calcStop'),leverage:Number($('calcLev').value),sizeBy:$('calcSizeBy').value,margin:calcNum('calcMargin'),quantity:calcNum('calcQty'),balance:calcNum('calcBalance'),riskPct:calcNum('calcRisk'),takerFeeBps:calcNum('calcFee'),maintenanceMarginPct:calcNum('calcMmr')};}
function money(v){return v==null?'-':(v<0?'-':'')+Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});}
function calcOutcomeRow(label,o){if(!o)return '';const c=o.netPnl>=0?'#21d69a':'#ff637d';return '<tr><td>'+label+'</td><td>'+fp(o.price)+' ('+sg(o.movePct)+'%)</td><td>'+money(o.grossPnl)+'</td><td>'+money(o.fees+o.funding)+'</td><td style="color:'+c+'"><b>'+money(o.netPnl)+'</b></td><td style="color:'+c+'">'+sg(o.roiOnMarginPct)+'%</td></tr>';}
function calcRender(d){
 if(!d.ok){$('calcOut').innerHTML='<span style="color:#ffb08c">'+d.errors.map(esc).join(' | ')+'</span>';$('calcMeta').textContent='Check inputs';setChartLines('calc',[]);return;}
 const p=d.position,l=d.liquidation;
 let h='<div class="calckpi"><div>Quantity<b>'+esc(p.quantity)+'</b></div><div>Notional (USDT)<b>'+money(p.notional)+'</b></div><div>Margin (USDT)<b>'+money(p.margin)+'</b>'+(p.marginToBalancePct==null?'':'<span class="muted">'+p.marginToBalancePct+'% of balance</span>')+'</div><div>Est. liquidation<b style="color:#ff9a52">'+fp(l.price)+'</b><span class="muted">'+sg(l.distancePct)+'% from entry</span></div><div>Break-even incl. fees<b>'+fp(d.breakEven)+'</b></div><div>Entry fee (USDT)<b>'+money(d.fees.entry)+'</b></div>'+(d.rewardRisk==null?'':'<div>Net reward / risk<b>'+d.rewardRisk+'</b></div>')+'</div>';
 if(d.atTarget||d.atStop)h+='<div class="scroll"><table><tr><th>At</th><th>Price</th><th>Gross P&amp;L</th><th>Fees + funding</th><th>Net P&amp;L (USDT)</th><th>ROI on margin</th></tr>'+calcOutcomeRow('Target',d.atTarget)+calcOutcomeRow('Stop',d.atStop)+'</table></div>';
 h+='<ul class="ev" style="color:#ffb08c">'+d.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul>';
 $('calcOut').innerHTML=h;$('calcMeta').textContent='Estimates only';
 if($('calcShow').checked){const lines=[{price:Number($('calcEntry').value),label:'CALC ENTRY '+fp(Number($('calcEntry').value)),color:'#56a8ff',dash:[5,4]},{price:l.price,label:'LIQ '+fp(l.price),color:'#ff9a52',dash:[2,3]}];
  if(d.atTarget)lines.push({price:d.atTarget.price,label:'CALC TP '+fp(d.atTarget.price),color:'#21d69a',dash:[6,3]});
  if(d.atStop)lines.push({price:d.atStop.price,label:'CALC SL '+fp(d.atStop.price),color:'#ff637d',dash:[6,3]});
  setChartLines('calc',lines);}else setChartLines('calc',[]);}
async function runCalc(){
 try{const r=await fetch('/api/calc/position',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(calcBody())}),d=await r.json();calcResult=d;calcRender(d);}
 catch(e){$('calcOut').innerHTML='<span style="color:#ffb08c">Calculator unavailable: '+esc(e.message)+'</span>';}}
function calcSoon(){clearTimeout(calcTimer);calcTimer=setTimeout(runCalc,250);}
function calcSync(){const s=$('calcSizeBy').value;$('calcMarginWrap').style.display=s==='margin'?'':'none';$('calcQtyWrap').style.display=s==='quantity'?'':'none';$('calcBalWrap').style.display=s==='risk'?'':'none';$('calcRiskWrap').style.display=s==='risk'?'':'none';$('calcLevOut').textContent=$('calcLev').value+'x';}
['calcSide','calcEntry','calcTarget','calcStop','calcLev','calcSizeBy','calcMargin','calcQty','calcBalance','calcRisk','calcFee','calcMmr','calcShow'].forEach(id=>{$(id).addEventListener('input',()=>{calcSync();calcSoon();});$(id).addEventListener('change',()=>{calcSync();calcSoon();});});
$('calcRun').onclick=runCalc;
$('calcLastPx').onclick=()=>{const v=ctLast();if(v>0){$('calcEntry').value=ctRound(v);runCalc();}};
$('calcToTicket').onclick=()=>{if(calcResult&&calcResult.ok){$('ctQty').value=Number(calcResult.position.quantity.toFixed(6));$('orderQuantity').value=$('ctQty').value;$('ctPrice').value=$('calcEntry').value;ctRefresh();$('ctHint').textContent='Size and entry copied from the calculator. Review them, then use the chart ticket buttons (paper/testnet only).';}else $('calcOut').innerHTML='<span style="color:#ffb08c">Calculate a valid position first.</span>';};
new MutationObserver(()=>{if(!$('calcEntry').value){const v=ctLast();if(v>0){$('calcEntry').value=ctRound(v);runCalc();}}}).observe($('last'),{childList:true,characterData:true,subtree:true});
calcSync();
function syncOrderMarket(){const l=$('last').textContent;$('orderMarketPrice').textContent=l;$('orderChartSymbol').textContent=$('symbol').value;}
new MutationObserver(syncOrderMarket).observe($('last'),{childList:true,characterData:true,subtree:true});syncOrderMarket();
let amtDriver='qty';
function orderRefPrice(){const t=$('orderType').value;const raw=t==='limit'?$('orderLimitPrice').value:t==='stop'?$('orderStopPrice').value:String($('last').textContent).replace(/,/g,'');const v=Number(raw);return Number.isFinite(v)&&v>0?v:0;}
function orderQuoteName(){const m=/(USDT|USDC|BUSD|USD|EUR|BTC|ETH)$/.exec($('orderSymbol').value.trim().toUpperCase());return m?m[1]:'USD';}
function fmtQty(v){return String(Math.floor(v*1e6)/1e6);}
function syncAmount(){
 $('orderQuote').textContent=orderQuoteName();
 const px=orderRefPrice(),note=$('orderAmountNote');
 if(!px){note.textContent=$('orderType').value==='market'?'Waiting for a live price to convert between amount and quantity.':'Enter the '+($('orderType').value==='limit'?'limit':'stop')+' price to convert between amount and quantity.';return;}
 note.textContent='Reference price '+px.toLocaleString(undefined,{maximumFractionDigits:8})+' ('+($('orderType').value==='market'?'live market price':$('orderType').value+' price')+'). Market fills can differ slightly.';
 if(amtDriver==='usd'){const a=Number($('orderAmount').value);$('orderQuantity').value=Number.isFinite(a)&&a>0?fmtQty(a/px):'';}
 else{const q=Number($('orderQuantity').value);$('orderAmount').value=Number.isFinite(q)&&q>0?String(Math.round(q*px*100)/100):'';}
}
$('orderAmount').addEventListener('input',()=>{amtDriver='usd';syncAmount();});
$('orderQuantity').addEventListener('input',()=>{amtDriver='qty';syncAmount();});
['orderLimitPrice','orderStopPrice'].forEach(id=>$(id).addEventListener('input',syncAmount));
['orderType','orderSymbol','symbol'].forEach(id=>$(id).addEventListener('change',syncAmount));
new MutationObserver(syncAmount).observe($('last'),{childList:true,characterData:true,subtree:true});
syncAmount();
$('useMarketPrice').onclick=()=>{const v=Number(String($('last').textContent).replace(/,/g,''));if(!Number.isFinite(v)||v<=0){$('orderOutput').textContent='No live market price is available yet.';return;}$('orderType').value='limit';$('orderType').onchange();$('orderLimitPrice').value=String(v);};
$('orderSymbol').onchange=()=>{const v=$('orderSymbol').value.trim().toUpperCase();$('orderSymbol').value=v;const opt=Array.prototype.find.call($('symbol').options,o=>o.value===v);if(opt&&$('symbol').value!==v){$('symbol').value=v;resetAndLoad();}syncOrderMarket();};
$('symbol').addEventListener('change',syncOrderMarket);
$('previewOrder').onclick=()=>{const o=selectedOrder();const problem=orderValidation(o,false);if(problem){$('orderOutput').textContent=problem;return;}renderPreview(o);};
$('buyOrder').onclick=()=>submitOrder('buy');
$('sellOrder').onclick=()=>submitOrder('sell');
$('clearExecutionSecrets').onclick=()=>{$('executionToken').value='';$('orderOutput').textContent='Typed credentials cleared; sessions are being replaced with fresh tokens.';Promise.all(['paper','testnet'].map(e=>fetch('/api/auth/revoke',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({environment:e})}).catch(()=>null))).then(startSessions);$('executionHistory').textContent='Enter your execution token, then refresh.';};
$('refreshExecutionHistory').onclick=refreshExecutionHistory;
async function loadSignal(){
 const sym=$('symbol').value, iv=$('interval').value, seq=++sigSeq;
 $('signalAction').textContent='ANALYSING…';$('signalAction').style.color='#8fa3bd';
 try{
  const r=await fetch('/api/signals?symbol='+encodeURIComponent(sym)+mkt()+'&interval='+encodeURIComponent(iv)+'&window='+BARS+(provider?'&provider='+encodeURIComponent(provider):''),{cache:'no-store'});
  const d=await r.json();
  if(seq!==sigSeq)return;
  if(!r.ok)throw Error(d.error||('HTTP '+r.status));
  sig=d;
  $('signalAction').textContent=d.action;
  $('signalAction').style.color=d.action==='BUY'?'#21d69a':d.action==='SELL'?'#ff637d':'#f0c674';
  $('signalScore').textContent=sg(d.score)+' / 100 · heuristic';
  $('signalConviction').textContent=d.conviction.toUpperCase()+(d.tradeable?' · tradeable setup':' · lean only');
  $('signalWinRate').textContent=d.historicalValidation.winRate===null?'Withheld · '+d.historicalValidation.sampleCount+' samples':d.historicalValidation.winRate+'% · n='+d.historicalValidation.sampleCount;
  $('signalProvider').textContent=d.provider+' · '+d.interval;
  $('signalEntry').textContent=d.entry===null?'No trade':fmt(d.entry);
  $('signalStop').textContent=d.stopLoss===null?'—':fmt(d.stopLoss);
  $('signalTargets').innerHTML=d.targets.length?d.targets.map(t=>'TP'+t.target+': '+fmt(t.price)+' ('+t.rewardRisk+'R)').join('<br>'):'No targets · wait for confluence';
  $('signalSummary').textContent='Confidence is a confluence score, not a probability. '+d.historicalValidation.note;
  $('signalEvidence').innerHTML='<b>Evidence</b><ul class="ev">'+d.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>';
  $('signalAttribution').innerHTML='<b style="color:#eaf2ff">Strategy attribution</b> · regime '+esc(d.regime.state)+' (ADX '+esc(d.regime.adx)+')'+d.strategyAttribution.map(function(a){return '<div>'+esc(a.trader)+' — '+esc(a.contribution)+'</div>';}).join('');
  $('signalSummary').textContent+=' Sizing: '+(d.positionSizing?(d.positionSizing.suggestedRiskPercent>0?'up to '+d.positionSizing.suggestedRiskPercent+'% of equity at risk':'none suggested')+' ('+d.positionSizing.basis+')':'n/a')+'.';
  $('chart').setAttribute('aria-label','Candlestick chart with ETI signal engine overlays. Engine reads '+d.label+' with score '+sg(d.score)+', '+d.conviction+' conviction.');
  drawChart();renderSignalCharts();syncSignalProvider();
 }catch(e){
  if(seq!==sigSeq)return;
  sig=null;
  $('signalAction').textContent='UNAVAILABLE';$('signalAction').style.color='#ffb08c';
  $('signalScore').textContent='—';$('signalConviction').textContent='—';$('signalWinRate').textContent='Not validated';
  $('signalEntry').textContent='—';$('signalStop').textContent='—';$('signalTargets').textContent='No signal: '+e.message;
  $('signalEvidence').textContent='Fail-closed: no trade recommendation without fresh, valid market candles.';
  drawChart();renderSignalCharts();
 }
}
window.addEventListener('error',e=>{setConn('Dashboard script error · '+String(e.message||'unknown').slice(0,100),'#ff637d');});
window.addEventListener('unhandledrejection',e=>{setConn('Dashboard request error · '+String(e.reason&&e.reason.message||e.reason||'unknown').slice(0,100),'#ffb08c');});
refreshExecutionStatus();
function fmtVal(v){if(v==null||v==='')return '—';if(Array.isArray(v))return v.map(fmtVal).join('; ');if(typeof v==='object')return '['+esc(v.classification||'')+'] '+esc(v.claim||'')+(v.source?' — '+esc(v.source):' — no source recorded');return esc(v);}
let traderTimer=null;
async function loadTraders(){
 const q=$('traderSearch').value.trim();
 try{
  const r=await fetch('/api/intelligence/traders'+(q?'?q='+encodeURIComponent(q):''),{cache:'no-store'}),d=await r.json();
  const list=d.profiles||[];
  $('traderSelect').innerHTML=list.map(function(t){return '<option value="'+esc(t.id)+'">'+esc(t.name||t.full_name)+'</option>';}).join('');
  $('traderMeta').textContent=(d.count==null?list.length:d.count)+' profiles · source: '+(d.source||'unknown')+(d.generatedAt?' · built '+String(d.generatedAt).slice(0,10):'');
  if(list.length)showTrader(list[0].id);else $('traderDetail').textContent='No matching profiles.';
 }catch(e){$('traderMeta').textContent='unavailable';$('traderDetail').textContent='Trader intelligence unavailable: '+e.message;}
}
async function showTrader(id){
 $('traderDetail').textContent='Loading…';
 try{
  const r=await fetch('/api/intelligence/traders/'+encodeURIComponent(id),{cache:'no-store'}),d=await r.json();
  if(!r.ok)throw Error(d.error||('HTTP '+r.status));
  const p=d.profile;
  if(!p.full_name){$('traderDetail').innerHTML='<b>'+esc(p.name)+'</b><div>'+esc((p.documentedPrinciples||[]).join('; '))+'</div><div>'+esc(p.evidenceCaveat||'')+'</div>';return;}
  const rows=[['Biography',p.biography],['Trading history',p.trading_history],['Markets',p.markets_traded],['Instruments',p.preferred_instruments],['Philosophy',p.philosophy],['Documented patterns',p.documented_patterns],['Entry criteria',p.entry_criteria],['Exit criteria',p.exit_criteria],['Stop-loss methodology',p.stop_loss_methodology],['Position sizing',p.position_sizing],['Risk to reward',p.risk_reward],['Technical indicators',p.technical_indicators],['Fundamental methodology',p.fundamental_methodology],['Preferred conditions',p.preferred_conditions],['Avoid trading when',p.avoid_conditions],['Decision psychology',p.decision_psychology],['Historical returns',p.historical_returns],['Historical drawdowns',p.historical_drawdowns],['Win rates',p.win_rates],['Net worth',p.net_worth],['Famous successful trades',p.famous_successful_trades],['Famous unsuccessful trades',p.famous_unsuccessful_trades],['Predictions and outcomes',p.predictions_outcomes],['Strengths',p.strengths],['Weaknesses',p.weaknesses],['Lessons for ETI',p.eti_lessons],['Strategy modules',p.strategy_module_ids]];
  const c=d.completeness||{};
  $('traderDetail').innerHTML='<div style="font-size:16px;color:#eaf2ff"><b>'+esc(p.full_name)+'</b></div><div>Profile fields: '+esc(c.fieldsPresent)+' / '+esc(c.fieldsRequired)+' · net worth: '+esc(d.netWorthStatus)+' · sourced performance notes: '+esc(d.sourcedPerformanceNotes)+'</div>'+rows.map(function(x){return '<div style="margin:8px 0"><b style="color:#eaf2ff">'+esc(x[0])+'</b><div>'+fmtVal(x[1])+'</div></div>';}).join('');
 }catch(e){$('traderDetail').textContent='Could not load profile: '+e.message;}
}
$('traderSelect').onchange=function(){showTrader($('traderSelect').value);};
$('traderSearch').oninput=function(){clearTimeout(traderTimer);traderTimer=setTimeout(loadTraders,300);};
/* ===== ETI Market Readiness Engine panel ===== */
const RD_COL={FAVOURABLE:'#21d69a',SELECTIVELY_FAVOURABLE:'#a3e635',UNCERTAIN:'#f0c674',HIGH_RISK:'#ff9a52',AVOID_TRADING:'#ff637d'};
const RD_RATE={supportive:'#21d69a',neutral:'#8fa3bd',caution:'#f0c674',adverse:'#ff9a52',severe:'#ff637d',not_evaluated:'#56a8ff'};
let rdSeq=0,rdTimer=null;
function rdQuery(){const m=$('rdMarket').value,s=$('rdSymbol').value.trim().toUpperCase(),sc=$('rdScope').value;let q='market='+encodeURIComponent(m);if(s)q+='&symbol='+encodeURIComponent(s);
 if(sc==='now')q+='&scope=now';else if(sc==='today')q+='&scope=day&day=today';else if(sc==='tomorrow')q+='&scope=day&day=tomorrow';else if(sc==='session')q+='&scope=session&session='+encodeURIComponent($('rdSession').value);else q+='&scope=hour&hour='+Number($('rdHour').value||0);return q;}
function rdChip(t,c){return '<span class="rdchip" style="color:'+c+'">'+esc(t)+'</span>';}
function rdRender(d){
 const o=d.overall,col=RD_COL[o.status]||'#8fa3bd';
 let h='<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:6px 0 10px"><span style="font-size:20px;font-weight:700;color:'+col+';border:1px solid '+col+';border-radius:10px;padding:6px 14px">'+esc(o.statusLabel)+'</span><span class="muted">'+esc(d.market)+(d.symbol?' '+esc(d.symbol):'')+' | '+esc(o.label)+' | '+o.evaluated+' of 12 factors evaluated | '+(o.liveConditionsApplied?'live conditions applied':'schedule and history only')+'</span></div>';
 h+='<div><b>Reason</b><ul class="ev">'+((o.reasons||[]).slice(0,8).map(r=>'<li>'+esc(r)+'</li>').join('')||'<li>No factor could be evaluated.</li>')+'</ul></div>';
 if((o.caps||[]).length)h+='<ul class="ev" style="color:#ffb08c">'+o.caps.map(c=>'<li>'+esc(c)+'</li>').join('')+'</ul>';
 h+='<div style="margin:8px 0"><b>Recommendation</b><div>'+esc(o.recommendation)+'</div><div class="execution-note">Do not enter simply because conditions are rated favourably. Wait for a valid setup and confirmation.</div></div>';
 h+='<div class="scroll"><table class="rdtable"><tr><th>#</th><th>Factor</th><th>Rating</th><th>Finding</th></tr>'+o.factors.map(f=>'<tr><td>'+f.id+'</td><td>'+esc(f.factor)+'</td><td>'+rdChip(f.rating.replace('_',' '),RD_RATE[f.rating]||'#8fa3bd')+'</td><td>'+esc(f.headline)+((f.detail||[]).length?'<details><summary>Details</summary>'+f.detail.map(x=>'<div>'+esc(x)+'</div>').join('')+'</details>':'')+'</td></tr>').join('')+'</table></div>';
 h+='<div style="margin-top:12px"><b>Trading sessions</b><div class="rdgrid">'+d.sessions.map(s=>{const a=s.assessment,c=RD_COL[a.status]||'#8fa3bd',m=s.measured;return '<div class="rdcard"><div style="display:flex;justify-content:space-between;gap:6px;align-items:center"><b>'+esc(s.label)+'</b>'+rdChip(a.statusLabel,c)+'</div><div class="execution-note">'+(s.activeNow?'Active now. ':'')+esc(a.label)+'</div><ul class="ev">'+(a.reasons||[]).slice(0,3).map(r=>'<li>'+esc(r)+'</li>').join('')+'</ul>'+(m?'<div class="execution-note">Measured: range '+m.rangeVsBaseline.toFixed(2)+'x, volume '+m.volumeVsBaseline.toFixed(2)+'x baseline over '+m.instances+' sessions'+(m.sampleOk?'':' (small sample)')+'</div>':'')+(s.structuralFit?'<div class="execution-note">Structural fit for '+esc(d.symbol)+': '+esc(s.structuralFit)+' (schedule-based, not measured)</div>':'')+'</div>';}).join('')+'</div></div>';
 if(d.hours)h+='<div style="margin-top:12px"><b>Hour by hour (UTC)</b><div class="rdhours">'+d.hours.map(x=>'<span title="'+esc(String(x.hourUtc).padStart(2,'0')+':00 UTC '+x.statusLabel+(x.topReason?' - '+x.topReason:''))+'" style="background:'+(RD_COL[x.status]||'#8fa3bd')+'">'+String(x.hourUtc).padStart(2,'0')+'</span>').join('')+'</div></div>';
 if(o.eventHits&&o.eventHits.length)h+='<div style="margin-top:12px"><b>Events affecting this window</b><ul class="ev">'+o.eventHits.map(e=>'<li>'+esc(e.title)+' ['+esc(e.impact)+', '+esc(e.severity.replace('_',' '))+'] '+esc(e.time.slice(0,16).replace('T',' '))+' UTC</li>').join('')+'</ul></div>';
 if(o.closures&&o.closures.length)h+='<div class="execution-note" style="margin-top:10px">Upcoming closures: '+o.closures.map(c=>esc(c.date+' '+c.exchange+' '+c.name)).join('; ')+'</div>';
 if(o.notEvaluated&&o.notEvaluated.length)h+='<div class="execution-note" style="margin-top:8px">Not evaluated: '+o.notEvaluated.map(esc).join('; ')+'</div>';
 h+='<div class="execution-note" style="margin-top:8px">'+esc((d.disclaimers||[])[0]||'')+'</div>';
 $('rdOut').innerHTML=h;$('rdText').textContent=d.text||'';
 const q=d.dataQuality||{};$('rdMeta').textContent='Generated '+d.generatedAt.slice(11,19)+' UTC | calendar: '+((q.economicCalendar||{}).status||'unknown')+' | price data: '+(q.priceData||'unknown');
}
async function loadReadiness(){
 const seq=++rdSeq;$('rdMeta').textContent='Assessing...';
 try{const r=await fetch('/api/readiness?'+rdQuery(),{cache:'no-store'}),d=await r.json();if(seq!==rdSeq)return;if(!r.ok)throw Error(d.message||d.error||('HTTP '+r.status));rdRender(d);}
 catch(e){if(seq!==rdSeq)return;$('rdOut').innerHTML='<span style="color:#ffb08c">Readiness unavailable: '+esc(e.message)+'. Treat this as UNVERIFIED and do not assume conditions are safe.</span>';$('rdMeta').textContent='Unavailable';}
}
function rdSync(){const sc=$('rdScope').value;$('rdSession').style.display=sc==='session'?'':'none';$('rdHour').style.display=sc==='hour'?'':'none';if(sc==='hour'&&!$('rdHour').dataset.set){$('rdHour').value=(new Date().getUTCHours()+1)%24;$('rdHour').dataset.set='1';}}
$('rdScope').onchange=()=>{rdSync();loadReadiness();};$('rdSession').onchange=loadReadiness;$('rdHour').onchange=loadReadiness;$('rdRefresh').onclick=loadReadiness;
$('rdMarket').onchange=()=>{$('rdSymbol').value=$('rdMarket').value==='crypto'?$('symbol').value:'';loadReadiness();};
$('rdSymbol').onchange=()=>{$('rdSymbol').value=$('rdSymbol').value.trim().toUpperCase();loadReadiness();};
$('rdTextBtn').onclick=()=>{const t=$('rdText');t.style.display=t.style.display==='none'?'block':'none';};
$('symbol').addEventListener('change',()=>{if($('rdMarket').value==='crypto'){$('rdSymbol').value=$('symbol').value;loadReadiness();}});
$('rdSymbol').value=$('symbol').value;rdSync();loadReadiness();rdTimer=setInterval(loadReadiness,120000);
function intelRow(a,b){return '<tr><td style="padding:3px 8px 3px 0;color:#94a3b8">'+esc(a)+'</td><td style="padding:3px 0">'+b+'</td></tr>';}
async function runIntel(){
 const out=$('intelOut'),btn=$('intelRun'),sym=$('symbol').value,strat=$('intelStrategy').value,det=$('intelDetail').value;
 out.textContent='Running engines for '+sym+' ('+strat+')… this fetches candles, fundamentals and news and can take several seconds.';btn.disabled=true;
 try{
  const r=await fetch('/api/analysis/intelligence?symbol='+encodeURIComponent(sym)+'&strategy='+encodeURIComponent(strat)+'&detail='+encodeURIComponent(det)+'&include=omnisignal',{cache:'no-store'}),j=await r.json();
  if(!r.ok||!j.verdict){out.textContent='Analysis unavailable: '+(j.detail||j.error||('HTTP '+r.status));btn.disabled=false;return;}
  let h='<div style="font-size:16px;margin-bottom:6px"><b>'+esc(j.headline)+'</b></div><div class="muted" style="margin-bottom:8px">Generated '+esc(j.generatedAt)+' | evidence quality '+esc(j.confidence)+'/100 (not a probability of profit)</div><table>';
  j.domains.forEach(function(d){h+=intelRow(d.domain,esc(d.stance)+(d.effectiveWeight>0?' | score '+esc(d.score)+' | confidence '+esc(d.confidence)+' | weight '+esc(Math.round(d.effectiveWeight*100))+'%':' | '+esc(d.summary)));});
  h+='</table>';
  if(j.vetoes.length)h+='<div style="margin-top:8px"><b>Vetoes and safeguards</b><ul>'+j.vetoes.map(function(v){return '<li>['+esc(v.effect)+'] '+esc(v.reason)+'</li>';}).join('')+'</ul></div>';
  if(j.conflicts.length)h+='<div style="margin-top:8px"><b>Engine conflicts (not averaged away)</b><ul>'+j.conflicts.map(function(c){return '<li>'+esc(c.detail)+'</li>';}).join('')+'</ul></div>';
  if(j.timing.length)h+='<div style="margin-top:8px"><b>Timeframe read</b><ul>'+j.timing.map(function(t){return '<li>'+esc(t)+'</li>';}).join('')+'</ul></div>';
  if(j.risks.length)h+='<div style="margin-top:8px"><b>Risks and warnings</b><ul>'+j.risks.map(function(t){return '<li>'+esc(t)+'</li>';}).join('')+'</ul></div>';
  if(j.whatWouldChangeThisView.length)h+='<div style="margin-top:8px"><b>What would change this view</b><ul>'+j.whatWouldChangeThisView.map(function(t){return '<li>'+esc(t)+'</li>';}).join('')+'</ul></div>';
  if(j.technicalDetail){h+='<div style="margin-top:8px"><b>Multi-timeframe</b> '+esc(j.technicalDetail.alignment.replace(/_/g,' '))+'<table style="margin-top:4px">'+j.technicalDetail.timeframes.map(function(t){return '<tr><td style="padding:2px 10px 2px 0">'+esc(t.timeframe)+'</td><td style="padding:2px 10px 2px 0;color:#94a3b8">'+esc(t.layer)+'</td><td style="padding:2px 10px 2px 0">'+esc(t.mode==='full'||t.mode==='macro'?t.stance:t.mode)+'</td><td style="padding:2px 10px 2px 0">'+(t.mode==='full'||t.mode==='macro'?esc(t.score)+' / conf '+esc(t.confidence):'')+'</td><td class="muted">'+esc(t.closedCandles)+' candles</td></tr>';}).join('')+'</table></div>';}
  const sent=j.engineReports.filter(function(e){return e.domain==='sentiment';})[0];
  if(sent)h+='<div style="margin-top:8px"><b>News and sentiment</b><ul>'+sent.findings.slice(0,6).map(function(f){return '<li>'+esc(f.description)+'</li>';}).join('')+'</ul></div>';
  if(j.crossCheck&&j.crossCheck.omnisignal)h+='<div style="margin-top:8px"><b>Omnisignal cross-check</b> '+esc(j.crossCheck.omnisignal.decision)+': '+esc(j.crossCheck.omnisignal.note)+'</div>';
  if(j.dataQuality&&j.dataQuality.setupRequired)h+='<div style="margin-top:8px"><b>Setup required</b> '+esc(j.dataQuality.setupRequired)+'</div>';
  h+='<div class="muted" style="margin-top:10px">'+esc(j.disclaimer)+'</div>';
  out.innerHTML=h;$('intelMeta').textContent='Last run '+new Date().toLocaleTimeString();
 }catch(e){out.textContent='Analysis failed: '+e.message;}
 btn.disabled=false;
}
$('intelRun').onclick=runIntel;
loadTraders();
refreshExecutionStatus();startSessions().then(()=>refreshExecutionHistory());
loadSignal();
setInterval(loadSignal,60000);

${PORTFOLIO_JS}
pfInit();
const SYM={all:[],market:'spot',quote:'',cat:'',q:'',at:0,warn:''};
function symRows(){if(SYM.market!=='metals')return SYM.all.filter(r=>r[3]===SYM.market);const seen={};return SYM.all.filter(r=>r[4]==='metals').sort((a,b)=>(a[3]===b[3]?0:a[3]==='spot'?-1:1)).filter(r=>seen[r[0]]?false:(seen[r[0]]=1));}
function symFill(sel,first,values,label){sel.textContent='';const a=document.createElement('option');a.value='';a.textContent=first;sel.appendChild(a);values.forEach(v=>{const o=document.createElement('option');o.value=v[0];o.textContent=label(v);sel.appendChild(o);});}
const METAL_NAMES={XAU:'Gold',XAG:'Silver',XPT:'Platinum',XPD:'Palladium',XCU:'Copper',COPPER:'Copper',GOLD:'Gold',SILVER:'Silver',PLATINUM:'Platinum',PALLADIUM:'Palladium',PAXG:'Gold token PAXG',XAUT:'Gold token XAUT'};
function symMetalLabel(r){return (METAL_NAMES[r[1]]||r[1])+' · '+r[1]+'/'+r[2]+' · '+(r[3]==='futures'?'perpetual':'spot');}
let etiNoteSeq=0;
async function etiMarketNote(){
 const el=$('symEti');if(!el)return;
 if($('symMarket').value!=='metals'){el.style.display='none';el.textContent='';return;}
 const sym=$('symbol').value,seq=++etiNoteSeq;
 try{
  const r=await fetch('/api/markets/assess?symbol='+encodeURIComponent(sym),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);
  const a=await r.json();if(seq!==etiNoteSeq)return;
  const ss=a.session||{},why=(a.reasons||[])[0]||(a.warnings||[])[0]||'';
  el.textContent='ETI: '+((a.instrument&&a.instrument.name)||sym)+' · '+(a.profile&&a.profile.label?a.profile.label+' · ':'')+'session '+(ss.state||'unknown')+(ss.next_close_utc&&ss.is_open?' (closes '+ss.next_close_utc.slice(11,16)+' UTC)':ss.next_open_utc?' (opens '+ss.next_open_utc.slice(0,16).replace('T',' ')+' UTC)':'')+' · verdict '+String(a.verdict||'').replace(/_/g,' ')+(why?' — '+why:'');
  el.style.display='';
 }catch(e){if(seq===etiNoteSeq){el.textContent='ETI market review unavailable ('+(e&&e.message?e.message:'error')+')';el.style.display='';}}
}
function symFilters(){
 const rows=symRows(),cnt={},cats={};rows.forEach(r=>{cnt[r[2]]=(cnt[r[2]]||0)+1;cats[r[4]]=(cats[r[4]]||0)+1;});
 const qs=Object.keys(cnt).sort((a,b)=>(a==='USDT'?-1:b==='USDT'?1:cnt[b]-cnt[a]||(a<b?-1:1)));
 symFill($('symQuote'),'All quotes',qs.map(q=>[q]),v=>v[0]+' ('+cnt[v[0]]+')');$('symQuote').value=cnt[SYM.quote]?SYM.quote:'';SYM.quote=$('symQuote').value;
 const cs=Object.keys(cats).sort((a,b)=>(a==='crypto'?-1:b==='crypto'?1:a<b?-1:1));
 symFill($('symCat'),'All types',cs.map(c=>[c]),v=>v[0]+' ('+cats[v[0]]+')');$('symCat').value=cats[SYM.cat]?SYM.cat:'';SYM.cat=$('symCat').value;
 $('symCat').style.display=SYM.market==='futures'&&cs.length>1?'':'none';
}
function symRebuild(want){
 const sel=$('symbol'),cur=want||sel.value,t=SYM.q.trim().toUpperCase(),all=symRows();
 const rows=all.filter(r=>(!SYM.quote||r[2]===SYM.quote)&&(!SYM.cat||r[4]===SYM.cat)&&(!t||r[0].indexOf(t)>=0||r[1].indexOf(t)>=0));
 const frag=document.createDocumentFragment();let hasCur=false;
 rows.forEach(r=>{const o=document.createElement('option');o.value=r[0];o.textContent=SYM.market==='metals'?symMetalLabel(r):r[1]+'/'+r[2]+(r[4]&&r[4]!=='crypto'?' · '+r[4]:'');if(r[0]===cur)hasCur=true;frag.appendChild(o);});
 sel.textContent='';
 if(!hasCur){const o=document.createElement('option');o.value=cur;o.textContent=cur+' (current)';sel.appendChild(o);}
 sel.appendChild(frag);sel.value=cur;
 const upd=SYM.at?' · list updated '+new Date(SYM.at).toTimeString().slice(0,5)+', refreshes every 10 min':'';
 $('symCount').textContent=rows.length+' of '+all.length+' Binance '+(SYM.market==='futures'?'perpetual futures':SYM.market==='metals'?'metals (gold, silver, copper, gold tokens)':'spot')+' pairs'+upd+(SYM.warn?' · '+SYM.warn:'');
 const dl=$('symbolList');if(dl&&dl.dataset.n!==String(SYM.at)){dl.textContent='';SYM.all.filter(r=>r[3]==='spot').forEach(r=>{const o=document.createElement('option');o.value=r[0];dl.appendChild(o);});dl.dataset.n=String(SYM.at);}
}
async function loadSymbols(){
 try{
  const j=(await getJson('/api/market/symbols')).data||{};
  SYM.all=j.symbols||[];SYM.at=Date.now();
  SYM.warn=(j.warnings||[]).length?'could not refresh '+j.warnings.map(w=>w.market).join(', ')+' list':'';
  Object.keys(j.sources||{}).forEach(k=>{if(j.sources[k].stale)SYM.warn=(SYM.warn?SYM.warn+'; ':'')+k+' list is stale';});
  symFilters();symRebuild();
 }catch(e){$('symCount').textContent=(SYM.all.length?'Pair list refresh failed ('+(e&&e.message?e.message:'error')+'); keeping the last list. ':'Full pair list unavailable ('+(e&&e.message?e.message:'error')+'); showing the default pairs. ')+'Type any Binance symbol in Order Execution.';}
}
function symMarketChanged(){
 SYM.market=$('symMarket').value;SYM.quote='';SYM.cat='';symFilters();
 const rows=symRows(),cur=$('symbol').value;let want='';
 if(rows.length&&!rows.some(r=>r[0]===cur)){const d=SYM.market==='metals'?(rows.find(r=>r[1]==='XAU')||rows.find(r=>r[1]==='PAXG')||rows[0]):(rows.find(r=>r[0]==='BTCUSDT')||rows[0]);$('symbol').value=d[0];want=d[0];}
 symRebuild(want);$('orderSymbol').value=$('symbol').value;resetAndLoad();syncOrderMarket();
 if(symMkt()==='futures')$('orderOutput').textContent='Futures are chart-only here. Orders are placed on spot pairs.';
 if(SYM.market==='metals'&&!rows.length)$('symCount').textContent='No metals pairs in the Binance list yet (list unavailable or none listed). Try again shortly.';
 etiMarketNote();
}
$('symMarket').addEventListener('change',symMarketChanged);
$('symSearch').addEventListener('input',()=>{SYM.q=$('symSearch').value;symRebuild();});
$('symSearch').addEventListener('keydown',e=>{if(e.key!=='Enter')return;const t=SYM.q.trim().toUpperCase();if(!t)return;const rows=symRows(),m=rows.find(r=>r[0]===t)||rows.find(r=>(!SYM.quote||r[2]===SYM.quote)&&(!SYM.cat||r[4]===SYM.cat)&&(r[0].indexOf(t)>=0||r[1]===t));if(m){$('symbol').value=m[0];$('symbol').dispatchEvent(new Event('change'));$('symSearch').value='';SYM.q='';symRebuild();}});
$('symQuote').addEventListener('change',()=>{SYM.quote=$('symQuote').value;symRebuild();});
$('symCat').addEventListener('change',()=>{SYM.cat=$('symCat').value;symRebuild();});
loadSymbols();setInterval(loadSymbols,600000);
$('refresh').onclick=()=>{failCount=0;load();};$('symbol').onchange=()=>{$('orderSymbol').value=$('symbol').value;resetAndLoad();etiMarketNote();};$('interval').onchange=()=>{resetAndLoad();};window.onresize=()=>{drawChart();renderSignalCharts()};wireChartInteractions();load();
</script></body></html>`;
const page = withMotion(html);

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/orders") || url.pathname === "/api/execution/status" || url.pathname === "/api/execution/history") {
      return handleExecution(request, _env);
    }
    if (url.pathname.startsWith("/api/portfolio/")) return handlePortfolio(request, _env as any);
    if (url.pathname.startsWith("/api/auth/")) return handleAuth(request, _env as any);
    if (url.pathname === "/alpha" || url.pathname.startsWith("/api/alpha")) {
      return handleAlpha(request, _env);
    }
    if (url.pathname.startsWith("/api/intelligence/")) {
      const knowledge = handleKnowledge(request);
      if (knowledge) return knowledge;
    }
    if (url.pathname === "/api/signals") {
      return handleSignals(request, _env);
    }
    if (url.pathname === "/api/calc/position") {
      return handleCalc(request);
    }
    if (url.pathname === "/api/readiness" || url.pathname.startsWith("/api/readiness/")) {
      return handleReadiness(request, _env);
    }
    if (url.pathname === "/api/algo/signal") {
      return handleAlgoSignal(request, _env);
    }
    if (url.pathname.startsWith("/api/paper")) {
      return handlePaper(request, _env);
    }
    if (url.pathname === "/api/omnisignal/execute") return handleTestnetExecute(request, _env as any);
    if (url.pathname === "/api/omnisignal/manage") return handleManage(request, _env as any);
    if (url.pathname === "/api/omnisignal/alerts" || url.pathname === "/api/omnisignal/alerts/test") return handleAlerts(request, _env as any);
    if (url.pathname === "/omnisignal" || url.pathname === "/omnisignal.js") {
      return handleOmniUi(request) as Response;
    }
    if (url.pathname === "/api/analysis" || url.pathname.startsWith("/api/analysis/")) {
      return handleAnalysis(request, _env);
    }
    if (url.pathname === "/api/omnisignal" || url.pathname === "/api/omnisignal/scan" || url.pathname === "/api/omnisignal/universe" || url.pathname === "/api/omnisignal/universe/refresh") {
      return handleOmnisignal(request, _env);
    }
    if (url.pathname.startsWith("/api/market/")) {
      return handleMarket(request, _env);
    }
    if (url.pathname === "/__eti/status" || url.pathname === "/api/system/health") {
      return json({ service: "Elite Trading Intelligence", role: "cloudflare-worker", status: "ok", backend_required: false, market_data: "Binance/Bybit/OKX public REST with failover (see /api/market/diag)", time: new Date().toISOString() });
    }
    if (url.pathname === "/") {
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    // Optional: forward everything else to a configured origin (BACKEND_URL). Unset by default.
    if (typeof _env.BACKEND_URL === "string" && _env.BACKEND_URL.trim()) return proxyToBackend(request, _env.BACKEND_URL.trim());
    return json({ error: "not_found", path: url.pathname, message: "This Cloudflare-native build currently exposes the live market dashboard and health endpoints. Existing FastAPI research/trading modules have not yet been ported." }, 404);
  },
};
