// GET /api/omnisignal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz
// Analytical and read-only. It never submits orders; execution stays behind the existing risk-gated /api/orders routes.
import type { MarketEnv } from "../market.ts";
import type { Strategy } from "./timeframes.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { runOmnisignal } from "./omnisignal.ts";
import { MAX_SCAN_SYMBOLS, parseSymbols, scan } from "./scan.ts";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
export const STRATEGIES: Strategy[] = ["scalp", "intraday", "swing", "position"];

export async function handleOmnisignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/omnisignal/scan") {
    if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
    const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy, { symbols, ignored } = parseSymbols(url.searchParams.get("symbols"));
    if (!STRATEGIES.includes(strategy) || !symbols.length) return reply({ error: "invalid_strategy_or_symbols", maxSymbols: MAX_SCAN_SYMBOLS, strategies: STRATEGIES }, 400);
    const leaderboard = await scan(env, symbols, strategy);
    return reply({ strategy, scanned: symbols, ignoredSymbols: ignored, maxSymbols: MAX_SCAN_SYMBOLS, leaderboard, submitsOrder: false, liveExecutionAllowed: false,
      note: "Ranked by evidence quality (validator score, reward/risk, liquidity), not by predicted profit. Only BUY/SELL rows are ranked; HOLD and REJECTED are valid outcomes. Scores are uncalibrated and are not win probabilities." });
  }
  if (url.pathname !== "/api/omnisignal") return reply({ error: "not_found" }, 404);
  if (req.method !== "GET") return reply({ error: "method_not_allowed", note: "This endpoint is analytical and read-only; it cannot place orders." }, 405);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy;
  const engines = (url.searchParams.get("engines") || "swift,gainz").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy) || !engines.length || engines.some(e => e !== "swift" && e !== "gainz"))
    return reply({ error: "invalid_symbol_strategy_or_engines", strategies: STRATEGIES, engines: ["swift", "gainz"] }, 400);
  const inputs = await loadSignalInputs(env, symbol, strategy, url.searchParams.get("provider"));
  if ("error" in inputs) return reply({ decision: "DATA_UNRELIABLE", error: inputs.error, executionTimeframe: inputs.executionTimeframe, failures: inputs.failures, submitsOrder: false, liveExecutionAllowed: false }, 503);
  const { candles, depth, provider, failures } = inputs;
  const result = runOmnisignal({ symbol, strategy, candles, depth, now: Date.now() }, { enabledEngines: { swift: engines.includes("swift"), gainz: engines.includes("gainz") } });
  return reply({ ...result, dataQuality: { provider, timeframesLoaded: Object.keys(candles), failures, orderBook: depth ? "rest_snapshot" : "unavailable", providerCrossCheck: "not_performed",
    note: "Single validated provider per request; cross-provider reconciliation is not performed and the REST order-book snapshot is timestamped at fetch time." },
    validationStatus: { expectancy: "unmeasured_until_backtest_lab", accountRisk: "not_evaluated_by_analytical_endpoint", execution: "Orders require POST /api/orders and the server-side risk-gateway preflight; live trading remains disabled by default." } });
}
