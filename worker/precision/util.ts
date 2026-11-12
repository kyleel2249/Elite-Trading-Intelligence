// Small pure helpers shared by the ETI Precision Signal Engine modules.

export const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Round to 8 significant digits so price levels are stable in JSON without float noise. */
export const roundPrice = (v: number): number => Number(v.toPrecision(8));
export const round = (v: number, dp = 2): number => Number(v.toFixed(dp));

/**
 * Piecewise-linear interpolation through ascending [x, y] points. Values outside the range are clamped to the end points,
 * so a scoring curve can never extrapolate beyond the scores its author defined.
 */
export function interp(x: number, points: readonly (readonly [number, number])[]): number {
  if (!Number.isFinite(x)) return points[0][1];
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return last[1];
}

/** JSON with object keys sorted, so equal configurations always serialise (and hash) identically. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stableStringify(o[k])).join(",") + "}";
}

/** Non-cryptographic 64-bit-ish identifier hash (two FNV-style lanes). Used for ids and config fingerprints only, never for security. */
export function hash16(s: string): string {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x85ebca6b);
    b ^= b >>> 13;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Trim and bound untrusted text before it is echoed into a response. */
export function cleanText(v: unknown, max = 280): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
