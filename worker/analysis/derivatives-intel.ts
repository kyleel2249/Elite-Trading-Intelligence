// Derivatives intelligence: open-interest and funding history (real Bybit public data), OI-versus-price regime, and an ESTIMATED liquidation map.
// Nothing here is invented: if the exchange does not return history the result says "unavailable". Bybit exposes no public REST liquidation history, so the
// liquidation map is a model (leverage tiers applied to swing entries that price has not since traded through) and is labelled estimated everywhere.
import type { Kline } from "../market.ts";

export interface OiPoint { t: number; oi: number }
export interface FundingPoint { t: number; rate: number }
const BYBIT_HOSTS = ["https://api.bybit.com", "https://api.bytick.com"];
const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : NaN; };

export function parseBybitOpenInterest(json: any): OiPoint[] | null {
  const list = json?.retCode === 0 && Array.isArray(json?.result?.list) ? json.result.list : null;
  if (!list) return null;
  const pts = list.map((x: any) => ({ t: num(x.timestamp), oi: num(x.openInterest) })).filter((p: OiPoint) => p.t > 0 && p.oi >= 0 && Number.isFinite(p.oi));
  return pts.length ? pts.sort((a: OiPoint, b: OiPoint) => a.t - b.t) : null;
}
export function parseBybitFunding(json: any): FundingPoint[] | null {
  const list = json?.retCode === 0 && Array.isArray(json?.result?.list) ? json.result.list : null;
  if (!list) return null;
  const pts = list.map((x: any) => ({ t: num(x.fundingRateTimestamp), rate: num(x.fundingRate) })).filter((p: FundingPoint) => p.t > 0 && Number.isFinite(p.rate));
  return pts.length ? pts.sort((a: FundingPoint, b: FundingPoint) => a.t - b.t) : null;
}

const OI_INTERVAL: Record<string, string> = { "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1d" };
export interface DerivativesFeed { oi: OiPoint[] | null; funding: FundingPoint[] | null; interval: string | null; failures: Record<string, string> }

/** Public, unauthenticated Bybit v5 data for linear/inverse perpetuals. Spot has no open interest or funding, so it returns nothing without calling out. */
export async function fetchBybitDerivatives(symbol: string, category: string, timeframe: string, fetchImpl: typeof fetch = fetch): Promise<DerivativesFeed> {
  const failures: Record<string, string> = {}, out: DerivativesFeed = { oi: null, funding: null, interval: OI_INTERVAL[timeframe] ?? null, failures };
  if (category !== "linear" && category !== "inverse") { failures.market = "open interest and funding exist only for futures"; return out; }
  const get = async (path: string, params: Record<string, string>) => {
    const q = new URLSearchParams(params).toString();
    for (const host of BYBIT_HOSTS) {
      try {
        const res = await fetchImpl(`${host}${path}?${q}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
        if (res.ok) return await res.json();
      } catch { /* try next host */ }
    }
    return null;
  };
  const iv = out.interval ?? "1h";
  const [oi, fr] = await Promise.all([
    get("/v5/market/open-interest", { category, symbol, intervalTime: iv, limit: "48" }),
    get("/v5/market/funding/history", { category, symbol, limit: "24" }),
  ]);
  out.oi = parseBybitOpenInterest(oi); if (!out.oi) failures.openInterest = oi ? "empty_or_rejected" : "unreachable";
  out.funding = parseBybitFunding(fr); if (!out.funding) failures.funding = fr ? "empty_or_rejected" : "unreachable";
  return out;
}

export type OiRegime = "long_buildup" | "short_buildup" | "short_covering" | "long_liquidation" | "flat" | "unknown";
export interface OiAnalysis {
  status: "available" | "unavailable"; points: number; latest: number | null; changePct: number | null; priceChangePct: number | null; regime: OiRegime;
  reading: string; supportsDirection: 1 | -1 | 0; notes: string[];
}
/** Four-quadrant reading of open interest against price over the same window. Rising price with rising OI is new money; rising price with falling OI is shorts closing. */
export function analyzeOpenInterest(oi: OiPoint[] | null, rows: Kline[], windowBars = 12): OiAnalysis {
  const none = (notes: string[]): OiAnalysis => ({ status: "unavailable", points: oi?.length ?? 0, latest: null, changePct: null, priceChangePct: null, regime: "unknown", reading: "Open interest history unavailable.", supportsDirection: 0, notes });
  if (!oi || oi.length < 4) return none(["Fewer than four open-interest points were returned."]);
  const w = Math.min(windowBars, oi.length - 1), a = oi[oi.length - 1 - w], b = oi[oi.length - 1];
  if (!(a.oi > 0)) return none(["Open interest baseline is zero."]);
  const changePct = (b.oi / a.oi - 1) * 100;
  const px = rows.filter((r) => r[0] >= a.t), priceChangePct = px.length >= 2 ? (px[px.length - 1][4] / px[0][1] - 1) * 100 : null;
  if (priceChangePct === null) return { ...none(["Price candles do not cover the open-interest window."]), latest: b.oi, changePct };
  const pu = priceChangePct > 0.3, pd = priceChangePct < -0.3, ou = changePct > 1, od = changePct < -1;
  const regime: OiRegime = pu && ou ? "long_buildup" : pd && ou ? "short_buildup" : pu && od ? "short_covering" : pd && od ? "long_liquidation" : "flat";
  const reading = { long_buildup: "Price up with open interest up: new longs are entering, which confirms the advance.", short_buildup: "Price down with open interest up: new shorts are entering, which confirms the decline.",
    short_covering: "Price up with open interest down: the rise is shorts closing, which is weaker than new buying.", long_liquidation: "Price down with open interest down: longs are closing or being liquidated; selling pressure may be exhausting.", flat: "Open interest and price are not moving decisively together.", unknown: "" }[regime];
  const supportsDirection: 1 | -1 | 0 = regime === "long_buildup" ? 1 : regime === "short_buildup" ? -1 : 0;
  return { status: "available", points: oi.length, latest: b.oi, changePct, priceChangePct, regime, reading, supportsDirection, notes: [`Open interest ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}% against price ${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}% over ${w} intervals.`] };
}

export interface FundingAnalysis { status: "available" | "unavailable"; latest: number | null; avg: number | null; trend: "rising" | "falling" | "flat" | "unknown"; extreme: boolean; notes: string[] }
export function analyzeFundingHistory(f: FundingPoint[] | null): FundingAnalysis {
  if (!f || f.length < 3) return { status: "unavailable", latest: null, avg: null, trend: "unknown", extreme: false, notes: ["Funding history unavailable."] };
  const latest = f[f.length - 1].rate, avg = f.reduce((s, p) => s + p.rate, 0) / f.length, half = Math.floor(f.length / 2);
  const early = f.slice(0, half).reduce((s, p) => s + p.rate, 0) / half, late = f.slice(half).reduce((s, p) => s + p.rate, 0) / (f.length - half);
  const trend = late - early > 0.00005 ? "rising" : late - early < -0.00005 ? "falling" : "flat";
  const extreme = Math.abs(latest) >= 0.001;
  return { status: "available", latest, avg, trend, extreme, notes: [`Funding ${(latest * 100).toFixed(4)}% latest, ${(avg * 100).toFixed(4)}% average over ${f.length} settlements, ${trend}.`] };
}

export interface LiqZone { price: number; side: "long_liquidations" | "short_liquidations"; strength: number; leverages: number[]; distancePct: number; estimated: true }
/** Estimated liquidation clusters. Swing highs/lows are treated as entry candidates for leveraged shorts/longs at 10/25/50/100x; a level price has since traded
 *  through is dropped (that position would already be gone). Strength is relative (0-1) and is NOT an observed quantity. */
export function estimateLiquidationZones(rows: Kline[], atr: number, mmr = 0.005): LiqZone[] {
  const n = rows.length; if (n < 40 || !(atr > 0)) return [];
  const price = rows[n - 1][4], tiers: [number, number][] = [[10, 0.15], [25, 0.35], [50, 0.35], [100, 0.15]], raw: { price: number; side: LiqZone["side"]; w: number; lev: number }[] = [];
  const start = Math.max(3, n - 300);
  for (let i = start; i < n - 3; i++) {
    const r = rows[i], isLow = r[3] < rows[i - 1][3] && r[3] < rows[i - 2][3] && r[3] <= rows[i + 1][3] && r[3] <= rows[i + 2][3];
    const isHigh = r[2] > rows[i - 1][2] && r[2] > rows[i - 2][2] && r[2] >= rows[i + 1][2] && r[2] >= rows[i + 2][2];
    for (const [lev, share] of tiers) {
      if (isLow) {      // longs opened near a swing low
        const liq = r[3] * (1 - 1 / lev + mmr);
        if (liq > 0 && liq < price && !rows.slice(i + 1).some((x) => x[3] <= liq)) raw.push({ price: liq, side: "long_liquidations", w: Math.max(0, r[5]) * share, lev });
      }
      if (isHigh) {     // shorts opened near a swing high
        const liq = r[2] * (1 + 1 / lev - mmr);
        if (liq > price && !rows.slice(i + 1).some((x) => x[2] >= liq)) raw.push({ price: liq, side: "short_liquidations", w: Math.max(0, r[5]) * share, lev });
      }
    }
  }
  const bucket = atr * 0.5, map = new Map<string, { price: number; w: number; side: LiqZone["side"]; levs: Set<number> }>();
  for (const z of raw) {
    const key = z.side + Math.round(z.price / bucket), c = map.get(key) ?? { price: 0, w: 0, side: z.side, levs: new Set<number>() };
    c.price = (c.price * c.w + z.price * z.w) / Math.max(1e-12, c.w + z.w) || z.price; c.w += z.w; c.levs.add(z.lev); map.set(key, c);
  }
  const all = [...map.values()], max = Math.max(1e-12, ...all.map((c) => c.w));
  const pick = (side: LiqZone["side"]) => all.filter((c) => c.side === side && c.w > 0).sort((a, b) => b.w - a.w).slice(0, 5)
    .map((c): LiqZone => ({ price: c.price, side, strength: Number((c.w / max).toFixed(3)), leverages: [...c.levs].sort((a, b) => a - b), distancePct: Number(((c.price / price - 1) * 100).toFixed(2)), estimated: true }));
  return [...pick("short_liquidations"), ...pick("long_liquidations")].sort((a, b) => b.price - a.price);
}
