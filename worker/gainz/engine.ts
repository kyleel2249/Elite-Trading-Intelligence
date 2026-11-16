import type { Kline } from "../market.ts";

export type GainzEngine = "gainz_v2" | "gainz_v2_alpha";
export type Direction = "BUY" | "SELL";
export type SignalState = "received" | "validated" | "rejected" | "expired";

export interface NormalizedGainzSignal {
  id: string; engine: GainzEngine; preset: string; symbol: string; exchange: string;
  market: "spot" | "futures"; direction: Direction; timeframe: string;
  signalTimestamp: number; receivedAt: number; entry: number | null; stopLoss: number | null;
  targets: number[]; state: SignalState; reasons: string[]; rewardRisk: number | null;
  score: number; consensus: "single_engine" | "agreement" | "conflict"; consensusScore: number;
  payload: Record<string, unknown>;
}
const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
export function normalizeEngine(v: unknown): GainzEngine | null {
  const s = String(v ?? "").toLowerCase().replace(/[\s.-]/g, "_");
  if (["gainz_v2", "gainzalgo_v2", "gainz_algo_v2", "v2", "standard"].includes(s)) return "gainz_v2";
  if (["gainz_v2_alpha", "gainzalgo_v2_alpha", "gainz_algo_v2_alpha", "v2_alpha", "alpha"].includes(s)) return "gainz_v2_alpha";
  return null;
}
export function parseSignal(input: unknown, now = Date.now(), maxAgeSeconds = 86400): NormalizedGainzSignal | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const engine = normalizeEngine(p.engine ?? p.indicator ?? p.source);
  const symbol = String(p.symbol ?? p.ticker ?? "").trim().toUpperCase().replace(/[\s/_-]/g, "");
  const direction = String(p.direction ?? p.signal ?? p.action ?? "").trim().toUpperCase();
  const timeframe = String(p.timeframe ?? p.interval ?? "").trim().toLowerCase();
  const exchange = String(p.exchange ?? p.venue ?? "unknown").trim().toLowerCase().slice(0, 40);
  const market = String(p.market ?? p.marketType ?? "spot").toLowerCase() === "futures" ? "futures" : "spot";
  const rawTime = p.signalTimestamp ?? p.timestamp ?? p.time ?? p.createdAt;
  const parsedTime = typeof rawTime === "string" && !/^\d+(\.\d+)?$/.test(rawTime) ? Date.parse(rawTime) : Number(rawTime);
  const signalTimestamp = Number.isFinite(parsedTime) ? (parsedTime < 1e12 ? parsedTime * 1000 : parsedTime) : now;
  const entry = finite(p.entry ?? p.entryPrice ?? p.price);
  const stopLoss = finite(p.stopLoss ?? p.stop_loss ?? p.sl);
  const rawTargets = Array.isArray(p.targets) ? p.targets : [];
  const targets = [p.tp1 ?? p.takeProfit1 ?? rawTargets[0], p.tp2 ?? p.takeProfit2 ?? rawTargets[1], p.tp3 ?? p.takeProfit3 ?? rawTargets[2]]
    .map(finite).filter((n): n is number => n !== null).slice(0, 3);
  if (!engine || !/^[A-Z0-9]{5,24}$/.test(symbol) || !["BUY", "SELL"].includes(direction) ||
      !/^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/i.test(timeframe) ||
      !Number.isFinite(signalTimestamp) || signalTimestamp > now + 300_000) return null;
  const age = Math.max(0, (now - signalTimestamp) / 1000);
  const reasons: string[] = [];
  let state: SignalState = "received";
  if (age > maxAgeSeconds) { state = "expired"; reasons.push("Signal exceeds the configured maximum age"); }
  if (!entry || !stopLoss || !targets.length) { state = "rejected"; reasons.push("Entry, stop-loss and at least one take-profit are required for validation"); }
  let rewardRisk: number | null = null;
  if (entry && stopLoss && targets.length) {
    const risk = direction === "BUY" ? entry - stopLoss : stopLoss - entry;
    const reward = direction === "BUY" ? targets[0] - entry : entry - targets[0];
    if (!(risk > 0)) { state = "rejected"; reasons.push("Stop-loss is on the wrong side of entry"); }
    else if (!(reward > 0)) { state = "rejected"; reasons.push("Take-profit is on the wrong side of entry"); }
    else rewardRisk = reward / risk;
  }
  if (state === "received") state = "validated";
  const idInput = String(p.signalId ?? p.id ?? "").trim();
  const id = idInput && /^[A-Za-z0-9_.:-]{1,120}$/.test(idInput)
    ? idInput
    : [engine, symbol, timeframe, direction, Math.floor(signalTimestamp)].join(":");
  const preset = String(p.preset ?? (engine === "gainz_v2_alpha" ? "alpha" : "unspecified")).toLowerCase().slice(0, 40);
  const score = rewardRisk === null ? 0 : Math.max(0, Math.min(100, Math.round(60 + Math.min(40, rewardRisk * 10))));
  return { id, engine, preset, symbol, exchange, market, direction: direction as Direction, timeframe,
    signalTimestamp, receivedAt: now, entry, stopLoss, targets, state, reasons, rewardRisk, score,
    consensus: "single_engine", consensusScore: score, payload: p };
}
export function evaluateConsensus(current: NormalizedGainzSignal, peer: { engine: string; direction: string; signal_timestamp: number } | null): Pick<NormalizedGainzSignal, "consensus" | "consensusScore"> {
  if (!peer || peer.engine === current.engine || Math.abs(current.signalTimestamp - peer.signal_timestamp) > 900_000)
    return { consensus: "single_engine", consensusScore: current.score };
  if (peer.direction !== current.direction) return { consensus: "conflict", consensusScore: 0 };
  return { consensus: "agreement", consensusScore: Math.min(100, Math.round((current.score + 80) / 2)) };
}
export function independentMarketAssessment(rows: Kline[]) {
  const n = rows.length;
  if (n < 210) return { status: "insufficient_history", candles: n, action: "WAIT", score: 0, indicators: null, evidence: ["At least 210 validated candles are required"] };
  const close = rows.map(r => r[4]), volume = rows.map(r => r[5]);
  const ema = (period: number) => {
    const k = 2 / (period + 1); let v = close[0];
    for (let i = 1; i < close.length; i++) v = close[i] * k + v * (1 - k);
    return v;
  };
  const ema20 = ema(20), ema50 = ema(50), ema200 = ema(200);
  const gains: number[] = [], losses: number[] = [];
  for (let i = Math.max(1, n - 14); i < n; i++) { const d = close[i] - close[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
  const avgGain = gains.reduce((a,b)=>a+b,0) / 14, avgLoss = losses.reduce((a,b)=>a+b,0) / 14;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  const tr = rows.slice(-15).slice(1).map((r,i)=>Math.max(r[2]-r[3],Math.abs(r[2]-rows.slice(-15)[i][4]),Math.abs(r[3]-rows.slice(-15)[i][4])));
  const atr = tr.reduce((a,b)=>a+b,0) / Math.max(1,tr.length);
  const vbase = volume.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
  const volumeRatio = vbase > 0 ? volume[n-1]/vbase : 0;
  const bullish = close[n-1] > ema20 && ema20 > ema50 && ema50 > ema200;
  const bearish = close[n-1] < ema20 && ema20 < ema50 && ema50 < ema200;
  const score = (bullish ? 35 : bearish ? -35 : 0) + (rsi > 52 && rsi < 70 ? 20 : rsi < 48 && rsi > 30 ? -20 : 0) + (close[n-1] > close[n-5] ? 15 : -15) + (volumeRatio >= 1.25 ? (close[n-1] >= rows[n-1][1] ? 10 : -10) : 0);
  return { status: "ok", candles: n, action: score >= 35 ? "BUY" : score <= -35 ? "SELL" : "WAIT",
    score: Math.max(-100,Math.min(100,score)), indicators: { ema20,ema50,ema200,rsi14:rsi,atr14:atr,atrPercent:atr/close[n-1]*100,volumeRatio },
    evidence: ["Independent ETI EMA trend, RSI, short momentum and relative-volume assessment","Evidence score is not a probability or a GainzAlgo proprietary output"] };
}
