# Cloudflare deployment for ETI

ETI is a **Python FastAPI** application (Uvicorn). It is **not** a pure static site or Workers-only Node app.

## Realistic Cloudflare options

### Option A — Cloudflare Containers / Cloudflare Workers + Container (recommended when available)

Use a container image built from the repo `Dockerfile`.

**Build**

```bash
docker build -t eti:latest .
```

**Runtime**

- Port: `8000`
- CMD: `uvicorn app.main:app --host 0.0.0.0 --port 8000`
- Health check path: `GET /api/system/health`

**Environment variables (Cloudflare dashboard / secrets)**

| Variable | Required | Notes |
|----------|----------|-------|
| `SECRET_KEY` | yes | Random long string |
| `API_KEY` | recommended | Protects mutating routes (`X-API-Key`) |
| `DATABASE_URL` | prod yes | Prefer Postgres; SQLite not for multi-instance |
| `LIVE_TRADING_ENABLED` | no | Default false in prod unless intentional |
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | optional | |
| `ALPACA_PAPER` | optional | `true` for paper |
| `BINANCE_API_KEY` / `BINANCE_SECRET_KEY` | optional | |
| `BINANCE_LIVE_TRADING_ENABLED` | optional | |
| `QUIVER_API_KEY` | optional | Research only |
| `LIQUID_API_KEY` / `LIQUID_API_BASE_URL` | optional | Only if you verified a base URL |
| `FRED_API_KEY` / `NEWSAPI_KEY` | optional | |
| `MTM_INTERVAL_SECONDS` | optional | |
| `RECONCILE_INTERVAL_SECONDS` | optional | |
| `INVESTOR_MONITOR_INTERVAL_SECONDS` | optional | Default 1800 |

**Never** put API secrets in frontend JS or Workers public bindings that are client-readable.

### Option B — Cloudflare Tunnel to a VPS / home host

Run ETI on a machine you control; expose via `cloudflared`.

```bash
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
# separate terminal
cloudflared tunnel --url http://localhost:8000
```

### Option C — Pages (static only) — **not sufficient alone**

Cloudflare Pages can host static assets, but **cannot** run this FastAPI process as-is.
Use Pages only if you later split a static frontend and call a separate API origin.

## Build settings summary (for container deploy forms)

| Setting | Value |
|---------|--------|
| Dockerfile path | `./Dockerfile` |
| Build context | repository root |
| Exposed port | `8000` |
| Health endpoint | `/api/system/health` |
| Persistent disk | required if using SQLite; prefer managed Postgres |
| WebSockets | needed for Binance stream features |
| CPU/Memory | min 512MB RAM; 1GB+ recommended with jobs |

## Post-deploy checks

```bash
curl https://YOUR_HOST/api/system/health
curl https://YOUR_HOST/api/providers/status
curl https://YOUR_HOST/api/data-intelligence/status
```

## Security

- Set `API_KEY` and send `X-API-Key` on POST routes.
- Keep `LIVE_TRADING_ENABLED=false` until keys and risk limits are verified.
- Quiver key is research-only; never used for order placement.
- Liquid: no withdrawal scopes; trading not assumed without verified docs.
