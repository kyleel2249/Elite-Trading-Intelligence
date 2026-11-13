# Moving ETI to Frankfurt (fra) on PostgreSQL

Why: Binance refuses US IP addresses on every official host, and the old config ran in `iad` (Virginia). `fra` is outside the US. ETI also moves from a region-bound SQLite volume to PostgreSQL.

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
4. `fly deploy` (the machine is created in `fra`). Check `curl https://<app>.fly.dev/api/system/health` and `/api/market/binance-hosts`.

## Data in the old SQLite file

The new database starts empty. Nothing copies the old file automatically. If you need the old paper trades, predictions or accounts, copy them before step 3 (for example with `pgloader`) and verify row counts. Do not destroy the volume until you have.

## Not changed

The Cloudflare Worker (D1) is separate and is not affected. Trading stays paper/testnet unless every live gate is opened.
