# Environment variables (Cloudflare Worker)

Set secrets with `wrangler secret put NAME` (never in `wrangler.jsonc`, the repo or a client bundle). Plain config goes in `wrangler.jsonc` `vars`. Bindings are KV/D1 resources.
`worker/env-docs.test.ts` fails if the Worker reads a variable that is not listed here.

| Variable | Kind | Purpose |
|---|---|---|
| `ALERT_EMAIL` | config | Legacy alias of ETI_ALERT_EMAIL (alert recipient). |
| `ALPACA_API_KEY` | secret | Alpaca paper-trading and market-data key id (paper only). |
| `ALPACA_DATA_FEED` | config | Alpaca data feed (`iex` default; `sip` needs a paid subscription). |
| `ALPACA_SECRET_KEY` | secret | Alpaca secret paired with ALPACA_API_KEY. |
| `ALPHA_EQUITY_WATCHLIST` | config | Comma-separated equity symbols for Global Alpha. |
| `ALPHA_SUBREQUEST_BUDGET` | config | Cap on outbound sub-requests per Global Alpha run. |
| `ANTHROPIC_API_KEY` | secret | Enables the optional LLM brief. Absent = feature off. |
| `BACKEND_URL` | config | Optional. HTTP(S) origin (no path, credentials, query or fragment) that receives any route the Worker does not handle itself. Unset = unknown routes return a JSON 404. |
| `BINANCE_API_KEY` | secret | Binance spot **testnet** key (trade-only). |
| `BINANCE_FUTURES_API_KEY` | secret | Binance futures **testnet** key. |
| `BINANCE_FUTURES_SECRET_KEY` | secret | Binance futures testnet secret. |
| `BINANCE_SECRET_KEY` | secret | Binance spot testnet secret. |
| `COINGECKO_API_KEY` | secret | Optional CoinGecko key for fundamentals. |
| `ETHERSCAN_API_KEY` | secret | Optional Etherscan key for on-chain data and provider probes. |
| `ETI_ALERTS_DISABLED` | config | `true` turns alert delivery off. |
| `ETI_ALERT_ACCOUNTS` | config | Accounts whose alerts are sent by the scheduled run. |
| `ETI_ALERT_EMAIL` | config | Alert recipient address. |
| `ETI_ALERT_FROM` | config | Alert sender address (must be allowed by the mail provider). |
| `ETI_ALERT_MAX_PER_HOUR` | config | Alert rate cap per hour. |
| `ETI_ALPHA_KV` | binding | KV namespace for Global Alpha (falls back to ETI_EXECUTION_LOG). |
| `ETI_ALPHA_TOKEN` | secret | Token for Global Alpha write routes (falls back to ETI_EXECUTION_TOKEN). |
| `ETI_AUTO_ROLLBACK` | config | `true` restores the last approved strategy config when results degrade. |
| `ETI_AUTO_SESSIONS` | config | Controls automatic dashboard sessions (paper/testnet scopes only). |
| `ETI_CSP_CONNECT` | config | Extra browser connect-src origins, space separated. |
| `ETI_DAILY_ENABLED` | config | Enables the scheduled daily report. |
| `ETI_DAILY_HOUR_UTC` | config | UTC hour the daily report runs. |
| `ETI_DAILY_RISK_PCT` | config | Risk percentage used when sizing the daily report's example plans. |
| `ETI_DAILY_STOCKS` | config | Equity symbols included in the daily report. |
| `ETI_DAILY_SUBREQUEST_BUDGET` | config | Cap on outbound sub-requests per daily report. |
| `ETI_DUPLICATE_WINDOW_SECONDS` | config | Window in which an identical order is refused as a duplicate. |
| `ETI_EDGE` | config | Adaptive-edge feature switch for the dashboard. |
| `ETI_EVENTS_JSON` | config | Inline JSON of scheduled market events for the readiness engine. |
| `ETI_EVENT_FEED_TOKEN` | secret | Bearer token for ETI_EVENT_FEED_URL. |
| `ETI_EVENT_FEED_URL` | config | HTTPS JSON event feed for the readiness engine. |
| `ETI_EXECUTION_API_TOKEN` | secret | Token for the optional Python execution engine. |
| `ETI_EXECUTION_API_URL` | config | Optional Python execution engine base URL. |
| `ETI_EXECUTION_LOG` | binding | KV namespace: audit/rejection/order records, idempotency, rate limits; journal fallback store. |
| `ETI_EXECUTION_TOKEN` | secret | Master token for programmatic API access. |
| `ETI_FUTURES_ENABLED` | config | Enables the futures testnet module. |
| `ETI_FUTURES_MAX_LEVERAGE` | config | Hard leverage cap for futures testnet orders. |
| `ETI_FUTURES_MAX_NOTIONAL_USD` | config | Hard notional cap for futures testnet orders. |
| `ETI_FX_CANDLES_URL` | config | Operator FX candle adapter URL. |
| `ETI_FX_DATA_TOKEN` | secret | Token for the FX adapters. |
| `ETI_FX_QUOTE_URL` | config | Operator FX quote adapter URL. |
| `ETI_IDENTITY_ISSUER` | config | Issuer name for identity tokens. |
| `ETI_IDENTITY_KEY` | secret | AES-256-GCM key sealing identity data and backups. |
| `ETI_IDENTITY_KEY_PREVIOUS` | secret | Previous identity key, accepted during rotation. |
| `ETI_INVALIDATION_CONFIRMATIONS` | config | Consecutive readings required before a plan is invalidated. |
| `ETI_JOURNAL_ENABLED` | config | Opt-in recording of signal-route calls in the legacy signal journal (not the Trade Journal, which is always on when storage is bound). |
| `ETI_KEY_ROTATION_DAYS` | config | Maximum age of session signing keys (default 7). |
| `ETI_KILL_SWITCH` | config | `true` refuses every order immediately (HTTP 423). |
| `ETI_LIVE_TRADING_ENABLED` | config | Reported only. Live trading is disabled in this build regardless (`/api/orders/live` returns 423). |
| `ETI_LLM_MAX_PER_HOUR` | config | Cap on LLM brief calls per hour. |
| `ETI_LLM_MODEL` | config | Model id for the optional LLM brief. |
| `ETI_MANAGE_ACCOUNTS` | config | Accounts whose open positions the scheduled run monitors. |
| `ETI_MANAGE_AUTOCLOSE` | config | `true` lets the monitor close positions on confirmed invalidation. |
| `ETI_MANAGE_STRATEGY` | config | Strategy used by the position monitor. |
| `ETI_MAX_ORDER_QUANTITY` | config | Maximum order quantity; unset means no extra cap. |
| `ETI_PAPER_AUTOEXECUTE` | config | `true` lets the scheduled paper run open positions. |
| `ETI_PAPER_FEE_BPS` | config | Simulated fee (basis points) for internal paper fills. |
| `ETI_PAPER_SLIPPAGE_BPS` | config | Simulated slippage (basis points) for internal paper fills. |
| `ETI_PAPER_START_BALANCE` | config | Starting cash of the internal paper account. |
| `ETI_PAPER_STRATEGY` | config | Default strategy for the paper engine. |
| `ETI_PAPER_SYMBOLS` | config | Symbols the scheduled paper run evaluates. Unset = scheduled paper run off. |
| `ETI_PORTFOLIO_DB` | binding | D1 database: portfolio ledger, identity, and the Trade Journal (recommended permanent store). |
| `ETI_PRECISION_ADMIN_TOKEN` | secret | Admin token for precision-engine configuration. |
| `ETI_PRECISION_CONFIG` | config | Precision-engine configuration JSON. |
| `ETI_PRECISION_DATA` | binding | KV namespace for precision-engine context (falls back to ETI_EXECUTION_LOG). |
| `ETI_PRECISION_SYMBOLS` | config | Comma separated crypto symbols (max 10) for the scheduled outcome ledger; empty disables it. |
| `ETI_PRECISION_STRATEGIES` | config | Strategies the ledger records (default `intraday`). |
| `ETI_PRECISION_BATCH` | config | Pairs evaluated per cron tick, 1 to 4 (default 1). |
| `ETI_READINESS_GATE` | config | `enforce`/`off`: whether a failing readiness check blocks orders. |
| `ETI_RISK_GATE_TOKEN` | legacy | Removed. Ignored; reported as unused legacy config. |
| `ETI_RISK_GATE_URL` | legacy | Removed. Ignored; if present the dashboard reports it as unused legacy config. |
| `ETI_ROUND_TRIP_COST_BPS` | config | Assumed round-trip trading cost (bps) in signal maths. |
| `ETI_SPORTS_AUTO_SCAN_LIMIT` | config | Upcoming football fixtures retrieved per scheduled scan (default 12, max 12). |
| `ETI_SPORTS_HISTORY_BATCH_SIZE` | config | Unseen finished football fixtures imported per scheduled history sync (5 default, max 30). |
| `ETI_SPORTS_HISTORY_SYNC_MINUTES` | config | Minimum minutes between scheduled football history syncs (1440 default, min 360). |
| `ETI_SPORTS_PAPER_BANKROLL_CENTS` | config | Starting balance, in cents, of a **new** sports paper ledger (default 100000 = USD 1,000.00; range 100 to 1,000,000,000). An existing ledger is never changed automatically. |
| `ETI_SPORTS_PAPER_TOKEN` | secret | Protects the isolated sports paper bankroll, bet ledger and manual history sync. |
| `ETI_SPORTS_SCAN_INTERVAL_MINUTES` | config | Minimum minutes between scheduled global football odds scans (360 default, min 60). |
| `ETI_SESSION_SECRET` | secret | Signs ETI session tokens. |
| `ETI_SESSION_SECRET_PREVIOUS` | secret | Previous signing secret, accepted during rotation. |
| `ETI_UNIVERSE_BATCH` | config | Symbols scanned per scheduled universe run. |
| `ETI_UNIVERSE_ENABLED` | config | Enables the scheduled universe scan. |
| `ETI_UNIVERSE_MAX_SPREAD_BPS` | config | Skip symbols with a wider spread. |
| `ETI_UNIVERSE_MAX_SYMBOLS` | config | Cap on symbols in the universe. |
| `ETI_UNIVERSE_MIN_QUOTE_VOLUME` | config | Skip symbols below this 24h quote volume. |
| `ETI_UNIVERSE_STRATEGY` | config | Strategy used by the universe scan. |
| `FRED_API_KEY` | secret | FRED macro-data key (feature skipped when absent). |
| `FRED_SERIES_JSON` | config | Extra FRED series as JSON. |
| `MARKET_PROVIDER_ORDER` | config | Comma-separated market-data provider priority. |
| `NEWS_FEEDS_JSON` | config | News feed list as JSON. |
| `ODDSPAPI_API_KEY` | secret | OddsPapi global football fixtures, bookmaker odds, scores and provider health. |
| `ODDS_API_KEY` | secret | Optional The Odds API regional fallback for supported US and international markets. |
| `OPENFIGI_API_KEY` | secret | Optional OpenFIGI key for instrument lookup. |
| `RESEND_API_KEY` | secret | Resend key for alert email. Absent = alerts recorded as 'not delivered'. |
| `SEC_USER_AGENT` | config | User-Agent string SEC EDGAR requires (name and contact email). |

Kinds: **secret** = private, never exposed to the browser or logs; **config** = non-sensitive setting; **binding** = Cloudflare KV/D1 resource; **legacy** = removed, ignored.

No variable is public to the browser. Real values must never be committed; the Python app's own settings are in `.env.example`.
