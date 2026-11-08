# Cloudflare deployment for ETI

ETI is a **Python FastAPI** application. It does **not** run inside Cloudflare Workers or Containers.

The repo ships a **plain Worker** that reverse-proxies to your FastAPI origin (`BACKEND_URL`).
Run the API with Render (blueprint included), Docker Compose, a VPS, Railway, Fly, or any host that can run the `Dockerfile`.

## Fixing: `"status": "misconfigured" — BACKEND_URL is not set`

That JSON is the Worker telling you the origin has not been connected. It is not a crash. Fix = deploy the origin, then set one variable.

### Step 1 — Deploy the FastAPI origin

**Option A: Render (one click, `render.yaml` included)**

1. Render dashboard → **New → Blueprint** → select this repo → **Apply**.
2. It builds the `Dockerfile`, creates a Postgres database, and auto-generates `SECRET_KEY` and `API_KEY` (read `API_KEY` under the service's Environment tab; you need it for POST routes).
3. Wait until `https://eti-api.onrender.com/api/system/health` (your service URL) returns `{"status":"ok", ...}`.

Notes: Render's free web tier sleeps when idle (first request is slow) and its free Postgres expires after 30 days; use a paid plan for anything long-lived.

**Option B: Docker Compose on any host**

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# edit .env — set APP_ENV=production, SECRET_KEY, API_KEY, DATABASE_URL (Postgres recommended)
docker compose up --build -d
curl -s http://localhost:8000/api/system/health
```

Expose it over HTTPS (Cloudflare Tunnel, load balancer, or your host's URL). The container honors `$PORT` and defaults to 8000.

### Step 2 — Give the Worker its `BACKEND_URL`

Use **one** of these (they are alternatives, do not combine a secret and a variable with the same name):

```bash
# CLI (recommended; stored as an encrypted secret, survives redeploys)
npx wrangler secret put BACKEND_URL
# paste the origin only, no trailing slash, e.g. https://eti-api.onrender.com
```

or dashboard: **Workers & Pages → elite-trading-intelligence-eti → Settings → Variables and Secrets → Add** `BACKEND_URL`.
`wrangler.jsonc` sets `keep_vars: true`, so dashboard-defined variables are no longer wiped by each deploy.

### Step 3 — Verify

```bash
curl -s https://elite-trading-intelligence-eti.<subdomain>.workers.dev/__eti/status
# {"status":"configured","backend":"https://eti-api.onrender.com"}
curl -s https://elite-trading-intelligence-eti.<subdomain>.workers.dev/api/system/health
```

`/__eti/status` is answered by the Worker itself (never proxied). Responses proxied from the origin carry an `x-eti-proxy: cloudflare-worker` header.

| Worker response | Meaning |
|---|---|
| 503 `misconfigured` | `BACKEND_URL` not set — Step 2 |
| 500 `invalid_backend_url` | Not an absolute `http(s)://` URL |
| 500 `proxy_loop` | `BACKEND_URL` points at the Worker itself |
| 502 `backend_unreachable` | Origin is down, asleep, or not publicly reachable |

## Deploying the Worker

### Workers Builds (Cloudflare dashboard, Git-connected)

| Setting | Value |
|---------|--------|
| Project type | **Worker** (not Pages) |
| Build command | `npm install` |
| Deploy command | `npx wrangler deploy` |

### GitHub Actions (optional)

`.github/workflows/deploy-worker.yml` deploys on changes to the Worker files and injects `BACKEND_URL`:

- Repository **secrets**: `CLOUDFLARE_API_TOKEN` (Workers Edit permission), `CLOUDFLARE_ACCOUNT_ID`
- Repository **variable**: `BACKEND_URL`

Do not enable both Workers Builds and this workflow for the same Worker.

### Local

```bash
npm install
npx wrangler dev --var BACKEND_URL:http://127.0.0.1:8000   # Worker in front of a local uvicorn
npx wrangler deploy
```

## Why Containers were removed

Cloudflare Containers required a paid plan and Containers API entitlement. Deploy was failing with:

```text
GET /accounts/.../containers/me → 401 Unauthorized
```

The edge Worker no longer references Containers, Durable Object container classes (retired via migration `v2`), or `@cloudflare/containers`. If a deploy still complains about legacy bindings, delete the Worker once in the dashboard and redeploy.

## Environment variables

### On the FastAPI origin

| Variable | Notes |
|----------|--------|
| `APP_ENV` | `production` on any public deployment (protected routes fail closed without `API_KEY`) |
| `SECRET_KEY` | Long random string (a startup warning is logged if left default) |
| `API_KEY` | Protects mutating routes (`X-API-Key`) |
| `DATABASE_URL` | Postgres in production (see `docs/POSTGRES.md`); `postgres://` and `postgresql://` URLs are accepted as-is |
| `PORT` | Set by most hosts; the image honors it |
| Provider keys | Alpaca, Binance, FRED, NewsAPI, Quiver, Liquid as needed |
| `LIVE_TRADING_ENABLED` | Keep `false` until intentional |

### On the Worker

| Variable | Notes |
|----------|--------|
| `BACKEND_URL` | **Required.** Origin of FastAPI, no trailing slash |

Do **not** put broker secrets on the Worker; keep them only on the origin.

## Cloudflare Tunnel (origin without public IP)

```bash
cloudflared tunnel --url http://localhost:8000
```

Point `BACKEND_URL` at the tunnel hostname.

## Security

- Set `API_KEY` on the origin; send `X-API-Key` on POST routes.
- Keep `LIVE_TRADING_ENABLED=false` until keys and risk limits are verified.
- Quiver is research-only; never used for order placement.
- The Worker only proxies HTTP; it holds no trading secrets.

## Post-deploy checks

```bash
curl -s "$ORIGIN/api/system/health"
curl -s "$ORIGIN/api/providers/status"
curl -s -H "X-API-Key: $API_KEY" -X POST "$ORIGIN/api/trading/order" ...
```
