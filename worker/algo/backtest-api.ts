// GET /api/algo/backtest?symbol=BTCUSDT&interval=1h&markets=ETHUSDT,SOLUSDT&feeBps=10&slippageBps=5
import { getMarketData, providerOrder, type Kline, type MarketEnv } from "../market.ts";
import { DEFAULT_COSTS, expectancyFromReport, optimize } from "./backtest.ts";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: HEADERS });
const INTERVALS = ["5m", "15m", "30m", "1h", "4h", "1d"];
const SYMBOL = /^[A-Z0-9]{5,20}$/;

export async function handleAlgoBacktest(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/algo/backtest" || req.method !== "GET") return reply({ error: "not_found" }, 404);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase(), interval = url.searchParams.get("interval") || "1h";
  const extra = (url.searchParams.get("markets") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 2);
  const fee = Number(url.searchParams.get("feeBps") ?? DEFAULT_COSTS.feeBps), slip = Number(url.searchParams.get("slippageBps") ?? DEFAULT_COSTS.slippageBps);
  if (![symbol, ...extra].every(s => SYMBOL.test(s)) || !INTERVALS.includes(interval) || !(fee >= 0 && fee <= 100) || !(slip >= 0 && slip <= 100))
    return reply({ error: "invalid_parameters", intervals: INTERVALS, feeBps: "0-100", slippageBps: "0-100", maxExtraMarkets: 2 }, 400);
  const order = providerOrder(env, url.searchParams.get("provider"));
  const markets: Record<string, Kline[]> = {}, failures: Record<string, string> = {};
  await Promise.all([symbol, ...extra].map(async s => {
    try { markets[s] = (await getMarketData("klines", { symbol: s, interval, limit: 1000 }, order)).data as Kline[]; }
    catch (e) { failures[s] = e instanceof Error ? e.message : "unknown"; }
  }));
  if (!markets[symbol]) return reply({ error: "market_data_unavailable", symbol, failures }, 503);
  const report = optimize(markets, { primary: symbol, costs: { feeBps: fee, slippageBps: slip } });
  return reply({ symbol, interval, candlesPerMarket: Object.fromEntries(Object.entries(markets).map(([k, v]) => [k, v.length])), failures, report,
    validatedExpectancy: expectancyFromReport(report), performanceLabel: "backtested_only",
    note: "Backtested results only. Paper-trading and verified live performance are tracked separately and are not implied by this report." });
}
