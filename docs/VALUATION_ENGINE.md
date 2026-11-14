# Valuation engine (`app/quant`, `/api/valuation`)

Independent fair value, >8% mispricing detection, sentiment *evidence* and fractional-Kelly sizing.
It builds on existing ETI services and never places an order: a confirmed opportunity still has to pass
Global Alpha validation and the RiskEngine (6% notional cap, kill switch, live confirmation).

## What it reuses
* Live price + freshness: `MarketService.get_snapshot`; bankroll: server-side `build_risk_context`.
* SEC facts: Global Alpha's cached SEC client (`app.alpha.context.load_fundamentals`), turned into DCF/DDM
  inputs (the existing `/api/alpha/fundamentals` endpoint holds quality/GARP *screens*).
* Predictions: every flagged mispricing is written to the existing append-only prediction ledger
  (`strategy=mispricing_gt_8pct`) and resolved by the existing resolver job.
* News: the existing NewsAPI feed (`fetch_news_headlines`).

## Endpoints
| Route | Auth | Purpose |
|---|---|---|
| `POST /api/valuation/kelly` | none (pure) | Kelly sizing with the hard caps |
| `POST /api/valuation/evaluate` | API key | price + fair value + mispricing + sizing + ledger entry |
| `GET /api/valuation/fundamentals-inputs/{ticker}` | API key | DCF/DDM inputs from 10-K facts |
| `GET /api/valuation/sentiment/{symbol}` | API key | news sentiment evidence |

## Rules enforced in code
* Mispricing % = (fair value − price) / fair value × 100; flagged only when |x| > 8%. Bands: <3 insignificant,
  3–5 minor, 5–8 developing, >8 material, >12 significant, >20 exceptional (heightened verification).
* "Confirmed" requires every check (fresh price, complete inputs, liquidity, costs below the edge, no event risk,
  models agreeing on direction, realistic horizon). A check nobody verified counts as failed.
* Fair value needs ≥2 valid, asset-appropriate models that agree; otherwise `supported=false` and no number is produced.
  No equity DCF on tokens. Inputs must come from real data; nothing is assumed.
* Kelly: `f* = (b·p − q)/b`, costs inside `b`, win probability replaced by a Wilson lower bound, fractional Kelly
  (default 0.25, clamped 0.25–0.50 via `KELLY_FRACTION`). Capital at risk is capped separately
  (`DEFAULT_RISK_PER_TRADE_PCT`), then notional = min(Kelly, 6% cap, portfolio/sector/correlation room, liquidity).
  Zero or negative edge ⇒ zero size. Config can lower the 6% cap, never raise it.
* Sentiment can never trigger an order (`can_trigger_order` is always false); duplicate/bot/sponsored content is down-weighted.

## Honest limits
* The ledger's `probability` carries valuation-model confidence, not a calibrated win rate.
* News polarity is the feed's keyword proxy; outlet credibility is a small allowlist.
* No peer-multiple data source is wired: supply a second independent model via `fair_value_inputs`, otherwise a lone
  DCF stays "insufficiently supported".
* Overvalued results are flagged but not sized (no shorting on these venues).
* Not wired into Global Alpha fusion yet; `valuation_score` is provided for that.
