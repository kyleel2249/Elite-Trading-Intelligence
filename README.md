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

## Safety

- Live path is **enabled** but every order passes **Helena Frost / RiskEngine**
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
