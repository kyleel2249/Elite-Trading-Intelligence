# Environment variables (Cloudflare Worker)

Set secrets with `wrangler secret put NAME` (never in `wrangler.jsonc`, the repo or a client bundle). Plain config goes in `wrangler.jsonc` `vars`. Bindings are KV/D1 resources.
`worker/env-docs.test.ts` fails if the Worker reads a variable that is not listed here.

| Variable | Kind | Purpose |
|---|---|---|
| `AI` | binding | Optional Workers AI binding (`"ai": {"binding": "AI"}` in wrangler.jsonc, not enabled by default). Used only for the optional headline-sentiment second opinion when SENTIMENT_AI=on. |
| `ALERT_EMAIL` | config | Legacy alias of ETI_ALERT_EMAIL (alert recipient). |
| `ALPACA_API_KEY` | secret | Alpaca paper-trading and market-data key id (paper only). |
| `ALPACA_DATA_FEED` | config | Alpaca data feed (`iex` default; `sip` needs a paid subscription). |
| `ALPACA_SECRET_KEY` | secret | Alpaca secret paired with ALPACA_API_KEY. |
| `ALPHA_EQUITY_WATCHLIST` | config | Comma-separated equity symbols for Global Alpha. |
| `ALPHA_SUBREQUEST_BUDGET` | config | Cap on outbound sub-requests per Global Alpha run. |
| `ANTHROPIC_API_KEY` | secret | Enables the optional LLM brief. Absent = feature off. |
| `BACKEND_URL` | config | Origin of the Python backend (`https://host`, no path, credentials, query or fragment). Required for the custodial wallet at /wallet/chain (the Worker forwards /api/chain/* to it with a timeout, a GET retry and a header allowlist) and used as the generic fallback for routes the Worker does not implement. Check it at GET /api/chain-view/backend. The deploy workflow syncs it from a GitHub variable or secret named `BACKEND_URL`. |
| `BINANCE_API_KEY` | secret | Binance spot **testnet** key (trade-only). |
| `BINANCE_FUTURES_API_KEY` | secret | Binance futures **testnet** key. |
| `BINANCE_FUTURES_SECRET_KEY` | secret | Binance futures testnet secret. |
| `ETI_WALLET_EXECUTION` | var | `enabled` allows external wallet withdrawals to be executed (default off; needs D1). |
| `ETI_WALLET_RP_ID` | var | WebAuthn relying-party id for signer approvals (defaults to the request host). |
| `ETI_WALLET_ORIGINS` | var | Comma-separated origins allowed for signer approvals (defaults to the request origin). |
| `ETI_WALLET_ALLOW_SYNCED_PASSKEYS` | var | `true` allows synced passkeys as signer keys (default: device-bound keys only). |
| `ETI_WALLET_AAGUIDS` | var | Comma-separated AAGUID allow-list of approved hardware-key models. |
| `ETI_WALLET_GOV_TIMELOCK_SEC` | var | Timelock for governance actions (default 86400). |
| `ETI_SIGNER_URL` | secret | HTTPS URL of the signing gateway (HSM / MPC / KMS) that holds the keys. |
| `ETI_SIGNER_SECRET` | secret | HMAC secret shared with the signing gateway. |
| `BINANCE_WITHDRAW_API_KEY` | secret | Binance withdrawal-only API key (IP-restricted) for Binance-custody wallets. |
| `BINANCE_WITHDRAW_SECRET_KEY` | secret | Secret for the Binance withdrawal key. |
| `BINANCE_SECRET_KEY` | secret | Binance spot testnet secret. |
| `COINGECKO_API_KEY` | secret | Optional CoinGecko key for fundamentals. |
| `CRYPTO_PROFILES_JSON` | secret | Operator-curated crypto facts no free API provides (team identity, regulatory status, verified audits, unlocks), keyed by symbol. Only whitelisted, type-checked fields are read; they are labelled as operator assertions. |
| `ETHERSCAN_API_KEY` | secret | Optional Etherscan key for on-chain data and provider probes. |
| `ETI_ALERTS_DISABLED` | config | `true` turns alert delivery off. |
| `ETI_ALERT_ACCOUNTS` | config | Accounts whose alerts are sent by the scheduled run. |
| `ETI_ALERT_EMAIL` | config | Alert recipient address. |
| `ETI_ALERT_FROM` | config | Alert sender address (must be allowed by the mail provider). |
| `ETI_ALERT_MAX_PER_HOUR` | config | Alert rate cap per hour. |
| `ETI_ALPHA_KV` | binding | KV namespace for Global Alpha (falls back to ETI_EXECUTION_LOG). |
| `ETI_ALPHA_TOKEN` | secret | Token for Global Alpha write routes (falls back to ETI_EXECUTION_TOKEN). |
| `ETI_ANALYSIS_ALLOW_FULL` | config | `true` lets a Free-plan deployment serve `detail=full` analysis (only if you raised your own CPU limit). Default off. |
| `ETI_ANALYSIS_PLAN` | config | `free` (default) or `paid`. Free = lite detail, capped inputs, calibration refused; paid = full detail and calibration. See docs/ANALYSIS_ENGINE.md. |
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
| `BITGET_API_KEY` | secret | Bitget API key with trade permission enabled and withdrawal permission disabled. Never enable withdrawals. Also accepted: `BITGET_KEY`. |
| `BITGET_API_SECRET` | secret | Bitget API secret. Also accepted: `BITGET_SECRET_KEY`. |
| `BITGET_API_PASSPHRASE` | secret | Bitget API passphrase. Also accepted: `BITGET_PASSPHRASE`. |
| `ETI_BITGET_BACKFILL_DAYS` | config | First-sync look-back for Bitget fills (1-90, default 7). |
| `ETI_BITGET_LIVE_ENABLED` | config | `true` enables the separately authenticated Bitget live-order adapter. The master ETI execution token, Bitget trade-enabled credentials, explicit order confirmation, kill-switch check, idempotency and notional/leverage limits remain required. |
| `ETI_BITGET_MAX_LEVERAGE` | config | Maximum allowed Bitget futures leverage (default 150x; capped by ETI at 150x and the exchange's own contract limit). |
| `ETI_BITGET_MAX_NOTIONAL_USDT` | config | Maximum estimated notional per Bitget live order (default 10,000 quote units; checked against the submitted reference price or market-buy quote amount). |
| `ETI_BITGET_MARGIN_SYMBOLS` | config | Comma-separated margin pairs whose fills are synced (Bitget margin fills require a symbol), e.g. `BTCUSDT,ETHUSDT`. |
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
| `ETI_LLM_MAX_INPUT_TOKENS` | config | Estimated input-token budget for one LLM brief; context is trimmed in tiers only when exceeded (default 8000). |
| `ETI_LLM_CACHE_TTL` | config | Seconds an identical analysis review is served from KV instead of calling the LLM again; 0 disables (default 900). |
| `GITHUB_TOKEN` | secret | Optional GitHub token with no permissions, lifting the 60 requests/hour limit for crypto development-activity data. |
| `REDIS_URL` | config | `redis://[:password@]host:port/db` for the Python cache and task queue; blank disables them. |
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
| `ETI_RISK` | prefix | Common prefix of the autonomous risk-policy variables below (`worker/risk/policy.ts`). Each can only tighten the policy; values looser than the built-in hard ceilings are clamped back to them. Invalid values fall back to the default. |
| `ETI_RISK_PER_TRADE` | config | Fraction of equity risked per trade (default 0.005 = 0.5%, ceiling 0.01). |
| `ETI_RISK_MAX_NOTIONAL` | config | Maximum single-position notional as a fraction of equity (default and ceiling 0.5). |
| `ETI_RISK_MAX_POSITIONS` | config | Maximum concurrent positions, integer (default and ceiling 3). |
| `ETI_RISK_MAX_DAILY_LOSS` | config | Daily realized + unrealized loss, as a fraction of the day's equity baseline, that stops new entries (default and ceiling 0.02). |
| `ETI_RISK_MAX_CONSECUTIVE_LOSSES` | config | Consecutive losing trades that stop new entries, integer (default and ceiling 3). |
| `ETI_RISK_MIN_REWARD_RISK` | config | Minimum net reward-to-risk ratio after costs (default and floor 1.5). |
| `ETI_RISK_MAX_LEVERAGE` | config | Maximum leverage (default and ceiling 1). |
| `ETI_RISK_MIN_CASH_RESERVE` | config | Cash kept uncommitted as a fraction of equity (default and floor 0.5). |
| `ETI_RISK_MAX_DRAWDOWN` | config | Drawdown from peak equity that stops new entries (default and ceiling 0.1). |
| `ETI_RISK_GATE_TOKEN` | legacy | Removed. Ignored; reported as unused legacy config. |
| `ETI_RISK_GATE_URL` | legacy | Removed. Ignored; if present the dashboard reports it as unused legacy config. |
| `ETI_ROUND_TRIP_COST_BPS` | config | Assumed round-trip trading cost (bps) in signal maths. |
| `ETI_SPORTS_AUTO_SCAN_LIMIT` | config | Upcoming football fixtures retrieved per scheduled scan (default 12, max 12). |
| `ETI_SPORTS_HISTORY_BATCH_SIZE` | config | Unseen finished football fixtures imported per scheduled history sync (5 default, max 30). |
| `ETI_SPORTS_HISTORY_SYNC_MINUTES` | config | Minimum minutes between scheduled football history syncs (1440 default, min 360). |
| `ETI_SPORTS_PAPER_BANKROLL_CENTS` | config | Starting balance, in cents, of a **new** sports paper ledger (default 100000 = USD 1,000.00; range 100 to 1,000,000,000). An existing ledger is never changed automatically. |
| `ETI_SPORTS_PAPER_TOKEN` | secret | Protects the isolated sports paper bankroll, bet ledger and manual history sync. |
| `ETI_SPORTS_SCAN_INTERVAL_MINUTES` | config | Minimum minutes between scheduled global football odds scans (360 default, min 60). |
| `ETI_GAINZ_WEBHOOK_SECRET` | secret | HMAC-SHA256 secret for signed TradingView GainzAlgo V2 / V2 Alpha webhook requests. |
| `ETI_GAINZ_ADMIN_TOKEN` | secret | Optional dedicated bearer token for the GainzAlgo Intelligence Centre; falls back to `ETI_EXECUTION_TOKEN` when absent. |
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
| `ETI_PERP_FEE_TAKER_BPS` | config | Futures paper taker fee in basis points (default 5). |
| `ETI_PERP_FEE_MAKER_BPS` | config | Futures paper maker fee in basis points (default 2). |
| `ETI_PERP_SLIPPAGE_BPS` | config | Futures paper market/stop slippage in basis points (default 5). |
| `ETI_PERP_MMR` | config | Futures paper maintenance margin rate used for liquidation price (default 0.005). |
| `ETI_PERP_MAX_LEVERAGE` | config | Highest leverage the futures order routes accept (default 50). |
| `ETI_PERP_MIN_NOTIONAL` | config | Smallest futures order notional in USDT (default 5). |
| `SENTIMENT_AI` | config | `on` enables the AI headline-sentiment second opinion (also needs the AI binding). Default off. |
| `SENTIMENT_AI_MODEL` | config | Workers AI model id for the sentiment second opinion (default `@cf/meta/llama-3.1-8b-instruct`). |
| `TOKENOMIST_API_KEY` | secret | Optional Tokenomist Pro key for token unlock schedules (native port of the Python client). Licence: data is not redistributed; only derived metrics are returned. |
| `TOKENOMIST_CREDIT_RESERVE` | config | Share (0-1, default 0.1) of the monthly Tokenomist credit allowance that is never spent. |
| `INFURA_API_KEY` | secret | Infura project API key (32 hex characters). When set, every tracked network without an explicit `CHAIN_RPC_*` URL is read through `https://<network>.infura.io/v3/<key>` (Ethereum, Base, BNB Chain, Polygon and their testnets). Set it as a Worker secret (`wrangler secret put INFURA_API_KEY`) and as a backend secret (`fly secrets set`). Never put it in a URL variable you commit. |
| `INFURA_API_SECRET` | secret | Optional Infura API key secret, for keys with "Require API key secret" enabled. Sent as HTTP Basic (empty user name) only to `*.infura.io`. |
| `CHAIN_RPC_SEPOLIA` | config | Optional (defaults to the public Sepolia node) JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `ETI_PROFIT_CONFIRM_MINUTES` | config | Profit management (/profit). Default `60`. Minutes a trade must have been closed before its result counts as confirmed profit (0 to 10080). |
| `ETI_PROFIT_DRAWDOWN_WINDOW_DAYS` | config | Profit management (/profit). Default `30`. Look-back window for the realized-drawdown capital-protection check (1 to 365). |
| `ETI_PROFIT_MAX_DRAWDOWN_BPS` | config | Profit management (/profit). Default `1000`. Realized drawdown, in basis points of trading capital, above which distributions are held and profit stays in trading capital. |
| `ETI_PROFIT_AUTO_ALLOCATE` | config | Profit management (/profit). Default `true`. Set to `false` to stop the engine allocating simulated profit automatically (it still recognises it). Real-funds books are never allocated automatically. |
| `ETI_PROFIT_MIN_ALLOCATION_CENTS` | config | Profit management (/profit). Default `100`. Smallest pool, in cents, that triggers an automatic simulated allocation. |
| `ETI_PROFIT_SIM_CAPITAL_CENTS` | config | Profit management (/profit). Default `0`. Optional one-time simulated trading capital, in cents, posted to the simulated books so simulated losses have capital to be charged against. Not real money. |
| `CHAIN_RPC_BASE_SEPOLIA` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_BSC_TESTNET` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_POLYGON_AMOY` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_ETHEREUM` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_BASE` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_BSC` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |
| `CHAIN_RPC_POLYGON` | config | Optional JSON-RPC URL (https, no embedded credentials) the Worker uses for the read-only on-chain dashboard at /wallet/chain. The node's chain id must match the network or the data is refused. May contain a provider key in the path: treat as sensitive. |

Kinds: **secret** = private, never exposed to the browser or logs; **config** = non-sensitive setting; **binding** = Cloudflare KV/D1 resource; **legacy** = removed, ignored.

No variable is public to the browser. Real values must never be committed; the Python app's own settings are in `.env.example`.
