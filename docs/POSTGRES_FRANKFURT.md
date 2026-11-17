# ETI FastAPI origin in Frankfurt (fra) on PostgreSQL

The FastAPI origin remains in `fra`, outside Bybit's documented US and mainland-China IP blocks. The Cloudflare Worker forwards public Bybit REST requests to this Frankfurt origin, so public market calls never depend on the GitHub Actions runner or the user's nearest Cloudflare edge for Bybit egress. The PostgreSQL origin remains near Frankfurt to avoid adding cross-region database latency.

What the repo now does:

- `fly.toml`: `primary_region = "fra"`, no SQLite volume, `DATABASE_URL` removed (it is a secret), `ETI_REQUIRE_POSTGRES = "true"`.
- With that flag the app refuses to start unless `DATABASE_URL` is PostgreSQL. A missing secret stops the deploy rather than quietly writing trading records to a disposable file.
- `postgres://` and `postgresql://` URLs from hosting providers are accepted (the psycopg2 driver is added automatically).
- Tables are created on first start (`init_db`). The append-only prediction-ledger triggers have a PostgreSQL implementation.

## Cut-over steps (you run these; they touch your Fly account)

1. Create a PostgreSQL database in an EU region near `fra` (Fly's managed Postgres in `fra`, or any provider). Copy its connection URL.
2. `fly secrets set DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/DBNAME' -a eti-trading-intelligence`
   Also re-check the other secrets you rely on (`API_KEY`, `EXECUTION_VAULT_KEY`, exchange keys): secrets stay with the app, not the region.
3. Remove the old US machine and its volume only after you have decided you do not need the SQLite data (`fly machines list`, `fly machine destroy <id>`, `fly volumes list`, `fly volumes destroy <id>`).
4. `fly deploy` (the machine is created in `fra`). Check `curl https://<app>.fly.dev/api/system/health` and `/api/market/symbols?provider=bybit` plus `/api/providers/status`.

## Data in the old SQLite file

The new database starts empty. Nothing copies the old file automatically. If you need the old paper trades, predictions or accounts, copy them before step 3 (for example with `pgloader`) and verify row counts. Do not destroy the volume until you have.

## Not changed

The Cloudflare Worker (D1) is separate and is not affected. Trading stays paper/testnet unless every live gate is opened.


## Automated deployment

The production GitHub Actions workflow deploys the FastAPI origin to the `fra` region before deploying the Cloudflare Worker whenever backend files change. Add a Fly.io deploy token as the repository Actions secret `FLY_API_TOKEN`; the workflow does not store or print its value. Existing application secrets such as `DATABASE_URL` stay in Fly's secret store.

