# Deployment

ETI has two deployable parts. Pick what you need; they are independent.

| Part | What it serves | Live orders |
|---|---|---|
| Cloudflare Worker (`worker/`, `wrangler.jsonc`) | Dashboard, public market data, signals, readiness, paper/testnet execution | None (paper/testnet only) |
| Python FastAPI service (`app/`) | All dashboards, databases, engines, jobs, risk engine, gated live path | Gated, off by default |

Cloudflare steps are in [CLOUDFLARE.md](CLOUDFLARE.md).

## Python service

### Local

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # edit; never commit .env
alembic upgrade head          # or let init_db() create tables on first start
uvicorn app.main:app --reload
```

Open `http://localhost:8000/` and check `/api/system/health`.

### Docker

The `Dockerfile` runs as a non-root user, honours `$PORT`, and has a health check on `/api/system/health`. Use `docker-compose.yml` for a local stack. Mount a volume for SQLite, or use Postgres ([POSTGRES.md](POSTGRES.md)).

```bash
docker build -t eti .
docker run --env-file .env -p 8000:8000 eti
```

### Fly.io

`fly.toml` is provided. Store secrets with `fly secrets set` (never in `fly.toml` or the repo).

### Database

Default is SQLite (`DATABASE_URL=sqlite:///./eti.db`). For anything beyond a single user use Postgres: `postgresql+psycopg2://user:pass@host:5432/eti`. Run `alembic upgrade head` on every release. The repository keeps a single Alembic head (checked in CI).

## Production configuration (required)

| Variable | Requirement |
|---|---|
| `APP_ENV` | `production` |
| `API_KEY` | Long random value. With `APP_ENV=production` and no key, mutating routes return 503. Send it as `X-API-Key`. |
| `SECRET_KEY` | Long random value (the default triggers a startup warning) |
| `DATABASE_URL` | Postgres for multi-user / durable use |
| `EXECUTION_VAULT_KEY` | Fernet key if the execution engine is enabled; keep separate from the database |

Put TLS in front (the platform's HTTPS or a reverse proxy). Keep broker keys in the host's secret store, trade-only, with withdrawals disabled.

## Going from paper to live: checklist

Do not skip steps. Live trading risks real capital.

1. Paper trade the strategy for a meaningful sample, net of fees and slippage, and review the journal.
2. Verify on exchange testnets with trade-only keys (`testnet-verify` workflow).
3. Confirm `KILL_SWITCH` works and you know who can flip it.
4. Set limits deliberately: `MAX_POSITION_NOTIONAL_PCT`, `DEFAULT_RISK_PER_TRADE_PCT`, `MAX_DAILY_LOSS_PCT`, `MAX_PORTFOLIO_DRAWDOWN_PCT`. Start far smaller than the defaults.
5. Set `API_KEY`, then `LIVE_TRADING_ENABLED=true` plus the provider flag (`BINANCE_LIVE_TRADING_ENABLED=true`, or `ALPACA_PAPER=false` with live keys). Keep `REQUIRE_LIVE_CONFIRMATION=true` and `REQUIRE_FRESH_DATA_FOR_LIVE_ORDERS=true`.
6. Send the first live orders at minimum size and reconcile them against the broker.

Anything that fails a gate is refused, not downgraded.

## Post-deploy checks

```bash
curl https://<host>/api/system/health
curl https://<host>/api/providers/status
curl https://<host>/api/execution/status
curl -I https://<host>/static/market3d.html
```

`providers/status` must show an integration as configured only when credentials are present.
