/** Subrequest budget: Workers cap outbound fetches per invocation, so every scan spends from an explicit budget. */
export class Budget {
  used = 0; readonly max: number;
  constructor(max: number) { this.max = max; }
  get left() { return this.max - this.used; }
  /** Returns true and spends `n` if available; false when exhausted (callers then stop and report partial coverage). */
  take(n = 1): boolean { if (this.used + n > this.max) return false; this.used += n; return true; }
}
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
