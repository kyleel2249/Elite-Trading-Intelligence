# ETI Autonomous On-chain Trading Intelligence (AOTI)

## Current release scope
AOTI adds live DEX pair discovery for Solana, Ethereum, Base, BNB Chain, Arbitrum, Polygon and Optimism using DexScreener. Pair enrichment uses RugCheck for Solana and GoPlus for EVM security signals. GeckoTerminal OHLCV feeds supply a labelled approximation for the existing advanced volume-profile engine (POC, VAH, VAL and value-area location). A real trade-print profile is preferred when a normalized transaction feed is available; the candle-derived profile is never represented as transaction-level data.

The D1-backed candidate, paper-position, event and equity-state ledgers are durable. The scanner enforces age <= 6h, liquidity >= $40,000 and 5-minute volume >= $25,000. The score combines liquidity, volume, age, volume acceleration, buy pressure, holder growth, independently verified smart-wallet/KOL evidence and POC quality. Missing wallet intelligence receives no points.

## Security gate
Entries require all eight evidence groups: at least 300 holders, revoked mint authority, revoked freeze authority, LP lock of at least 30 days, developer ownership below 5%, top-ten ownership below 35%, successful sell simulation and a clean bundled-launch review. Unknown or stale evidence is PENDING and blocks entry; a failed check is FAIL. RugCheck/GoPlus fields are mapped only when supplied. Provider gaps remain unknown. Authenticated operators can submit a timestamped security review at POST /api/aoti/security; this is explicitly labelled operator-attested and must be based on independent evidence.

## Risk and paper execution
Paper sizing uses a 1% equity risk budget, hard caps of 2% risk, 20% equity notional, 0.5% of pool liquidity, two open positions and a $5 minimum. Risk halves after two consecutive losses. Peak-to-equity drawdown controls reduce risk at 5%, restrict at 10%, enter defensive mode at 15%, and suspend new entries at 20%. A paper position uses a 12% hard stop, 25-minute time stop, 40% exit at 2x, 30% exit at 4x, and a 25% trailing stop for the runner. A >40% pool-liquidity decline or failed security refresh forces a paper exit. Paper marks and PnL are estimates and are not exchange fills.

## API
- GET /aoti — dashboard.
- GET /api/aoti/overview — persisted candidates, positions, events and equity.
- POST /api/aoti/scan — run discovery (requires ETI paper session).
- POST /api/aoti/security — submit operator-attested security evidence (requires ETI paper session).
- POST /api/aoti/paper/open — open a candidate that passes all gates (requires ETI paper session).
- POST /api/aoti/paper/close — close a paper position (requires ETI paper session).

The scheduled cycle runs every five minutes when ETI_AOTI_ENABLED=true and ETI_PORTFOLIO_DB is bound. It refreshes market discovery and open paper positions. No live DEX transaction is signed or sent.

## Explicit integration requirements for live DEX execution
Live swaps remain disabled until ETI has a dedicated transaction builder per chain/DEX, authenticated RPC/indexer access, quote and route simulation, isolated signing service, transaction simulation, idempotent submission, confirmation/finality tracking, reorg/failed-transaction handling, and wallet balance reconciliation. A browser wallet connection or a displayed token price is not proof of execution. Private keys and seed phrases must never enter browser storage, API request bodies, logs or the AOTI dashboard.

## Provider and coverage limits
Public discovery APIs are rate-limited and may omit pairs, holders, lock contracts or transaction history. Smart-wallet clustering, KOL trade verification, holder-growth deltas, complete LP locker attribution and sell simulation are not assumed when absent. Such gaps block the security gate or receive no scoring points. The supported list is the set of configured adapters, not a claim that every pool or transaction on those networks is indexed.
