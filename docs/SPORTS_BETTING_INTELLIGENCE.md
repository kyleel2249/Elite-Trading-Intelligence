# ETI Sports Betting Intelligence

## First release boundary
The Sports Betting Intelligence module is isolated from financial-market trading and supports odds retrieval plus a persistent simulated betting ledger. Real-money bookmaker execution is intentionally not implemented or enabled.

## Routes
- `GET /sports` — dedicated dashboard.
- `GET /api/sports/status` — module, provider and D1 readiness.
- `GET /api/sports/events?sport=soccer_epl&regions=uk,eu` — odds from The Odds API.
- `GET /api/sports/bets` — private paper ledger (requires `x-eti-sports-token`).
- `POST /api/sports/bets` — create a paper bet after positive-EV and bankroll checks.
- `POST /api/sports/bets/:id/settle` — manually settle a paper bet as WON, LOST or VOID.

## Cloudflare configuration
Set these as Worker secrets, never commit them:
- `ODDS_API_KEY` — The Odds API key for live odds retrieval.
- `ETI_SPORTS_PAPER_TOKEN` — a long random token protecting paper bankroll and ledger writes.

The existing `ETI_PORTFOLIO_DB` D1 binding is reused only as a database host. Sports data is stored in separate `sports_*` tables and does not share the financial portfolio ledger.

Apply migration:
```sh
npx wrangler d1 migrations apply eti-portfolio-db --remote
```

## Integrity and limitations
- Without `ODDS_API_KEY`, the dashboard clearly reports that odds are unavailable; it never fabricates fixtures or prices.
- The first release does not claim to have calibrated independent sports prediction models. A paper bet requires an explicit model probability and positive expected value.
- EV is `p × decimal_odds − 1`; the API rejects non-positive EV.
- The initial paper bankroll is USD $1.00 and is separate from every financial trading account.
- Bets are manually settled in this release; automated official-result settlement is not yet implemented.
- Provider markets and sport keys vary by subscription and region. The dashboard reports provider errors rather than inventing results.
- No real-money bookmaker execution, staking, deposits or withdrawals are present.
