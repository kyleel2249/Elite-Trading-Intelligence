/**
 * Read-only, cross-exchange account snapshots for the ETI Portfolio Manager.
 * Account equity is intentionally not summed across margin products: collateral may be shared.
 */
import { loadBybitAccountSnapshot } from "../bybit/account.ts";
import { BITGET_MARKETS, getAssets, getPositions, type BitgetMarket } from "../bitget/api.ts";
type Env = Record<string, any> & { BYBIT_API_KEY?: string; BYBIT_API_SECRET?: string; BYBIT_ACCOUNT_ENV?: string };
const MARKETS = [...BITGET_MARKETS] as BitgetMarket[];
const n = (v: unknown): number | null => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const t = (v: unknown) => v === null || v === undefined ? null : String(v).slice(0, 80);
const rows = (v: any): any[] => Array.isArray(v) ? v : Array.isArray(v?.list) ? v.list : Array.isArray(v?.data) ? v.data : v && typeof v === "object" ? [v] : [];
function assets(data: any) {
  return rows(data).slice(0, 200).map(x => {
    const available = n(x.available ?? x.availableBalance ?? x.crossedMaxAvailable);
    const locked = n(x.frozen ?? x.locked ?? x.lockedAmount);
    const reportedTotal = n(x.total ?? x.totalAmount ?? x.balance);
    return {
      coin: t(x.coin ?? x.marginCoin ?? x.symbol),
      total: reportedTotal ?? (available !== null ? available + (locked ?? 0) : n(x.accountEquity ?? x.equity)),
      available, locked,
      equity: n(x.accountEquity ?? x.equity ?? x.usdtEquity ?? x.usdcEquity),
      unrealizedPnl: n(x.unrealizedPL ?? x.unrealizedPnl ?? x.unrealizedProfit),
      debt: n(x.borrowed ?? x.liability),
      usdValue: n(x.usdtValue ?? x.usdValue ?? x.usdtEquity),
    };
  }).filter(x => x.coin || x.total !== null || x.equity !== null);
}
function positions(data: any) {
  return rows(data).slice(0, 200).map(x => ({
    symbol: t(x.symbol), side: t(x.holdSide ?? x.posSide ?? x.side),
    size: n(x.total ?? x.size), available: n(x.available),
    entryPrice: n(x.openPriceAvg ?? x.openPrice ?? x.averageOpenPrice),
    markPrice: n(x.markPrice), liquidationPrice: n(x.liquidationPrice ?? x.liqPrice),
    leverage: n(x.leverage), marginCoin: t(x.marginCoin),
    marginMode: t(x.marginMode ?? x.marginModeName),
    unrealizedPnl: n(x.unrealizedPL ?? x.unrealizedPnl),
  })).filter(x => x.symbol && (x.size ?? 0) !== 0);
}
async function safe<T>(fn: () => Promise<T>) {
  try { return { status: "connected" as const, data: await fn(), error: null }; }
  catch (e) { return { status: "unavailable" as const, data: null, error: e instanceof Error ? e.message.slice(0, 160) : "request_failed" }; }
}
export async function loadExchangePortfolioSnapshot(env: Env, now = Date.now(), deps: { fetchImpl?: typeof fetch } = {}) {
  const [bybit, ...bg] = await Promise.all([
    safe(() => loadBybitAccountSnapshot(env, { now: () => now, fetchImpl: deps.fetchImpl })),
    ...MARKETS.map(market => safe(async () => {
      const [a, p] = await Promise.allSettled([
        getAssets(env, market, { now: () => now, fetchImpl: deps.fetchImpl }),
        market.endsWith("futures") ? getPositions(env, market, { now: () => now, fetchImpl: deps.fetchImpl }) : Promise.resolve([]),
      ]);
      if (a.status === "rejected") throw a.reason;
      return {
        assets: assets(a.value),
        positions: p.status === "fulfilled" ? positions(p.value) : [],
        positionStatus: !market.endsWith("futures") ? "not_applicable" : p.status === "rejected" ? "unavailable" : "connected",
        positionError: p.status === "rejected" ? (p.reason instanceof Error ? p.reason.message.slice(0, 160) : "positions_unavailable") : null,
      };
    })),
  ]);
  const bitgetMarkets = MARKETS.map((market, i) => ({
    market, status: bg[i].status === "connected" && bg[i].data?.positionStatus === "unavailable" ? "partial" : bg[i].status,
    assets: bg[i].data?.assets ?? [], positions: bg[i].data?.positions ?? [],
    positionStatus: bg[i].data?.positionStatus ?? (market.endsWith("futures") ? "unavailable" : "not_applicable"),
    error: bg[i].error ?? bg[i].data?.positionError ?? null,
  }));
  const bybitConfigured = !!(env.BYBIT_API_KEY?.trim() && env.BYBIT_API_SECRET?.trim());
  const bitgetConfigured = !!(env.BITGET_API_KEY?.trim() || env.BITGET_KEY?.trim() || env.BITGET_ACCESS_KEY?.trim());
  return {
    schema: "eti.exchange-portfolio/1", generatedAt: now, readOnly: true,
    executionEnabled: false, liveOrdersAllowed: false, transfersAllowed: false, withdrawalsAllowed: false,
    venues: [
      bybit.data ?? { venue: "bybit", configured: bybitConfigured, status: bybit.status, checkedAt: now, equityUsd: null, availableUsd: null, assets: [], positions: [], warnings: [], error: bybit.error },
      { venue: "bitget", configured: bitgetConfigured, status: bitgetMarkets.some(x => x.status === "connected") ? (bitgetMarkets.some(x => x.status === "unavailable") ? "partial" : "connected") : bitgetConfigured ? "unavailable" : "credentials_missing", checkedAt: now, markets: bitgetMarkets },
    ],
    aggregation: { combinedEquityUsd: null, combinedAvailableUsd: null, policy: "not_summed_shared_collateral_and_margin_products_can_double_count_balances" },
    limitations: [
      "Read-only account snapshots; no order placement, amendment, cancellation, transfers or withdrawals.",
      "Bybit unified account equity is reported by Bybit. Bitget balances are separated by product; no combined Bitget equity is calculated because shared collateral can be counted more than once.",
      "Values remain in exchange-reported units. Non-USD coin balances are not converted without a verified valuation.",
      "A missing or failed product snapshot is never treated as a zero balance.",
    ],
  };
}
