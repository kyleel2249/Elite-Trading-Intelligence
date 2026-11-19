/**
 * ETI Trading Intelligence & Behavioral Coach — deterministic analysis helpers.
 * Evidence-first; no order placement, wallet attribution or guaranteed forecasts.
 */

export type NullableNumber = number | null;
export type CandleRow = readonly unknown[];
export type DataRecord = Record<string, unknown>;

export interface BehaviorEvent extends DataRecord {
  type?: string;
  pnl?: unknown;
  at?: unknown;
  tags?: unknown;
  riskIncreased?: boolean;
  recoveryIntent?: boolean;
  chasedPrice?: boolean;
  unplanned?: boolean;
  ruleViolation?: boolean;
  exitBeforePlan?: boolean;
}

export interface BehaviorRules {
  cooldownMs?: number;
}

export interface StructureOptions {
  swingLookback?: number;
}

export interface TransactionRecord extends DataRecord {
  amount?: unknown;
  type?: unknown;
  category?: unknown;
  hash?: unknown;
  txHash?: unknown;
  chain?: unknown;
  network?: unknown;
  asset?: unknown;
  token?: unknown;
  from?: unknown;
  to?: unknown;
  timestamp?: unknown;
  at?: unknown;
  source?: unknown;
  verified?: unknown;
  entityName?: unknown;
  attributionConfidence?: unknown;
  attributionBasis?: unknown;
}

export interface SignalRecord extends DataRecord {
  direction?: unknown;
  side?: unknown;
}

export interface InstitutionalContext extends DataRecord {
  status?: unknown;
  summary?: unknown;
  events?: unknown[];
}

export interface TradePlan extends DataRecord {
  direction?: unknown;
  entry?: unknown;
  stop?: unknown;
  target?: unknown;
}

export interface CoachPayload {
  candles?: readonly CandleRow[];
  events?: readonly BehaviorEvent[];
  rules?: BehaviorRules;
  transactions?: readonly TransactionRecord[];
  institutional?: InstitutionalContext;
  signals?: readonly SignalRecord[];
  trade?: TradePlan;
}

export interface BehaviorFinding {
  type: string;
  severity: "high" | "moderate" | "low";
  confidence: number;
  at: number;
  reason: string;
}

export interface BehaviorScore {
  counts: {
    revenge: number;
    fomo: number;
    impulsive: number;
    overtrade: number;
    riskEscalation: number;
    planViolation: number;
    earlyExit: number;
  };
  findings: BehaviorFinding[];
  disciplineScore: number;
  observations: number;
  confidence: "low" | "moderate" | "higher";
  limitations: string[];
}

export interface StructureEvent extends DataRecord {
  type: string;
  direction?: string;
  level?: number;
  index?: number;
  reason?: string;
  lower?: number;
  upper?: number;
}

export interface StructureResult {
  status: "ok" | "insufficient_data";
  bars: number;
  events: StructureEvent[];
  note?: string;
  lastClose?: number;
  lastSwingHigh?: { type: "swing_high"; index: number; price: number } | null;
  lastSwingLow?: { type: "swing_low"; index: number; price: number } | null;
  trend?: string;
  method?: string;
}

export interface IndicatorResult {
  status: "ok" | "insufficient_data";
  count?: number;
  rsi14?: number;
  macdApprox?: number;
  macdSignalApprox?: number;
  macdHistogramApprox?: number;
  atr14?: number;
  volumeRatio?: number | null;
  sma20?: number;
  sma50?: number | null;
  close?: number;
  notes?: string[];
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

const num = (value: unknown): NullableNumber => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function validCandleRows(candles: readonly CandleRow[], limit: number): number[][] {
  return candles
    .filter((row): row is readonly unknown[] =>
      Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every(value => num(value) !== null))
    .slice(-limit)
    .map(row => row.slice(0, 6).map(value => num(value) as number));
}

export function scoreBehavior(events: readonly BehaviorEvent[] = [], rules: BehaviorRules = {}): BehaviorScore {
  const normalized = events
    .slice(-200)
    .map(event => ({ ...event, at: num(event.at) }))
    .filter((event): event is BehaviorEvent & { at: number } => event.at !== null)
    .sort((a, b) => a.at - b.at);

  const counts: BehaviorScore["counts"] = {
    revenge: 0, fomo: 0, impulsive: 0, overtrade: 0, riskEscalation: 0, planViolation: 0, earlyExit: 0
  };
  const findings: BehaviorFinding[] = [];
  const recentLoss = normalized
    .filter(event => event.type === "trade_close" && (num(event.pnl) ?? 0) < 0)
    .slice(-1)[0];
  const cooldown = num(rules.cooldownMs) ?? 45 * 60 * 1000;

  for (const event of normalized) {
    const tags = Array.isArray(event.tags) ? event.tags.map(String) : [];
    const lossNear = Boolean(
      recentLoss &&
      event.type === "trade_open" &&
      event.at >= recentLoss.at &&
      event.at - recentLoss.at <= cooldown
    );

    if (tags.includes("revenge") || event.recoveryIntent === true || (lossNear && event.riskIncreased === true)) {
      counts.revenge++;
      findings.push({ type: "revenge_risk", severity: "high", confidence: lossNear ? 0.7 : 0.85, at: event.at, reason: "Entry/re-entry is marked as recovery-driven or follows a loss with increased risk." });
    }
    if (tags.includes("fomo") || event.chasedPrice === true) {
      counts.fomo++;
      findings.push({ type: "fomo", severity: "moderate", confidence: 0.75, at: event.at, reason: "Entry was tagged as chasing price or FOMO." });
    }
    if (tags.includes("impulsive") || event.unplanned === true) {
      counts.impulsive++;
      findings.push({ type: "impulsive", severity: "moderate", confidence: 0.75, at: event.at, reason: "Trade was marked unplanned or impulsive." });
    }
    if (tags.includes("plan_violation") || event.ruleViolation === true) {
      counts.planViolation++;
      findings.push({ type: "plan_violation", severity: "high", confidence: 0.9, at: event.at, reason: "Recorded activity conflicts with a declared rule." });
    }
    if (event.type === "trade_open" && event.riskIncreased === true) {
      counts.riskEscalation++;
      findings.push({ type: "risk_escalation", severity: "high", confidence: 0.8, at: event.at, reason: "Trade risk/exposure was increased relative to baseline or plan." });
    }
    if (tags.includes("early_exit") || event.exitBeforePlan === true) {
      counts.earlyExit++;
      findings.push({ type: "early_exit", severity: "low", confidence: 0.7, at: event.at, reason: "Trade was recorded earlier than the plan; early exits can still be prudent if evidence changed." });
    }
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    counts,
    findings,
    disciplineScore: clamp(100 - total * 8, 0, 100),
    observations: normalized.length,
    confidence: normalized.length < 10 ? "low" : normalized.length < 30 ? "moderate" : "higher",
    limitations: [
      "Behavioral classifications depend on recorded tags and fields; timestamps alone cannot reliably infer emotions or motives.",
      "Sample size and context affect confidence."
    ]
  };
}

export function analyzeStructure(candles: readonly CandleRow[] = [], options: StructureOptions = {}): StructureResult {
  const rows = validCandleRows(candles, 500);
  if (rows.length < 8) {
    return { status: "insufficient_data", bars: rows.length, events: [], note: "At least eight valid OHLCV candles are needed for this basic structure pass." };
  }

  const events: StructureEvent[] = [];
  const look = Math.min(20, Math.max(3, Math.floor(num(options.swingLookback) ?? 5)));
  const swings: Array<{ type: "swing_high"; index: number; price: number } | { type: "swing_low"; index: number; price: number }> = [];

  for (let index = look; index < rows.length - look; index++) {
    const high = rows[index][2], low = rows[index][3];
    if (rows.slice(index - look, index).every(row => row[2] < high) && rows.slice(index + 1, index + look + 1).every(row => row[2] <= high)) {
      swings.push({ type: "swing_high", index, price: high });
    }
    if (rows.slice(index - look, index).every(row => row[3] > low) && rows.slice(index + 1, index + look + 1).every(row => row[3] >= low)) {
      swings.push({ type: "swing_low", index, price: low });
    }
  }

  const latest = rows[rows.length - 1];
  const close = latest[4];
  const highs = swings.filter(swing => swing.type === "swing_high");
  const lows = swings.filter(swing => swing.type === "swing_low");
  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];

  if (lastHigh && close > lastHigh.price) events.push({ type: "BOS", direction: "bullish", level: lastHigh.price, index: rows.length - 1, reason: "Latest close exceeded the last confirmed swing high." });
  if (lastLow && close < lastLow.price) events.push({ type: "BOS", direction: "bearish", level: lastLow.price, index: rows.length - 1, reason: "Latest close fell below the last confirmed swing low." });
  if (lastHigh && latest[2] > lastHigh.price && close < lastHigh.price) events.push({ type: "liquidity_sweep", direction: "bearish", level: lastHigh.price, reason: "Wick exceeded swing high and closed back below; confirmation remains candle-based." });
  if (lastLow && latest[3] < lastLow.price && close > lastLow.price) events.push({ type: "liquidity_sweep", direction: "bullish", level: lastLow.price, reason: "Wick fell below swing low and closed back above." });

  for (let index = 2; index < rows.length; index++) {
    if (rows[index][3] > rows[index - 2][2]) events.push({ type: "FVG", direction: "bullish", lower: rows[index - 2][2], upper: rows[index][3], index });
    if (rows[index][2] < rows[index - 2][3]) events.push({ type: "FVG", direction: "bearish", lower: rows[index][2], upper: rows[index - 2][3], index });
  }

  const trend = lastHigh && lastLow
    ? close > lastHigh.price ? "bullish_break" : close < lastLow.price ? "bearish_break" : "range/inside"
    : "undetermined";

  return {
    status: "ok",
    bars: rows.length,
    lastClose: close,
    lastSwingHigh: lastHigh ?? null,
    lastSwingLow: lastLow ?? null,
    trend,
    events: events.slice(-10),
    method: "Basic swing/BOS/sweep/FVG heuristic; not a substitute for ETI multi-timeframe or Institutional Market Intelligence."
  };
}

export function analyzeIndicators(candles: readonly CandleRow[] = []): IndicatorResult {
  const rows = validCandleRows(candles, 250);
  const closes = rows.map(row => row[4]);
  if (closes.length < 30) return { status: "insufficient_data", count: closes.length };

  const average = (values: readonly number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const sma = (period: number): number => average(closes.slice(-period));
  const changes = closes.slice(1).map((value, index) => value - closes[index]);
  const recentChanges = changes.slice(-14);
  const gains = recentChanges.map(change => Math.max(change, 0));
  const losses = recentChanges.map(change => Math.max(-change, 0));
  const averageGain = average(gains), averageLoss = average(losses);
  const rs = averageLoss === 0 ? (averageGain === 0 ? 0 : Infinity) : averageGain / averageLoss;
  const rsi = averageGain === 0 && averageLoss === 0 ? 50 : 100 - 100 / (1 + rs);

  const ema = (values: readonly number[], period: number): number[] => {
    const multiplier = 2 / (period + 1);
    const output: number[] = [];
    let previous: number | null = null;
    for (const value of values) {
      previous = previous === null ? value : value * multiplier + previous * (1 - multiplier);
      output.push(previous);
    }
    return output;
  };

  const fast = ema(closes, 12), slow = ema(closes, 26);
  const macdSeries = fast.map((value, index) => value - slow[index]);
  const signalSeries = ema(macdSeries, 9);
  const macd = macdSeries[macdSeries.length - 1];
  const signal = signalSeries[signalSeries.length - 1];
  const histogram = macd - signal;
  const recentRows = rows.slice(-14);
  const tr = recentRows.map((row, index) => {
    if (index === 0) return row[2] - row[3];
    const previousClose = recentRows[index - 1][4];
    return Math.max(row[2] - row[3], Math.abs(row[2] - previousClose), Math.abs(row[3] - previousClose));
  });
  const atr = average(tr);
  const volumeAverage = average(rows.slice(-20).map(row => row[5]));
  const volume = rows[rows.length - 1][5];
  const volumeRatio = volumeAverage ? volume / volumeAverage : null;

  return {
    status: "ok",
    rsi14: Number(rsi.toFixed(2)),
    macdApprox: Number(macd.toPrecision(8)),
    macdSignalApprox: Number(signal.toPrecision(8)),
    macdHistogramApprox: Number(histogram.toPrecision(8)),
    atr14: Number(atr.toPrecision(8)),
    volumeRatio: volumeRatio === null ? null : Number(volumeRatio.toFixed(3)),
    sma20: Number(sma(20).toPrecision(8)),
    sma50: closes.length >= 50 ? Number(sma(50).toPrecision(8)) : null,
    close: closes[closes.length - 1],
    notes: [
      "Approximate compact calculations for coach display only; ETI's existing indicator modules are authoritative.",
      "This RSI/MACD approximation is not the canonical ETI indicator implementation."
    ]
  };
}

export function classifyTransaction(transaction: TransactionRecord = {}) {
  const amount = num(transaction.amount);
  const type = String(transaction.type || transaction.category || "unknown").toLowerCase();
  const labels: Record<string, string> = {
    transfer: "Wallet transfer",
    exchange_deposit: "Exchange deposit",
    exchange_withdrawal: "Exchange withdrawal",
    swap: "Token swap",
    bridge: "Cross-chain bridge",
    mint: "Token mint",
    burn: "Token burn",
    staking: "Staking",
    unstaking: "Unstaking",
    liquidation: "Liquidation",
    borrow: "Borrow",
    repay: "Repayment",
    approval: "Token approval",
    contract_interaction: "Smart-contract interaction",
    unknown: "Unclassified transaction"
  };
  const category = labels[type] ?? labels.unknown;
  return {
    hash: transaction.hash || transaction.txHash || null,
    chain: transaction.chain || transaction.network || "unknown",
    asset: transaction.asset || transaction.token || "unknown",
    amount,
    category,
    type,
    from: transaction.from || null,
    to: transaction.to || null,
    timestamp: num(transaction.timestamp || transaction.at),
    source: transaction.source || "user-provided",
    verified: transaction.verified === true,
    attribution: transaction.entityName
      ? { entity: transaction.entityName, confidence: clamp(num(transaction.attributionConfidence) ?? 0, 0, 1), basis: transaction.attributionBasis || "unverified label" }
      : null,
    interpretation: category === "Token approval"
      ? "Approval grants a contract allowance; it is not proof that tokens were transferred."
      : category === "Cross-chain bridge"
        ? "Bridge activity can imply cross-chain movement; source/destination matching is needed to avoid double-counting."
        : category === "Wallet transfer"
          ? "A transfer alone does not establish buying or selling pressure."
          : "Transaction classification is descriptive; market impact requires additional flow, price and context data."
  };
}

export function assessCoach(payload: CoachPayload = {}) {
  const candles = payload.candles ?? [];
  const structure = analyzeStructure(candles);
  const indicators = analyzeIndicators(candles);
  const behavior = scoreBehavior(payload.events ?? [], payload.rules ?? {});
  const transactions = (payload.transactions ?? []).slice(-200).map(classifyTransaction);
  const institutional = payload.institutional ?? {};
  const signals = payload.signals ?? [];
  const trade = payload.trade ?? {};
  const confirmations: string[] = [], conflicts: string[] = [], warnings: string[] = [];

  if (structure.status === "ok") confirmations.push(...structure.events.map(event => event.type + (event.direction ? " " + event.direction : "")));
  if (indicators.status === "ok") {
    if (indicators.rsi14! < 30) confirmations.push("RSI oversold");
    if (indicators.rsi14! > 70) confirmations.push("RSI overbought");
    if (indicators.macdHistogramApprox! > 0) confirmations.push("MACD momentum positive");
    else confirmations.push("MACD momentum negative");
  }
  if (institutional.status === "unavailable" || institutional.status === "missing") warnings.push("Institutional Market Intelligence unavailable; institutional context cannot be confirmed.");
  if (!signals.length) warnings.push("No ETI signals supplied. This assessment is not an ETI-wide signal consensus.");

  const direction = String(trade.direction ?? "").toLowerCase();
  const entry = num(trade.entry), stop = num(trade.stop), target = num(trade.target);
  const riskReward = entry !== null && stop !== null && target !== null && Math.abs(entry - stop) > 0
    ? Math.abs(target - entry) / Math.abs(entry - stop)
    : null;
  if (entry !== null && stop !== null && target !== null) {
    const valid = direction === "long" ? stop < entry && target > entry : direction === "short" ? stop > entry && target < entry : false;
    if (!valid) conflicts.push("Entry/stop/target levels do not fit the selected trade direction.");
  }

  const directionEvidence = structure.events.filter(event => event.direction === direction);
  const signalEvidence = signals.filter(signal => String(signal.direction ?? signal.side ?? "").toLowerCase() === direction);
  if (direction && directionEvidence.length === 0) warnings.push("Structure does not provide a matching direction confirmation in this simplified pass.");
  if (direction && signalEvidence.length === 0) warnings.push("No supplied ETI signal aligns with the proposed direction.");
  if (riskReward !== null && riskReward < 1.5) warnings.push("Proposed risk/reward is below the coach's configurable default 1.5:1 review threshold.");

  const decision = conflicts.length
    ? "REJECT / REASSESS"
    : warnings.length >= 3
      ? "WAIT / INSUFFICIENT CONFLUENCE"
      : warnings.length
        ? "CAUTION / WAIT FOR CONFIRMATION"
        : "CONFLUENCE REVIEW PASSED";

  return {
    timestamp: new Date().toISOString(),
    decision,
    marketStructure: structure,
    indicators,
    behavior,
    institutionalMarketIntelligence: {
      status: institutional.status || "not_supplied",
      summary: institutional.summary || null,
      events: institutional.events || [],
      limitations: ["Institutional activity attribution and intent must be sourced and independently validated."]
    },
    transactionFlow: { count: transactions.length, transactions },
    signals: signals.slice(0, 30),
    tradePlanReview: {
      direction: direction || "not specified",
      entry,
      stop,
      target,
      riskReward,
      validLevels: !conflicts.length,
      conflicts
    },
    confluence: {
      confirmations,
      warnings,
      conflicts,
      score: clamp(confirmations.length * 12 - warnings.length * 10 - conflicts.length * 25, 0, 100)
    },
    recommendation: conflicts.length
      ? "Do not use these invalid levels. Recalculate the plan."
      : warnings.length
        ? "Wait for fresh, aligned evidence; review the market data and ETI signal gates before entry."
        : "Evidence is aligned in this submitted snapshot. Still validate risk, execution conditions and stop before placing an order.",
    forecastDisclaimer: "Forecasts are probabilistic; this coach cannot guarantee profitable or successful trades. This assessment is informational and never executes orders."
  };
}
