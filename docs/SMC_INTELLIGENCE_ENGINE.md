# ETI SMC Intelligence Engine

## Assessment (2026-11-19)

The repository already contains separate Smart Money Concepts analysis and visualization layers:
- `worker/analysis/smc.ts`: displacement, FVG, liquidity pool/sweep, and order-block detection.
- `worker/analysis/smc-intel.ts`: auditable detections, inverse FVG, premium/discount and non-executable metadata.
- `worker/analysis/confluence.ts`: multi-timeframe weighted evidence, stale-frame exclusion, conflicts, overlapping zones, liquidity targets, and order-flow freshness checks.
- `worker/analysis/api.ts`: `/api/analysis/smc` and `/api/analysis/confluence` read-only endpoints.
- `worker/ui/smc-layer.ts`, `fvg-layer.ts`, and `liquidity-intelligence.ts`: existing chart layers.
- `worker/ui/trading-terminal.ts`: existing Bitget-first Pro Terminal with institutional analysis.

The issue was fragmentation and discoverability: the underlying analysis existed, but a shared confluence summary was not presented consistently on the Dashboard, Live Market Chart, and Pro Terminal. The added layer reuses the existing confluence API rather than duplicating detectors.

## Delivered changes

- Added `worker/ui/smc-intelligence.ts` containing the reusable panel UI and browser client.
- Added `worker/ui/smc-intelligence.test.ts` syntax and integration-contract tests.
- Integrated `/smc-intelligence.js` and `/smc-intelligence.css` routes in `worker/main.ts`.
- Added panel injection to Dashboard root (`/`), Live Market Chart surfaces served at the root, Pro Terminal (`/terminal`), and Pro Dashboard (`/pro`).
- Panel shows stance, evidence score, data coverage, entry alignment, directional evidence, liquidity targets, zone overlaps and structure conflicts.
- Supports entry-timeframe selector and manual refresh; refreshes every 60 seconds and reacts to symbol, venue, market and chart timeframe controls.
- Uses selected venue/market; Pro Terminal defaults to Bitget futures when its venue/market controls are not exposed.
- Handles request errors without removing existing chart functionality; avoids duplicate mounts and prevents concurrent fetches.
- The panel is read-only: it cannot submit or authorize orders.

## Existing methodology reused

Confluence weights are taken from the existing analysis engine (1M/1W/1D = 3, 4H = 2.5, 1H = 2, 15M = 1.5, 5M = 1). Its output score is evidence-weighted, not a win probability. Missing or stale frames are reported and excluded; conflicts affect the stance/confidence; order flow only counts when supplied as sufficiently fresh exchange trades.

## Validation

- Browser JavaScript parse check was run against the new panel script and passed.
- GitHub connector commits were used because the runtime could not resolve github.com for a local clone.
- Full project npm tests, TypeScript checks, Wrangler dry-run and browser-level rendering have **not** been run in this environment; those results must not be assumed.
- The next CI/deployment verification should run `npm test`, `npm run typecheck:analysis`, and `npm run check:worker`, then verify root dashboard, `/terminal`, `/pro`, and the two static assets on the deployed Worker.

## Safety note

SMC zones and evidence scores are descriptive and not guaranteed reactions or probabilities. The panel is informational; ETI's separate order permissions, execution safeguards and kill switch remain authoritative.
