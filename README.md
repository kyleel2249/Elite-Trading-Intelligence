# ETI — Elite Trading Intelligence

Production-oriented multi-asset trading intelligence platform with a named elite desk, risk-gated paper/live paths, and probabilistic research tools.

**Repository:** https://github.com/kyleel2249/Elite-Trading-Intelligence  
**Branch:** `main`

## One-command local demo (Docker)

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
cp .env.example .env
# Optional: add Alpaca / Binance keys to .env
docker compose up --build
```

Open http://localhost:8000  · API docs http://localhost:8000/docs

Health: `curl -s localhost:8000/api/system/health | jq`

## Deploy (origin + Cloudflare edge)

ETI is two pieces: the **FastAPI origin** (Python, runs the app) and an optional **Cloudflare Worker** that only reverse-proxies to it. Workers cannot run the Python app, so the Worker needs `BACKEND_URL`.

**If the Worker returns `"status": "misconfigured"` / `BACKEND_URL is not set`, the origin is not connected yet:**

1. Deploy the origin — one click on Render via [`render.yaml`](render.yaml) (Dashboard → New → Blueprint), or any Docker host (`docker compose up --build`). Confirm `https://<origin>/api/system/health` returns `{"status":"ok"...}`.
2. Point the Worker at it (no trailing slash):

```
npm install
npx wrangler deploy
npx wrangler secret put BACKEND_URL   # https://eti-api.onrender.com
curl https://<worker>.workers.dev/__eti/status
```

Full guide, Workers Builds settings and GitHub Actions deploy: [`docs/CLOUDFLARE.md`](docs/CLOUDFLARE.md).

## Local Python (no Docker)

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000
pytest -q
```

## Elite Trading Desk

| Name | Title |
|------|--------|
| Adrian Cole | Chief Investment Strategist |
| Elena Varga | Technical Analysis Specialist |
| Marcus Okonkwo | Fundamental Analysis Specialist |
| Sofia Rahman | Macroeconomic Analyst |
| Kenji Mori | Quantitative Researcher |
| Nadia Petrova | Market Structure Analyst |
| Jamal Reed | Liquidity Analyst |
| Priya Nair | News and Sentiment Analyst |
| Lars Hagen | Predictive Intelligence Analyst |
| **Helena Frost** | Risk Management Officer (**veto**) |
| Omar Diallo | Execution Analyst |
| Claire Bennett | Portfolio Auditor |

Profiles & methods: `GET /api/intelligence/traders`

## Key APIs

| Area | Endpoints |
|------|-----------|
| Health | `GET /api/system/health` |
| Providers / streams | `GET /api/providers/status` |
| Market | `GET /api/market/snapshot`, `/order-book`, `/history` |
| Council | `GET /api/intelligence/council` |
| Forecast | `GET /api/intelligence/forecast` |
| Forecast accuracy | `POST /api/intelligence/forecast/score`, `GET /api/intelligence/forecast/accuracy` |
| Risk | `GET /api/risk/evaluate` |
| Trading | `POST /api/trading/order` |
| Paper portfolio | `GET /api/paper-trading/portfolio`, `/positions`, `/journal` |
| Reconcile | `POST /api/trading/reconcile` |
| MTM job | `GET /api/system/mtm-status`, `POST /api/system/mtm-run` |

## Authentication

Mutating routes (orders, reconcile, MTM run, strategy execution, monitor control) require the
`X-API-Key` header matching the `API_KEY` environment variable:

```bash
curl -X POST localhost:8000/api/trading/order \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"provider":"binance","environment":"paper","symbol":"BTCUSDT","side":"buy","qty":0.01}'
```

- **Local development** (`APP_ENV=development`): routes are open if `API_KEY` is unset.
- **Production / staging** (`APP_ENV=production|prod|staging`): if `API_KEY` is unset, protected routes
  refuse requests with HTTP 503 instead of running open. Set `APP_ENV` and `API_KEY` on the
  **FastAPI origin** (Docker/host). Optional Cloudflare Worker only proxies to `BACKEND_URL`
  (see `docs/CLOUDFLARE.md`); it does not run the Python app or hold broker secrets.
- **Live orders** are refused (HTTP 403) on any deployment without an `API_KEY`.

## Safety

- Live trading is **disabled by default** (`LIVE_TRADING_ENABLED=false`). When enabled, every order still passes **Helena Frost / RiskEngine** and requires an `API_KEY`
- Risk inputs are **server-derived**: equity, open positions, daily PnL, drawdown and data freshness come from the database and a server-fetched quote. Values sent in the order request body are ignored (the fields remain accepted but deprecated). Responses include `risk_inputs` showing what the risk engine used
- Paper equity = `PAPER_STARTING_EQUITY` + realized + unrealized PnL. Live equity must be configured via `LIVE_ACCOUNT_EQUITY`; until set, live orders are rejected
- Paper/testnet preferred defaults; secrets only via environment
- Forecasts are **probabilistic** (Lars Hagen) — not guarantees
- No withdrawal permissions requested

## Tests & CI

```bash
pytest -q
```

GitHub Actions runs compile + pytest on every push to `main`.

## Disclaimer

Research and trading software. Use at your own risk. Live trading can result in loss of capital.
