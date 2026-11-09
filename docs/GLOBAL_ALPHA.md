# ETI Global Alpha Intelligence

Open `/alpha` on the Worker. Code lives in `worker/alpha/`; API under `/api/alpha/*`.

## What is built (and verified by tests)
| Area | Module | Notes |
|---|---|---|
| Early-alpha engine | `earlyalpha.ts` | 8 stages, 0-100 score, factor weights per asset class; unavailable factors are `null` and excluded, with `evidenceCoverage` reported. Never an automatic buy. |
| Strategy lab | `lab.ts` | 13 engine modules + 4 lab rules + random control, common risk envelope, costs, IS/OOS split, 4 walk-forward folds, multiple-testing-corrected threshold, compatibility engine. |
| Flow / DEX | `flow.ts` | Exchange order flow and wash-trading checks; DexScreener + GoPlus for tokens (monitoring only, never executable); wallet labels only asserted at confidence >= 0.8 with a source. |
| SEC | `sec.ts`, `research.ts` | 13F (delayed snapshot, never "fresh"), Form 4, 13D/G parsers; CIKs start unverified and are checked at runtime; `SEC_USER_AGENT` required (fail closed). |
| Copy-trade evaluation | `copytrade.ts` | Delay-aware 12-step trail, 6 classes. |
| Fusion + validation | `fusion.ts` | Hard-risk veto, independent validator that reads only raw candles and the plan; validation cap 60. |
| Ledger | `ledger.ts` | Predictions resolved from later candles only, stop-first; false-negative tracking; rates withheld on small samples. |
| Execution | `routes.ts`, `positions.ts` | Token-gated; uses existing risk gateway at `/api/orders` only (paper/testnet). Live disabled, no withdrawal capability. Virtual stops monitored each run; exposure limits. |
| Monitoring | `monitor.ts` | Model-version hash, champion/challenger with automatic rollback on paper losses. |
| Profiles | `profiles.ts` | Audit of the 35 foundational traders. Result today: 35 present, 0 fully evidenced, 24 partial, 11 seed text. They are research backlog, not verified track records. |

## Honest limits
- **No live-API verification.** The build sandbox had no outbound network. Parsers for EDGAR, OpenFIGI, DexScreener, GoPlus, Etherscan, Alpaca and exchange endpoints are tested against fixtures only; coverage shows them as "implemented, live-unverified" until you run them.
- **Not global coverage.** Crypto: first reachable of Binance/Bybit/OKX. Equities: US only via Alpaca (IEX feed volume is partial). No provider for London, Tokyo, Hong Kong, Shanghai, Shenzhen, Euronext, Frankfurt, ASX, Toronto. `/api/alpha/coverage` lists every gap.
- **CPU.** Measured locally: ~20-30 ms per asset without the lab, ~50 ms (500 bars) to ~200 ms (1000 bars) with it. This exceeds the free Workers 10 ms CPU limit; use Workers Paid. Scans are bounded by a per-run subrequest budget and report `partial`.
- **Scheduling.** Each cron tick runs crypto scan, prediction resolution and position monitoring; equity, SEC, DEX and outcome jobs run in the first quarter-hour of each hour; new-manager discovery at 07:00 UTC.
- **No LLM calls exist**, so prompt compression, caching and token-usage tracking do not apply; there are no token savings to report.
- Fundamental/macro strategies are listed as not testable (candles lack their inputs).
- Not financial advice. Nothing here places live orders.

## Deploy
1. `wrangler kv namespace create ETI_ALPHA_KV` (optional; otherwise `ETI_EXECUTION_LOG` is reused under the `alpha:` prefix) and add it to `wrangler.jsonc`.
2. `wrangler secret put ETI_ALPHA_TOKEN` (and `SEC_USER_AGENT`, plus optional keys from `.dev.vars.example`).
3. `npm test && wrangler deploy`. The cron `*/15 * * * *` runs scans, SEC refresh, prediction resolution and position monitoring.
4. Cloudflare: put the Worker behind your zone route; no other edge config is needed.

## Test
`npm test` runs `worker/*.test.ts` and `worker/alpha/*.test.ts`.
