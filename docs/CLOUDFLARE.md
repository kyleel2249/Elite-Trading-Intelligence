# Cloudflare deployment for ETI

ETI is a **Python FastAPI** application. It does **not** run inside Cloudflare Containers.

The repo ships a **plain Worker** that reverse-proxies to your FastAPI origin (`BACKEND_URL`).
Run the API with Docker Compose, a VPS, Railway, Fly, Render, or any host that can run the `Dockerfile`.

## Recommended path

### 1. Run the FastAPI app (origin)

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# edit .env — set SECRET_KEY, API_KEY, DATABASE_URL (Postgres in production)
docker compose up --build -d
curl -s http://localhost:8000/api/system/health
```

Expose that origin with HTTPS (Cloudflare Tunnel, load balancer, or your host’s URL).

### 2. Deploy the edge Worker (no Containers)

Workers Builds / local:

| Setting | Value |
|---------|--------|
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |

```bash
npm install
npx wrangler deploy
npx wrangler secret put BACKEND_URL
# paste origin only, no trailing slash, e.g. https://eti.example.com
```

Optional: custom domain on the Worker in the dashboard.

### 3. Verify

```bash
curl -s https://elite-trading-intelligence-eti.<subdomain>.workers.dev/api/system/health
# or your custom domain
```

If `BACKEND_URL` is unset, the Worker returns HTTP 503 JSON explaining configuration.

## Why Containers were removed

Cloudflare Containers required a paid plan and Containers API entitlement. Deploy was failing with:

```text
GET /accounts/.../containers/me → 401 Unauthorized
```

after a successful image build and Worker upload. The edge Worker no longer references Containers, Durable Object container classes (retired via migration `v2`), or `@cloudflare/containers`.

## Environment variables

### On the FastAPI origin (required)

| Variable | Notes |
|----------|--------|
| `SECRET_KEY` | Long random string |
| `API_KEY` | Protects mutating routes (`X-API-Key`) |
| `DATABASE_URL` | Prefer Postgres in production (see `docs/POSTGRES.md`) |
| Provider keys | Alpaca, Binance, FRED, NewsAPI, Quiver, Liquid as needed |
| `LIVE_TRADING_ENABLED` | Keep `false` until intentional |

### On the Worker

| Variable | Notes |
|----------|--------|
| `BACKEND_URL` | **Required** for real traffic. Origin of FastAPI, no trailing slash |

Do **not** put broker secrets on the Worker; keep them only on the origin.

## Cloudflare Tunnel (origin without public IP)

```bash
# on the host running docker compose / uvicorn
cloudflared tunnel --url http://localhost:8000
# or a named tunnel + DNS route in the dashboard
```

Point `BACKEND_URL` at the tunnel hostname, or put the Worker in front of the tunnel hostname.

## Workers Builds checklist

1. Project type: **Worker** (not Pages).
2. Build: `npm install`
3. Deploy: `npx wrangler deploy`
4. After first deploy: `npx wrangler secret put BACKEND_URL`
5. If an old Containers-based deployment exists, migration `v2` deletes class `EtiContainer`. If deploy still complains about legacy bindings, delete the Worker once in the dashboard and redeploy.

## Local Python (no Docker)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
```

## Security

- Set `API_KEY` on the origin; send `X-API-Key` on POST routes.
- Keep `LIVE_TRADING_ENABLED=false` until keys and risk limits are verified.
- Quiver is research-only; never used for order placement.
- Worker only proxies HTTP; it does not hold trading secrets.

## Post-deploy checks

```bash
curl -s "$ORIGIN/api/system/health"
curl -s "$ORIGIN/api/providers/status"
curl -s -H "X-API-Key: $API_KEY" -X POST "$ORIGIN/api/trading/order" ...
```
