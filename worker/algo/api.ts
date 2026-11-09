// GET /api/algo/signal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz
// There is ONE signal path in ETI: engines -> fusion -> independent validation (runOmnisignal, also served at /api/omnisignal).
// This route is a thin adapter over it that adds the EARLY / CONFIRMED / HIGH_CONVICTION classification and the flat trade-plan
// fields (action, entry, stopLoss, takeProfits, riskReward). It shares the data loader with /api/omnisignal and is read-only.
import type { MarketEnv } from "../market.ts";
import { analyzeLiquidity } from "./liquidity.ts";
import { loadSignalInputs } from "./market-inputs.ts";
import { STRATEGIES } from "./omni-api.ts";
import { runOmnisignal } from "./omnisignal.ts";
import { EXECUTION_TF, type Strategy } from "./timeframes.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const ENGINES = ["swift", "gainz"];

export async function handleAlgoSignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/algo/signal" || req.method !== "GET") return reply({ error: "not_found" }, 404);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT").toUpperCase();
  const strategy = (url.searchParams.get("strategy") || "intraday") as Strategy;
  const engines = (url.searchParams.get("engines") || "swift,gainz").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  if (!/^[A-Z0-9]{5,20}$/.test(symbol) || !STRATEGIES.includes(strategy) || !engines.length || engines.some(e => !ENGINES.includes(e)))
    return reply({ error: "invalid_symbol_strategy_or_engines", strategies: STRATEGIES, engines: ENGINES }, 400);

  const now = Date.now(), inputs = await loadSignalInputs(env, symbol, strategy, url.searchParams.get("provider"), now);
  if ("error" in inputs) return reply({ decision: "DATA_UNRELIABLE", action: "HOLD", classification: "REJECTED", error: inputs.error, executionTimeframe: inputs.executionTimeframe, failures: inputs.failures, submitsOrder: false, liveExecutionAllowed: false }, 503);
  const { candles, depth, provider, failures } = inputs;
  const r = runOmnisignal({ symbol, strategy, candles, depth, now }, { enabledEngines: { swift: engines.includes("swift"), gainz: engines.includes("gainz") } });

  const price = candles[EXECUTION_TF[strategy]]!.at(-1)![4], actionable = r.decision === "BUY" || r.decision === "SELL";
  const liquidity = r.liquidity ?? analyzeLiquidity(depth, price, now);
  return reply({ ...r, liquidity,
    // Flat compatibility view of the same decision.
    action: actionable ? r.decision : "HOLD",
    classification: r.validation?.classification ?? (r.decision === "DATA_UNRELIABLE" ? "REJECTED" : "HOLD"),
    price, entry: r.entryZone ? (r.entryZone[0] + r.entryZone[1]) / 2 : null, riskReward: r.riskRewardToTP3, tradeable: actionable,
    consensus: (r.fusion.swift.details as { consensus?: unknown }).consensus ?? null, signalPath: "omnisignal: engines -> fusion -> independent validation",
    dataQuality: { provider, timeframesLoaded: Object.keys(candles), failures, orderBook: depth ? "rest_snapshot" : "unavailable", providerCrossCheck: "not_performed",
      note: "Single validated provider per request; cross-provider reconciliation is not performed and the REST order-book snapshot is timestamped at fetch time." },
    validationStatus: { expectancy: "unmeasured_until_replay_or_paper_results_are_recorded", accountRisk: "not_evaluated_by_analytical_endpoint" } });
}
