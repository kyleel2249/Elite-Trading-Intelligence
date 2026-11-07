# Investor Intelligence module

## What was built

- Durable tables: `investor_activities`, `intelligence_alerts`, `disclosure_outcomes`
- Quiver scan → normalize → **ActivityStore** upsert → significance → alerts
- SEC EDGAR 13F **index** adapter (historical snapshot only)
- Consensus overlap report (research priority, not trade signal)
- Disclosure learning scaffold (publication date = T0)
- Dashboard **Data Intel** panel

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /api/data-intelligence/status` | Quiver / Liquid / EDGAR / monitor |
| `POST /api/data-intelligence/monitor/scan` | Scan + persist |
| `GET /api/data-intelligence/activities` | Stored activities |
| `GET /api/data-intelligence/alerts` | Alerts |
| `POST /api/data-intelligence/alerts/{id}/ack` | Acknowledge |
| `GET /api/data-intelligence/consensus` | Multi-actor overlap |
| `GET /api/data-intelligence/edgar/13f/{cik}` | EDGAR 13F index |
| `GET /api/data-intelligence/learning/summary` | Outcome scaffold stats |

## Rules

- Never auto-trade from disclosures
- Separate transaction / filing / publication / retrieval dates
- 13F ≠ live portfolio
- Helena Frost still gates all orders
- Claire Bennett owns alert audit trail

## Migrations

SQLite `create_all` picks up new models on startup.
Postgres: `alembic upgrade head` (includes `0002_investor`).
