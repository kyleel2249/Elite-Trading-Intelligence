# ETI — Elite Trading Intelligence

Production-oriented multi-asset trading intelligence platform.

**Repository:** https://github.com/kyleel2249/Elite-Trading-Intelligence  
**Owner:** kyleel2249  
**Primary branch:** main

## Status

This is the clean foundation matching the original ETI concept:

- Unified provider architecture (Alpaca + Binance)
- Strong risk engine with hard limits and veto authority
- Live trading path **enabled** but fully gated by the risk engine
- Paper / testnet paths as primary safe defaults
- FastAPI core, SQLAlchemy models, configuration via environment
- Security-first credential handling

Live trading will never execute without:
1. Explicit `LIVE_TRADING_ENABLED=true`
2. Provider-specific live flags
3. Passing RiskEngine checks (size, daily loss, drawdown, position limits, data freshness)
4. Valid instrument and order precision

## Quick Start (Local)

```bash
git clone https://github.com/kyleel2249/Elite-Trading-Intelligence.git
cd Elite-Trading-Intelligence
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your keys
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000

## Architecture (High Level)

```
app/
├── main.py                 # FastAPI entry
├── config.py               # Central settings
├── database.py
├── models.py
├── schemas.py
├── risk/
│   └── engine.py           # RiskEngine (veto authority)
├── market/
│   ├── normalization.py
│   ├── data_quality.py
│   └── service.py
├── integrations/
│   ├── base.py
│   ├── registry.py
│   ├── alpaca/
│   └── binance/
├── trading/
│   ├── paper.py
│   └── live.py             # Live path (risk-gated)
├── intelligence/
│   └── council.py          # AI Trading Council scaffold
└── templates/ + static/
```

## Safety Rules

- Secrets never leave environment variables / server side
- No withdrawal permissions requested
- RiskEngine has final veto on every order
- Live orders require fresh validated data when configured
- Default risk per trade: 1% of equity
- Clear separation of paper vs live credentials and endpoints

## Next Implementation Waves

1. Complete Alpaca + Binance market data + WebSocket clients
2. Full data-quality + normalization pipeline
3. Paper trading engine + journal
4. Risk-gated live order submission
5. AI Trading Council specialists + decision aggregation
6. Predictive research layer (probabilistic only)
7. Dashboard upgrades
8. Comprehensive tests + CI

## License & Disclaimer

Research and trading software. Use at your own risk. Past performance is not indicative of future results. Live trading can result in loss of capital.
