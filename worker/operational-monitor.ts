/** Scheduled portfolio monitoring jobs driven by the central ETI operational config. */
import { loadMinuteBars } from "./algo/market-inputs.ts";
import { readOperationalConfig, isMarketDataFresh, formatOperationalTime } from "./operational-config.ts";
import { ensureInit, reconcile } from "./portfolio/engine.ts";
import { openStore } from "./portfolio/store.ts";
import { buildCrossExchangeReconciliation } from "./portfolio/reconciliation.ts";

type MonitorEnv = {
  ETI_PORTFOLIO_DB?: any;
  ETI_EXECUTION_LOG?: any;
  MARKET_PROVIDER_ORDER?: string;
  ETI_OPERATIONAL_CONFIG?: string;
};

const monitorStore = (env: MonitorEnv) => openStore(env, "internal_paper");

/** Persist current, fresh marks as an append-only ledger event. */
export async function runMarkToMarket(env: MonitorEnv, now = Date.now()) {
  const store = monitorStore(env);
  if (!store) return { ok: false, skipped: "portfolio_storage_unavailable", marked: 0 };
  await ensureInit(env as any, now);
  const config = readOperationalConfig(env);
  const { ledger } = await store.ledgerFast(now);
  const prices: Record<string, number> = {};
  const stale: string[] = [];
  await Promise.all(Object.keys(ledger.positions).map(async symbol => {
    try {
      const result = await loadMinuteBars(env as any, symbol, null, now);
      const last = result.bars.at(-1);
      const closeAt = last ? last[0] + 60_000 : NaN;
      if (last && result.price && result.price > 0 && isMarketDataFresh(closeAt, now, config.dataQuality.maxAgeSeconds)) prices[symbol] = last[4];
      else stale.push(symbol);
    } catch { stale.push(symbol); }
  }));
  const marked = Object.keys(prices).length;
  if (marked) {
    const slot = Math.floor(now / (config.monitoring.mtmIntervalSeconds * 1000));
    await store.append({ id: "mtm-" + slot, at: now, t: "mark", prices }, { idempotent: true });
  }
  return { ok: stale.length === 0, marked, stale, at: now };
}

/** Reconcile the internal paper ledger and, when both venue credentials exist, verify the Bybit/Bitget exchange snapshot. */
export async function runPortfolioReconciliation(env: MonitorEnv & Record<string, any>, now = Date.now()) {
  const store = monitorStore(env);
  if (!store) return { ok: false, skipped: "portfolio_storage_unavailable" };
  const internal = await reconcile(env as any, {}, "internal_paper", now);
  if (!internal.ok) console.error("ETI internal portfolio reconciliation found discrepancies", internal.problems);

  const hasBybit = !!(env.BYBIT_API_KEY && env.BYBIT_API_SECRET);
  const hasBitget = !!(
    (env.BITGET_API_KEY || env.BITGET_KEY || env.BITGET_ACCESS_KEY)
    && (env.BITGET_API_SECRET || env.BITGET_SECRET_KEY || env.BITGET_SECRET)
    && (env.BITGET_API_PASSPHRASE || env.BITGET_PASSPHRASE)
  );
  let exchange: any = { skipped: "bybit_and_bitget_read_credentials_required" };
  if (hasBybit && hasBitget) {
    try {
      exchange = await buildCrossExchangeReconciliation(env as any, "exchange_testnet", now);
      if (env.ETI_EXECUTION_LOG) {
        await env.ETI_EXECUTION_LOG.put("eti:cross-exchange-reconciliation:last", JSON.stringify(exchange), { expirationTtl: 60 * 60 * 24 * 30 });
      }
      if (!exchange.ok) console.error("ETI cross-exchange reconciliation is not verified", exchange.problems || []);
    } catch (e) {
      exchange = { ok: false, status: "unavailable", error: e instanceof Error ? e.message : "reconciliation_failed" };
      console.error("ETI cross-exchange reconciliation failed", exchange.error);
    }
  }
  return { ok: internal.ok && (exchange.skipped !== undefined || exchange.ok === true), internal, exchange };
}

/** Store an investor-level snapshot. It is monitoring/reporting only and cannot place or close orders. */
export async function runInvestorMonitor(env: MonitorEnv, now = Date.now()) {
  const store = monitorStore(env);
  if (!store) return { ok: false, skipped: "portfolio_storage_unavailable" };
  const config = readOperationalConfig(env);
  const { ledger } = await store.ledgerFast(now);
  const positions = Object.values(ledger.positions);
  const marketValue = positions.reduce((sum, p) => sum + p.qty * (ledger.marks[p.symbol] ?? p.avgEntry), 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.qty * ((ledger.marks[p.symbol] ?? p.avgEntry) - p.avgEntry), 0);
  const equity = ledger.cash === null ? null : ledger.cash + marketValue;
  const snapshot = {
    schema: "eti.investor-monitor/1",
    at: now,
    localTime: formatOperationalTime(now, config.timezone),
    timezone: config.timezone,
    environment: "internal_paper",
    equity,
    cash: ledger.cash,
    marketValue,
    realizedGrossPnl: ledger.realizedGross,
    fees: ledger.fees,
    unrealizedPnl,
    netPnl: equity === null || ledger.startingBalance === null ? null : equity - ledger.startingBalance,
    openPositions: positions.length,
    positions: positions.map(p => ({ symbol: p.symbol, quantity: p.qty, averageEntry: p.avgEntry, markPrice: ledger.marks[p.symbol] ?? null })),
    anomalies: ledger.anomalies.length,
    liveOrdersAllowed: false,
  };
  if (env.ETI_EXECUTION_LOG) {
    await env.ETI_EXECUTION_LOG.put("eti:investor-monitor:last", JSON.stringify(snapshot), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  return { ok: true, ...snapshot };
}
