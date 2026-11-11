# ETI analytics (`/api/analytics/*`)

Stateless research and risk computations in `app/analytics/` (stdlib only), exposed by `app/api/analytics.py`.
Nothing here places orders; execution stays behind the RiskEngine. Where inputs are
insufficient, results say `insufficient_data` instead of guessing.

| Capability | Endpoint | Notes |
|---|---|---|
| Multi-market scan, ranking, watchlist | `GET /scan?symbols=A,B,C` | Candles via `MarketService` (provider must support the symbol). Ranking is an attention heuristic, not a probability. |
| Market regime | `GET /regime` | Efficiency ratio + EMA 20/50 + volatility percentile |
| Unusual volume | `GET /unusual-volume` | Relative volume and z-score vs 20-bar baseline |
| Volatility breakout | `GET /volatility-breakout` | Squeeze + ATR expansion + channel break |
| Correlation | `GET /correlation?symbols=` | Pearson on aligned returns, concentration warnings |
| Monte Carlo | `GET /monte-carlo` | Block bootstrap, seeded, VaR/CVaR, ruin probability |
| Stress test / scenarios | `POST /stress`, `POST /scenario`, `GET /stress/scenarios` | Hypothetical shocks, not historical claims |
| Walk-forward | `POST /walk-forward` | Parameters fit on train window only; scored on unseen window; overfit warning |
| Strategy lab | `POST /strategy-lab/compare` | Same data and costs; full-sample = in-sample |
| Tax lots / transactions | `POST /tax/realized-gains` | FIFO/LIFO/HIFO, CSV option. Support tooling, not tax advice |
| Multi-currency | `POST /portfolio/multi-currency` | Caller-supplied FX rates; missing rates reported, never guessed |
| Live vs backtest | `POST /live-vs-backtest` | Welch t-test on per-trade returns |
| Risk alerts | `POST /risk-alerts` | Drawdown, daily loss, concentration, correlated exposure |
| Research mode | `POST /research` | Evidence-gated: no exposure recommendation until required evidence is supplied |
| Natural-language queries | `POST /query` | Rule-based router to the endpoints above (no LLM) |

Tests: `python -m unittest tests.test_analytics` (also collected by pytest).

## Not implemented yet (needs data providers, persistence or UI)

Economic and earnings calendars (beyond the existing readiness feed), token unlock monitoring, whale activity,
institutional holdings analytics, multi-account persistence, trade-journal UI changes, strategy marketplace,
AI-written daily/weekly reports, voice assistant, historical replay endpoint/UI (the `Replay` class exists),
and any change to live trading. Live trading remains gated as documented in the README.
