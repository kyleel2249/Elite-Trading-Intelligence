// Profit / leverage calculator for USDT-margined linear contracts (isolated margin). Pure, deterministic, read-only: it never
// places an order. Every figure is an ESTIMATE from the stated inputs: liquidation ignores fees paid, funding accrued and the
// exchange's tiered maintenance-margin schedule, so always confirm with the exchange's own calculator before relying on it.
export type Side = "long" | "short";
export interface CalcInput {
  side: Side; entry: number; target?: number; stop?: number; leverage: number; sizeBy: "margin" | "quantity" | "risk";
  margin?: number; quantity?: number; balance?: number; riskPct?: number;
  takerFeeBps?: number; maintenanceMarginPct?: number; fundingRatePct?: number; fundingIntervals?: number;
}
export interface Outcome { price: number; movePct: number; grossPnl: number; fees: number; funding: number; netPnl: number; roiOnMarginPct: number; returnOnBalancePct: number | null }
export interface CalcOk {
  ok: true; side: Side;
  position: { quantity: number; notional: number; margin: number; leverage: number; marginToBalancePct: number | null };
  fees: { entry: number; roundTripAtEntry: number; bps: number };
  breakEven: number; liquidation: { price: number; distancePct: number; estimate: true; assumptions: string };
  atTarget: Outcome | null; atStop: Outcome | null; rewardRisk: number | null; warnings: string[];
}
export interface CalcErr { ok: false; errors: string[] }
export const MAX_LEVERAGE = 150;
const r8 = (v: number) => Math.round(v * 1e8) / 1e8, r2 = (v: number) => Math.round(v * 100) / 100, fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function calculate(i: CalcInput): CalcOk | CalcErr {
  const errors: string[] = [], side = i.side, fee = (i.takerFeeBps ?? 5) / 1e4, mmr = (i.maintenanceMarginPct ?? 0.5) / 100;
  if (side !== "long" && side !== "short") errors.push("side must be long or short");
  if (!fin(i.entry) || i.entry <= 0) errors.push("entry must be a positive number");
  if (!fin(i.leverage) || i.leverage < 1 || i.leverage > MAX_LEVERAGE) errors.push(`leverage must be between 1 and ${MAX_LEVERAGE}`);
  if (!["margin", "quantity", "risk"].includes(i.sizeBy)) errors.push("sizeBy must be margin, quantity or risk");
  if (!(fee >= 0 && fee < 0.01)) errors.push("takerFeeBps must be between 0 and 100");
  if (!(mmr > 0 && mmr < 0.5)) errors.push("maintenanceMarginPct must be between 0 and 50");
  for (const [k, v] of [["target", i.target], ["stop", i.stop]] as const) if (v !== undefined && (!fin(v) || v <= 0)) errors.push(`${k} must be a positive number`);
  if (errors.length) return { ok: false, errors };
  const long = side === "long", dir = long ? 1 : -1;
  if (i.target !== undefined && (i.target - i.entry) * dir <= 0) errors.push(`target must be ${long ? "above" : "below"} the entry for a ${side}`);
  if (i.stop !== undefined && (i.entry - i.stop) * dir <= 0) errors.push(`stop must be ${long ? "below" : "above"} the entry for a ${side}`);
  const funding = (fin(i.fundingRatePct) ? i.fundingRatePct : 0) / 100 * (fin(i.fundingIntervals) ? Math.max(0, i.fundingIntervals) : 0);
  let qty = NaN;
  if (i.sizeBy === "quantity") { if (!fin(i.quantity) || i.quantity <= 0) errors.push("quantity must be a positive number"); else qty = i.quantity; }
  else if (i.sizeBy === "margin") { if (!fin(i.margin) || i.margin <= 0) errors.push("margin must be a positive number"); else qty = (i.margin * i.leverage) / i.entry; }
  else {
    if (!fin(i.balance) || i.balance <= 0) errors.push("balance must be a positive number");
    if (!fin(i.riskPct) || i.riskPct <= 0 || i.riskPct > 100) errors.push("riskPct must be between 0 and 100");
    if (i.stop === undefined) errors.push("a stop price is required to size by risk");
    if (!errors.length) { const perUnit = Math.abs(i.entry - i.stop!) + i.entry * fee + i.stop! * fee; qty = (i.balance! * i.riskPct! / 100) / perUnit; }
  }
  if (errors.length) return { ok: false, errors };
  const notional = qty * i.entry, margin = notional / i.leverage, warnings: string[] = [];
  const liq = long ? i.entry * (1 - 1 / i.leverage + mmr) : i.entry * (1 + 1 / i.leverage - mmr);
  const outcome = (price: number): Outcome => {
    const gross = qty * (price - i.entry) * dir, fees = notional * fee + qty * price * fee, fund = notional * funding * dir, net = gross - fees - fund;
    return { price: r8(price), movePct: r2((price - i.entry) / i.entry * 100), grossPnl: r2(gross), fees: r2(fees), funding: r2(fund), netPnl: r2(net), roiOnMarginPct: r2(net / margin * 100), returnOnBalancePct: fin(i.balance) && i.balance > 0 ? r2(net / i.balance * 100) : null };
  };
  const atTarget = i.target !== undefined ? outcome(i.target) : null, atStop = i.stop !== undefined ? outcome(i.stop) : null;
  const rewardRisk = atTarget && atStop && atStop.netPnl < 0 ? r2(atTarget.netPnl / -atStop.netPnl) : null;
  if (i.leverage > 20) warnings.push(`${i.leverage}x leverage: a ${r2(100 / i.leverage)}% adverse move wipes out the margin. Very small moves liquidate the position.`);
  if (i.stop !== undefined && (long ? i.stop <= liq : i.stop >= liq)) warnings.push("The stop is at or beyond the estimated liquidation price, so the position would be liquidated before the stop can protect it.");
  if (fin(i.balance) && margin > i.balance) warnings.push(`Required margin ${r2(margin)} exceeds the stated balance ${r2(i.balance)}.`);
  if (rewardRisk !== null && rewardRisk < 1) warnings.push(`Net reward/risk is ${rewardRisk} (below 1): the target pays less than the stop costs.`);
  if (atTarget && atTarget.grossPnl > 0 && atTarget.fees / atTarget.grossPnl > 0.2) warnings.push("Fees take more than 20% of the gross profit at the target.");
  if (liq <= 0) warnings.push("At this leverage a long is not liquidated by price alone (estimate); the margin is still at risk from funding and fees.");
  warnings.push("Estimates only: liquidation ignores fees paid, funding accrued and tiered maintenance margins. Confirm with the exchange's calculator. Leverage magnifies losses as well as profits.");
  return {
    ok: true, side,
    position: { quantity: r8(qty), notional: r2(notional), margin: r2(margin), leverage: i.leverage, marginToBalancePct: fin(i.balance) && i.balance > 0 ? r2(margin / i.balance * 100) : null },
    fees: { entry: r2(notional * fee), roundTripAtEntry: r2(2 * notional * fee), bps: fee * 1e4 },
    breakEven: r8(long ? i.entry * (1 + fee) / (1 - fee) : i.entry * (1 - fee) / (1 + fee)),
    liquidation: { price: r8(Math.max(0, liq)), distancePct: r2((liq - i.entry) / i.entry * 100), estimate: true, assumptions: `isolated margin, linear USDT contract, maintenance margin ${r2(mmr * 100)}%, no fees/funding/tiers` },
    atTarget, atStop, rewardRisk, warnings,
  };
}

const n = (v: string | null) => (v === null || v === "" ? undefined : Number(v));
/** GET ?side=long&entry=60000&target=63000&stop=59000&leverage=10&sizeBy=margin&margin=1000 or POST the same fields as JSON. */
export async function handleCalc(req: Request): Promise<Response> {
  const h = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: h });
  const url = new URL(req.url);
  if (url.pathname !== "/api/calc/position") return reply({ error: "not_found" }, 404);
  let raw: Record<string, unknown>;
  if (req.method === "GET") { const q = url.searchParams; raw = { side: q.get("side"), entry: n(q.get("entry")), target: n(q.get("target")), stop: n(q.get("stop")), leverage: n(q.get("leverage")), sizeBy: q.get("sizeBy") ?? "margin", margin: n(q.get("margin")), quantity: n(q.get("quantity")), balance: n(q.get("balance")), riskPct: n(q.get("riskPct")), takerFeeBps: n(q.get("takerFeeBps")), maintenanceMarginPct: n(q.get("maintenanceMarginPct")), fundingRatePct: n(q.get("fundingRatePct")), fundingIntervals: n(q.get("fundingIntervals")) }; }
  else if (req.method === "POST") { try { raw = (await req.json()) as Record<string, unknown>; } catch { return reply({ ok: false, errors: ["body must be JSON"] }, 400); } }
  else return reply({ error: "method_not_allowed" }, 405);
  const r = calculate(raw as unknown as CalcInput);
  return reply({ ...r, submitsOrder: false }, r.ok ? 200 : 400);
}
