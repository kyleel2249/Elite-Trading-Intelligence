// GET /api/algo/signal?symbol=BTCUSDT&strategy=intraday&engines=swift,gainz
// There is ONE signal path in ETI: engines -> fusion -> independent validation, served at /api/omnisignal with the promoted champion
// parameters, the cost model, measured expectancy and the optional journal. This route calls that handler itself and only DECORATES
// its answer with the EARLY / CONFIRMED / HIGH_CONVICTION class and flat trade-plan fields, so the two can never drift apart.
import type { MarketEnv } from "../market.ts";
import { handleOmnisignal } from "./omni-api.ts";

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function handleAlgoSignal(req: Request, env: MarketEnv): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/algo/signal" || req.method !== "GET") return reply({ error: "not_found" }, 404);
  const inner = new URL(url); inner.pathname = "/api/omnisignal";
  const res = await handleOmnisignal(new Request(inner, { method: "GET" }), env), r = await res.json() as Record<string, any>;
  if (res.status !== 200) return reply({ ...r, action: "HOLD", classification: "REJECTED", liveExecutionAllowed: false, submitsOrder: false }, res.status);
  const actionable = r.decision === "BUY" || r.decision === "SELL";
  return reply({ ...r,
    // Flat compatibility view of the same decision.
    action: actionable ? r.decision : "HOLD",
    classification: r.validation?.classification ?? (r.decision === "DATA_UNRELIABLE" ? "REJECTED" : "HOLD"),
    entry: r.entryZone ? (r.entryZone[0] + r.entryZone[1]) / 2 : null, riskReward: r.riskRewardToTP3 ?? null, tradeable: actionable,
    signalPath: "omnisignal: engines -> fusion -> independent validation" });
}
