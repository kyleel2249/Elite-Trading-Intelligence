# Cloudflare deployment for ETI

ETI is a **Python FastAPI** application. It does **not** run inside Cloudflare Workers or Containers.

The repo ships a **plain Worker** that reverse-proxies to your FastAPI origin (`BACKEND_URL`).
Run the API on Fly.io (workflow included), a self-hosted Docker machine behind a Cloudflare Tunnel, or any host that can run the `Dockerfile`.

## Fixing: `"status": "misconfigured" — BACKEND_URL is not set`

That JSON is the Worker telling you the origin has not been connected. It is not a crash. Fix = deploy the origin, then set one variable.

### Step 1 — Deploy the FastAPI origin (no Render)

**Option A: Fly.io via GitHub Actions (automated, config in `fly.toml`)**

1. Install flyctl locally once and run `fly auth login`, then `fly tokens create deploy` (or create an org token) to get a token.
2. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `FLY_API_TOKEN`
   - `API_KEY` and `SECRET_KEY` (long random values, e.g. `openssl rand -hex 32`)
   - for the Worker job: `CLOUDFLARE_API_TOKEN` (Workers Edit permission) and `CLOUDFLARE_ACCOUNT_ID`
   - optional provider keys: `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `FRED_API_KEY`, `NEWSAPI_KEY`, `QUIVER_API_KEY`
3. **Actions → Deploy (Fly.io origin + Cloudflare Worker) → Run workflow.** It creates the app and a 1 GB volume if missing, sets secrets, deploys, waits for `/api/system/health`, then deploys the Worker with `BACKEND_URL` set to `https://<app>.fly.dev`.

If the app name `eti-trading-intelligence` is taken, change `app` in `fly.toml` (or set repository variable `FLY_APP`). Fly.io is a paid service with no free tier; the config uses one small always-on machine (needed for the background jobs). SQLite lives on the volume, so keep a single machine, or switch `DATABASE_URL` to Postgres to scale out.

**Option B: Self-host with a Cloudflare Tunnel (no cloud host, free)**

Run on any machine or VPS you control:

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# edit .env: APP_ENV=production, SECRET_KEY, API_KEY, TUNNEL_TOKEN
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up --build -d
```

Create the tunnel token in Cloudflare Zero Trust → Networks → Tunnels, and add a public hostname pointing at `http://eti:8000`. Your origin is then `https://<that hostname>`. The machine must stay on for the site to stay up.

**Option C: any other Docker host** (Railway, a VPS, Koyeb, Cloud Run): build the `Dockerfile`; it honors `$PORT` and defaults to 8000.

### Step 2 — Give the Worker its `BACKEND_URL`

Use **one** of these (they are alternatives, do not combine a secret and a variable with the same name):

```bash
# CLI (recommended; stored as an encrypted secret, survives redeploys)
npx wrangler secret put BACKEND_URL
# paste the origin only, no trailing slash, e.g. https://eti-trading-intelligence.fly.dev
```

or dashboard: **Workers & Pages → elite-trading-intelligence-eti → Settings → Variables and Secrets → Add** `BACKEND_URL`.
`wrangler.jsonc` sets `keep_vars: true`, so dashboard-defined variables are no longer wiped by each deploy.

### Step 3 — Verify

```bash
curl -s https://elite-trading-intelligence-eti.<subdomain>.workers.dev/__eti/status
# {"status":"configured","backend":"https://eti-trading-intelligence.fly.dev"}
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

`.github/workflows/deploy.yml` (manual run) deploys the origin and then the Worker with the correct `BACKEND_URL` in one go. Do not also enable Workers Builds for the same Worker, or the two will fight over variables.

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
