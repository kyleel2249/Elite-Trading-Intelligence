# Cloudflare deployment settings for ETI

ETI is a **Python FastAPI** app with SQLite/Postgres, background jobs, and httpx WebSockets. Choose the path that matches your dependency footprint.

## Reality check

| Path | Fit for full ETI |
|------|------------------|
| **Cloudflare Containers** (Worker + container image) | **Best** for full Docker/`uvicorn` stack (SQLAlchemy, jobs, websockets) |
| **Python Workers** (`python_workers` + FastAPI ASGI) | Possible for a **slim** API; C-extension packages may fail on Pyodide/WASM |
| **Pages only** | Frontend/static only — **not** the FastAPI backend |

Full ETI (Alpaca/Binance streams, MTM, investor monitor) → prefer **Containers** or traditional VM/Docker (Fly, Railway, ECS) with Cloudflare only as DNS/CDN.

---

## Option A — Cloudflare Containers (recommended for full app)

1. **Build** the existing `Dockerfile` (uvicorn on 8000).
2. **Paid Workers plan** required for Containers.
3. Configure container port **8000**, health check `GET /api/system/health`.
4. Set secrets (not in git):

```
SECRET_KEY=
API_KEY=
DATABASE_URL=postgresql+psycopg2://...
LIVE_TRADING_ENABLED=true
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
ALPACA_PAPER=true
BINANCE_API_KEY=
BINANCE_SECRET_KEY=
QUIVER_API_KEY=
FRED_API_KEY=
NEWSAPI_KEY=
```

5. Deploy flow (conceptual):
   - `docker build -t eti .`
   - Push image via Cloudflare container registry / `wrangler` container deploy (follow current CF Containers docs).
   - Route Worker → container binding.

6. **Do not** put API keys in Pages env for browser access.

---

## Option B — Python Workers (slim subset)

Only if you strip heavy jobs and confirm pure-Python deps.

**wrangler.jsonc**

```jsonc
{
  "name": "eti-slim",
  "main": "src/worker.py",
  "compatibility_date": "2026-11-07",
  "compatibility_flags": ["python_workers"],
  "vars": {
    "LIVE_TRADING_ENABLED": "false"
  }
}
```

**Entrypoint pattern** (from CF FastAPI docs):

```python
from fastapi import FastAPI
from workers import asgi

app = FastAPI()
# mount only lightweight routes

Default = asgi.entrypoint(app)
```

Local: `uv run pywrangler dev`  
Deploy: `uv run pywrangler deploy`

**Secrets:** `wrangler secret put QUIVER_API_KEY` etc.

---

## Build settings summary

| Setting | Value |
|---------|--------|
| Runtime | Docker Python 3.12 (full) or Python Workers 3.13+ (slim) |
| Start command | `uvicorn app.main:app --host 0.0.0.0 --port 8000` |
| Health | `/api/system/health` |
| Node build | **Not required** for backend |
| Root directory | repository root |
| Env | server-side secrets only |

---

## What will break on pure Workers without Containers

- Long-lived Binance/Alpaca WebSocket tasks
- APScheduler-style infinite asyncio jobs (MTM/reconcile/investor) without Durable Objects/Queues redesign
- SQLite file DB on ephemeral FS — use **D1/Hyperdrive/Postgres**

---

## Security

- Never expose `QUIVER_API_KEY`, exchange keys, or `API_KEY` to the frontend.
- Quiver = research only; cannot place trades.
- Liquid exchange trading is **not assumed** until you supply a verified base URL and docs.
