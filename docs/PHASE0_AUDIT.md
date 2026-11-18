# ETI Phase 0: Repository Audit and Architecture Map

Audited commit: `92e13bc96ed2a3f6ec90b471aacb4992f6f3bb90` (main, PR #53 merge, 2026-11-18).
Method: shallow clone, directory inventory, config and workflow review, targeted greps, and a baseline run of the Worker checks.

## Baseline evidence (run in this audit)
| Check | Result |
|---|---|
| `npm test` (Worker unit tests) | 1321 tests, 1321 pass, 0 fail |
| `npm run test:security` | 15 tests, 15 pass |
| `npm run typecheck:analysis` | `worker/analysis` strict check passes; 11 pre-existing type errors outside that folder are ignored by the script |
| `npm run check:worker` (wrangler dry-run bundle) | completes |
| Python suite (`pytest`), live deployment, CI run status | NOT run in this audit |

## Architecture
- Runtime: Cloudflare Worker (`worker/main.ts`, `worker/index.ts`), about 437 TypeScript files, 145 test files. Cron triggers every minute, 5 minutes and 15 minutes.
- Persistence: D1 `ETI_PORTFOLIO_DB` (17 migrations, 0001 to 0017) and KV `ETI_EXECUTION_LOG`.
- Secondary Python/FastAPI service (`app/`, `alembic/`, Alpha, wallet, analytics). It is separate from the Worker and is not the target of this spec.
- Deploy: `.github/workflows/deploy.yml` runs `npm run check`, applies D1 migrations, then deploys. CI: `ci.yml` (Python and Worker).
- Config safety: `ETI_KILL_SWITCH`, `ETI_RISK_*` limits (risk per trade 0.5%, max leverage 1, daily loss 2%, drawdown 10%), `ETI_ANALYSIS_PLAN=free`. Execution environments are `internal_paper`, `exchange_testnet`, `live`.
- Existing gateway: `worker/execution.ts` (`handleExecution`, authorised, idempotency and locks in migration 0011), `worker/safeguards.ts` (duplicate protection, balance checks, fail-closed, refusal audit), `worker/risk/*`.

## Where each spec area already lives (extend, do not duplicate)
| Spec area | Existing modules | Status noted from code and docs |
|---|---|---|
| SMC, FVG, structure | `worker/analysis/smc.ts`, `fvg.ts`, `fvg-intel.ts`, `structure.ts`, `institutional.ts` | Present; per-detection confirmation and invalidation fields not yet checked |
| Footprint, CVD, liquidity history | `worker/analysis/orderflow.ts`, KV depth sampling (72 samples, 7-day expiry) | Phase 1 foundation landed; no D1 persistence, no heatmap rendering (1 file mentions it) |
| Multi-timeframe | `worker/analysis/mtf.ts`, `worker/algo/timeframes.ts` | Confluence visualizer is still on the roadmap |
| ETIAlgo V3 Alpha | `worker/algo/v3-alpha*.ts`, `regime.ts`, `divergence.ts`, `calibration.ts` | Divergence (price and RSI) and lifecycle (migration 0016) landed; regime-aware scoring still on roadmap |
| Agents | `worker/agents/*` (orchestrator, commander, controls, persistence, autopilot) | Twelve-agent council, dissent, durable audit (migration 0017) landed |
| Risk and portfolio | `worker/risk/*`, `worker/portfolio/*`, `worker/precision/*` | Correlation, stress and Monte Carlo appear mostly in the Python `app/analytics`; Worker-side exposure, correlation, stress and risk-of-ruin are gaps |
| Backtesting | `worker/algo/backtest.ts`, `v3-alpha-backtest.ts`, `v3-alpha-mtf-backtest.ts`, `replay.ts` | Fee, funding, latency, walk-forward and attribution coverage not yet verified |
| Cross-exchange, whales, events, anomalies | `worker/bitget/*`, `worker/bybit/*`, `worker/alpha/flow.ts`, readiness engine | Bybit-Bitget scanner and large-trade monitor are not found as dedicated modules |
| Execution intelligence | `worker/execution.ts`, `safeguards.ts`, `algo/paper*.ts`, `portfolio/reconciliation.ts` | Paper mode exists; shadow mode, execution-quality reports and trailing/partial management need audit |
| Workspaces | `/agents`, `/pro`, `/terminal`, `worker/command/*`, `worker/journal/*` | Command Centre and Journal exist; Replay Studio, Setup Scanner, Opportunity Radar, Conflict Detector are gaps |

The roadmap in `docs/ETI-ADVANCED-IMPLEMENTATION.md` is consistent with these findings.

## D1 tables (migrations 0001 to 0017)
Portfolio and journal (`pf_*`, `jr_*`), sports, company, treasury, execution locks and idempotency, institutional holdings, profit engine, GainzAlgo (`gainz_*`), `eti_v3_alpha_signals`, `eti_v3_alpha_lifecycle`, `eti_agent_decisions`. Next migration number is 0018. Migrations must stay additive.

## Findings and risks
1. `typecheck:analysis` ignores 11 type errors outside `worker/analysis`. New code outside that folder gets a weaker check; these should be triaged before large additions.
2. Order-flow history is KV-only (bounded, 7-day expiry). The spec's persistent liquidity heatmap and replay need a bounded D1 snapshot table plus a retention policy.
3. `ETI_AGENT_AUTOPILOT_ENABLED`, `ETI_PAPER_AUTOEXECUTE` and `CHAIN_MAINNET_SEND_ENABLED: "on"` are set in production `wrangler.jsonc`. Autopilot is documented as paper-only, but `CHAIN_MAINNET_SEND_ENABLED` is worth confirming against the live-execution rule in the spec. I did not change it.
4. `wrangler.jsonc` contains a contact email in `SEC_USER_AGENT` and a placeholder `DATABASE_URL`; no secrets were observed.

## Recommended next steps (Phase 1 first)
1. Triage the 11 ignored type errors.
2. Phase 1: add SMC detection metadata (timeframe, confirmation, source candles, invalidation, confidence), a D1 depth-snapshot table (migration 0018) with retention, and a multi-timeframe confluence endpoint and Pro Terminal panel.
3. Keep every new route read-only and behind the existing auth; add safety tests listed in spec section 13.
