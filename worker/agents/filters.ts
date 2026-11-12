/** Exchange order-filter compliance (Binance Spot LOT_SIZE / PRICE_FILTER / NOTIONAL). Fails closed when filters are unavailable. */
export interface SymbolFilters { stepSize?: number; minQty?: number; maxQty?: number; tickSize?: number; minPrice?: number; maxPrice?: number; minNotional?: number; maxNotional?: number }

export function parseBinanceFilters(info: any): SymbolFilters | null {
  const s = info?.symbols?.[0];
  if (!s || !Array.isArray(s.filters)) return null;
  const f: SymbolFilters = {};
  for (const x of s.filters) {
    if (x.filterType === "LOT_SIZE") { f.stepSize = Number(x.stepSize); f.minQty = Number(x.minQty); f.maxQty = Number(x.maxQty); }
    else if (x.filterType === "PRICE_FILTER") { f.tickSize = Number(x.tickSize); f.minPrice = Number(x.minPrice); f.maxPrice = Number(x.maxPrice); }
    else if (x.filterType === "NOTIONAL" || x.filterType === "MIN_NOTIONAL") { f.minNotional = Number(x.minNotional); if (x.maxNotional !== undefined) f.maxNotional = Number(x.maxNotional); }
  }
  return f.stepSize || f.tickSize || f.minNotional ? f : null;
}

const decimals = (n: number) => { const s = String(n), [mant, exp] = s.split("e-"); return exp ? Number(exp) + (mant.split(".")[1] ?? "").length : (s.split(".")[1] ?? "").length; };
const floorTo = (v: number, step?: number) => (step && step > 0 ? Number((Math.floor(v / step + 1e-9) * step).toFixed(decimals(step))) : v);
const ceilTo = (v: number, step?: number) => (step && step > 0 ? Number((Math.ceil(v / step - 1e-9) * step).toFixed(decimals(step))) : v);

/** Quantity is rounded DOWN to the lot step (never increases risk). Buy prices round down, sell prices round up to the tick. */
export function applyFilters(t: { side: "buy" | "sell"; quantity: number; limitPrice: number }, f: SymbolFilters):
  { ok: true; quantity: number; limitPrice: number; adjustments: string[] } | { ok: false; reason: string } {
  const adj: string[] = [];
  const price = t.side === "buy" ? floorTo(t.limitPrice, f.tickSize) : ceilTo(t.limitPrice, f.tickSize);
  if (price !== t.limitPrice) adj.push(`price ${t.limitPrice} -> ${price} (tick ${f.tickSize})`);
  const qty = floorTo(t.quantity, f.stepSize);
  if (qty !== t.quantity) adj.push(`quantity ${t.quantity} -> ${qty} (step ${f.stepSize})`);
  if (!(price > 0) || !(qty > 0)) return { ok: false, reason: "quantity_or_price_rounds_to_zero" };
  if (f.minPrice && price < f.minPrice) return { ok: false, reason: "below_min_price" };
  if (f.maxPrice && f.maxPrice > 0 && price > f.maxPrice) return { ok: false, reason: "above_max_price" };
  if (f.minQty && qty < f.minQty) return { ok: false, reason: "below_min_quantity" };
  if (f.maxQty && f.maxQty > 0 && qty > f.maxQty) return { ok: false, reason: "above_max_quantity" };
  const notional = qty * price;
  if (f.minNotional && notional < f.minNotional) return { ok: false, reason: "below_min_notional" };
  if (f.maxNotional && f.maxNotional > 0 && notional > f.maxNotional) return { ok: false, reason: "above_max_notional" };
  return { ok: true, quantity: qty, limitPrice: price, adjustments: adj };
}

/** Filters from the same venue the order will reach (Spot Testnet; live is never used by the agent system). */
export async function loadBinanceFilters(symbol: string): Promise<SymbolFilters | null> {
  try {
    const res = await fetch("https://testnet.binance.vision/api/v3/exchangeInfo?symbol=" + encodeURIComponent(symbol), { signal: AbortSignal.timeout(6000) });
    return res.ok ? parseBinanceFilters(await res.json()) : null;
  } catch { return null; }
}
