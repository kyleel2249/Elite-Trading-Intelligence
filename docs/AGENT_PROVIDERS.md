# Agent data providers, exchange filters and dashboard

## Dashboard
`GET /agents` serves the **ETI Agent Intelligence Center**. It shows only what the backend returns: each agent's status, stance, confidence, evidence, warnings and missing inputs; the Commander decision with disagreements and dissent; Risk Manager checks; provider health; the agent message log; and the stored Auditor summary. Agents run **on demand**. There are no background agent jobs, so *Start/Pause/Resume/Stop* control a client-side refresh timer that re-runs the analysis; they do not start or stop server processes. Performance appears only after recorded decisions have been audited.

## Providers (`worker/agents/providers.ts`)
| Feeds | Provider | Key | Notes |
|---|---|---|---|
| News agent | CoinDesk and Cointelegraph public RSS | none | Headlines filtered to the asset by name/ticker; 48 h freshness enforced by the agent |
| Fundamental, Crypto agents | CoinGecko public API | none | Market cap, FDV, circulating/total/max supply. Subject to public rate limits |
| Macro agent | FRED API | `FRED_API_KEY` (Worker secret) | Real-yield 30-day change, broad dollar 30-day change, M2 and CPI year-over-year, VIX |

All calls are time-limited (6 s), cached 5 min at the edge, and reported per request in `providers[]` (also `GET /api/agents/providers`). A failure yields `insufficient_data` for that agent, never substitute data. Caller-supplied `fundamentals`, `macro`, `news`, `onchain` override provider data key by key. Disable providers with `providers=0` (GET) or `"providers": false` (POST).

Still without a provider: on-chain flows (exchange netflow, active addresses, TVL), market-implied rate expectations, and an economic calendar. Supply them in the request or tell me which provider to integrate.

## Exchange filters and account state (execute path)
* For Binance, the ticket is checked against the Spot Testnet `exchangeInfo` filters (LOT_SIZE, PRICE_FILTER, NOTIONAL). Quantity rounds **down** to the lot step; buy prices round down and sell prices round up to the tick; minimum/maximum quantity, price and notional are enforced. If filters can't be fetched the order is blocked (`exchange_filters_unavailable`). Alpaca filters are not checked.
* When `BINANCE_API_KEY`/`BINANCE_SECRET_KEY` (testnet) are set, `POST /api/agents/execute` reads the Testnet account so equity, available USDT and base-asset position need not be supplied. Equity counts only USDT plus the traded base asset. Daily PnL and drawdown are not derivable and remain unknown (the Risk Manager warns). Caller-supplied account fields override fetched ones.

## Limits that remain
No LLM reasoning layer (needs an LLM API key); spot cannot be shorted, and margin/futures shorting is not implemented; Researcher methodologies are simplified; auditor outcomes ignore fees and slippage; the dashboard is read-only and does not place orders.
