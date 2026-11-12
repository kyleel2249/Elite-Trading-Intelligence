/**
 * Profit and leverage calculator (pure arithmetic: no network, no orders, no stored state).
 * One function, `computePosition`, is used by the unit tests and is also embedded verbatim in the dashboard script
 * (via Function.prototype.toString), so it must stay self-contained: no imports, no outside references, no backticks,
 * no template holes and no backslashes.
 *
 * Model (linear contracts, isolated margin): units = quantity * contractSize; notional = units * price * fxRate;
 * margin = notional / leverage; fees are charged per side on notional at that side's price; the liquidation price is
 * the standard estimate entry * (1 -/+ 1/leverage +/- maintenance margin rate). Liquidation is an ESTIMATE: the venue's
 * own risk engine (tiers, cross margin, funding, mark price) decides. Inverse contracts are not modelled.
 */
export interface CalcInput {
  side: "buy" | "sell"; entry: number; exit?: number | null; stop?: number | null;
  sizeBy?: "quantity" | "margin"; quantity?: number; margin?: number; leverage: number;
  feePct?: number; slippagePct?: number; fundingPct?: number; mmrPct?: number; contractSize?: number; fxRate?: number; targetProfit?: number | null;
}
export type CalcResult = { ok: false; errors: string[] } | { ok: true; [k: string]: any };

export function computePosition(i: CalcInput): CalcResult {
  const num = (v: any) => (v === null || v === undefined || v === "" ? NaN : Number(v));
  const errors: string[] = [], warnings: string[] = [];
  const dir = i.side === "buy" ? 1 : i.side === "sell" ? -1 : 0;
  const entry = num(i.entry), lev = num(i.leverage), sizeBy = i.sizeBy === "margin" ? "margin" : "quantity";
  const feePct = i.feePct === undefined || i.feePct === null ? 0.05 : num(i.feePct), slipPct = i.slippagePct === undefined || i.slippagePct === null ? 0 : num(i.slippagePct);
  const fundPct = i.fundingPct === undefined || i.fundingPct === null ? 0 : num(i.fundingPct), mmrPct = i.mmrPct === undefined || i.mmrPct === null ? 0.5 : num(i.mmrPct);
  const cs = i.contractSize === undefined || i.contractSize === null ? 1 : num(i.contractSize), fx = i.fxRate === undefined || i.fxRate === null ? 1 : num(i.fxRate);
  const exit = num(i.exit), stop = num(i.stop), tp = num(i.targetProfit);
  if (!dir) errors.push("Choose Long or Short.");
  if (!(entry > 0) || !isFinite(entry)) errors.push("Entry price must be greater than zero.");
  if (!(lev >= 1 && lev <= 150) || !isFinite(lev)) errors.push("Leverage must be between 1x and 150x.");
  if (!(feePct >= 0 && feePct <= 5)) errors.push("Fee must be between 0% and 5% per side.");
  if (!(slipPct >= 0 && slipPct <= 5)) errors.push("Slippage must be between 0% and 5% per side.");
  if (!(fundPct >= -50 && fundPct <= 50)) errors.push("Funding / financing must be between -50% and 50% of notional.");
  if (!(mmrPct >= 0 && mmrPct <= 50)) errors.push("Maintenance margin must be between 0% and 50%.");
  if (!(cs > 0) || !isFinite(cs)) errors.push("Contract size must be greater than zero.");
  if (!(fx > 0) || !isFinite(fx)) errors.push("Quote-to-account rate must be greater than zero.");
  if (i.exit !== undefined && i.exit !== null && String(i.exit) !== "" && !(exit > 0)) errors.push("Exit price must be greater than zero.");
  if (i.stop !== undefined && i.stop !== null && String(i.stop) !== "" && !(stop > 0)) errors.push("Stop price must be greater than zero.");
  const sizeRaw = sizeBy === "margin" ? num(i.margin) : num(i.quantity);
  if (!(sizeRaw > 0) || !isFinite(sizeRaw)) errors.push(sizeBy === "margin" ? "Margin must be greater than zero." : "Quantity must be greater than zero.");
  if (errors.length) return { ok: false, errors };

  const f = (feePct + slipPct) / 100, mmr = mmrPct / 100, fund = fundPct / 100;
  const units = sizeBy === "margin" ? (sizeRaw * lev) / (entry * fx) : sizeRaw * cs;
  const quantity = sizeBy === "margin" ? units / cs : sizeRaw;
  const notional = units * entry * fx, margin = notional / lev;
  const fundingCost = fund * notional;
  const liqOf = (L: number) => {
    if (dir === 1 && L === 1) return null; // an unleveraged long cannot be liquidated
    const p = entry * (1 - dir * (1 / L - mmr));
    return p > 0 ? p : null;
  };
  const immediate = (L: number) => 1 / L <= mmr; // maintenance margin at least equals initial margin: liquidated on entry
  const pnlAt = (px: number) => {
    const gross = dir * (px - entry) * units * fx, fees = f * units * fx * (entry + px), net = gross - fees - fundingCost;
    return { price: px, gross, fees, funding: fundingCost, net, roiPct: (net / margin) * 100, movePct: ((px - entry) / entry) * 100 };
  };
  const breakEvenFor = (P: number) => dir === 1 ? (entry * (1 + f) + (P + fundingCost) / (units * fx)) / (1 - f) : (entry * (1 - f) - (P + fundingCost) / (units * fx)) / (1 + f);
  if (immediate(lev)) errors.push("At " + lev + "x with a " + mmrPct + "% maintenance margin the position would be liquidated at entry. Lower the leverage.");
  const liq = immediate(lev) ? null : liqOf(lev);
  const liqDistancePct = liq === null ? null : (Math.abs(entry - liq) / entry) * 100;
  const out: any = { ok: !errors.length, errors, warnings, units, quantity, notional, margin, effectiveLeverage: notional / margin, fundingCost, feePerSidePct: f * 100,
    liquidation: liq, liquidationDistancePct: liqDistancePct, breakEven: breakEvenFor(0), target: null, stopResult: null, riskReward: null, priceForTargetProfit: null, ladder: [] };
  if (errors.length) return out;
  if (exit > 0) {
    out.target = pnlAt(exit);
    if (dir * (exit - entry) < 0) warnings.push("Exit is on the losing side of entry for a " + (dir === 1 ? "long" : "short") + ".");
    if (liq !== null && dir * (exit - liq) <= 0) warnings.push("Exit is beyond the estimated liquidation price: the position would be liquidated first and the loss is capped at the margin.");
  }
  if (stop > 0) {
    if (dir * (stop - entry) >= 0) warnings.push("Stop is on the wrong side of entry for a " + (dir === 1 ? "long" : "short") + " and was ignored.");
    else {
      out.stopResult = pnlAt(stop);
      if (liq !== null && dir * (stop - liq) <= 0) warnings.push("Stop is beyond the estimated liquidation price: liquidation would trigger first, so the stop would not protect you.");
      if (exit > 0 && dir * (exit - entry) > 0) out.riskReward = Math.abs(exit - entry) / Math.abs(entry - stop);
    }
  }
  if (tp > 0) out.priceForTargetProfit = breakEvenFor(tp);
  if (liqDistancePct !== null && liqDistancePct < 5) warnings.push("Liquidation is only " + liqDistancePct.toFixed(2) + "% away: a normal intraday move could close this position.");
  if (lev > 20) warnings.push("Leverage above 20x leaves very little room for adverse moves; most venues also cap leverage per instrument and position size.");
  for (const L of [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125]) {
    const m = notional / L, imm = immediate(L), lq = imm ? null : liqOf(L);
    const net = exit > 0 ? pnlAt(exit).net : null;
    out.ladder.push({ leverage: L, margin: m, liquidation: lq, liquidationDistancePct: lq === null ? null : (Math.abs(entry - lq) / entry) * 100, immediate: imm, net, roiPct: net === null ? null : (net / m) * 100 });
  }
  return out;
}
