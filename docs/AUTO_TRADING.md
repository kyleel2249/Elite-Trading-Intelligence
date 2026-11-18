# Automated paper trading (all pairs)

Auto trading in ETI is **simulated**. The scheduled engine opens, manages and closes *paper* positions against live public prices. It never contacts a broker, and no live-money path exists in this build (`liveTradingAvailable` is always `false` in `/api/paper/status`, and `/api/orders/live` returns 423). Nothing here can be switched to real money from configuration.

## What is switched on

`wrangler.jsonc` `vars`:

| Setting | Value | Effect |
|---|---|---|
| `ETI_PAPER_SYMBOLS` | `ALL` | Evaluate every pair in the scanned market universe, in rotation. A list such as `BTCUSDT,ETHUSDT` still works and pins those pairs. |
| `ETI_PAPER_AUTOEXECUTE` | `true` | Open paper positions automatically when the plan is BUY or SELL and the safeguards pass. |
| `ETI_PAPER_STRATEGY` | `intraday` | Strategy used for entries. |
| `ETI_KILL_SWITCH` | `false` | Entries allowed. Set `true` to stop all new entries at once; open positions are still managed. |
| `ETI_AUTO_ROLLBACK` | `true` | Restores the last human-approved configuration if recent results degrade. |
| `ETI_UNIVERSE_ENABLED` | `true` | Builds and refreshes the universe from the exchange's 24h ticker list. |
| `ETI_UNIVERSE_MAX_SYMBOLS` | `300` | Largest universe the code allows. |
| `ETI_UNIVERSE_MIN_QUOTE_VOLUME` | `1000000` | Lowered from 5,000,000 USDT of 24h volume to include more pairs. |
| `ETI_UNIVERSE_MAX_SPREAD_BPS` | `50` | Widened from 25 bps. |
| `ETI_UNIVERSE_BATCH` | `3` | Pairs scanned per universe run (free-plan subrequest limit). |

## What "all available pairs" means

The universe is every Binance USDT spot pair that passes the liquidity filters, up to 300. Stablecoin pairs, leveraged tokens, pairs with no valid quote, fewer than 5,000 trades in 24 hours, volume under the minimum and spreads over the maximum are excluded, because paper fills on illiquid pairs are not meaningful. These filters are deliberate; remove them only by changing `worker/algo/universe.ts`.

Every scheduled run evaluates a few pairs: the ones never evaluated first, then the least recently evaluated (`eti:paper:rotation` in KV). One failing pair cannot block the rotation.

**Pace.** Workers on the free plan allow about 50 subrequests per run and one pair costs about 10, so a run evaluates **3 pairs** and runs every 15 minutes. A full 300-pair sweep therefore takes about a day. With `ETI_ANALYSIS_PLAN=paid` (a Workers Paid deployment) a run evaluates up to 20 pairs, so a sweep takes about 4 hours. Check `/api/paper/status` for `scheduler.maxSymbolsPerRun` and the last run's `universe` summary.

## Safeguards that always apply

Every entry, scheduled or manual, passes the in-process risk policy (`worker/risk/policy.ts`). Its limits can only be tightened, never loosened past the built-in ceilings:

- 0.5% of equity risked per trade, positions at most 50% of equity, at most 3 open positions, 50% cash kept in reserve
- daily loss stop at 2%, stop after 3 consecutive losses, drawdown stop at 10%, minimum net reward to risk of 1.5, leverage 1
- kill switch, idempotency, simulated balance and quantity checks

Because of the 3-position ceiling, "all pairs" means all pairs are *watched and evaluated*; at most three can be open at once.

## Not enabled, on purpose

- **Real-money trading.** Not available in this build.
- **Futures testnet automation (`ETI_FUTURES_ENABLED`).** It needs Binance futures testnet keys and has its own leverage and notional caps; enable it deliberately once the keys are set.
- **Position monitor and alerts (`ETI_MANAGE_ACCOUNTS`, `ETI_MANAGE_AUTOCLOSE`, `ETI_ALERT_ACCOUNTS`).** They name specific accounts, which only you know.

## Check it is working

1. `GET /api/paper/status` (INTERNAL PAPER session or master token): `scheduler.allPairs` is `true`, `autoExecute` is `true`, `killSwitch` is `false`.
2. After the next cron tick, `scheduler.lastRun.items` lists the pairs evaluated and `scheduler.lastRun.universe.size` is the universe size. If it says the universe has not been built, wait for the next `*/5` universe scan.
3. `GET /api/paper/audit` shows every simulated order and rejection.

Use `POST /api/paper/kill {"on": true}` or set `ETI_KILL_SWITCH=true` to halt new entries.
