# ETI user guide

ETI is a research, risk and paper-trading system. It tells you what it can verify, what it cannot, and when the right answer is **not to trade**. Nothing here is investment advice.

## 1. Pages

The FastAPI service serves these pages (the Cloudflare Worker build serves its own dashboard):

| Page | What it is for |
|---|---|
| `/` | Main dashboard: market snapshot, council analysis, paper portfolio, journal |
| `/markets` | Per-market hours, liquidity, cost profiles and tradability (`/api/markets/assess?symbol=EURUSD`) |
| `/predictions` | Append-only forecast ledger, accuracy and calibration metrics |
| `/alpha` | Global Alpha research: discovery, validation, strategy competition |
| `/alerts` | Alerts |
| `/data-intel` | Command-centre data views |
| `/static/market3d.html` | 3D price x time x volume view built from real Binance candles |

## 2. Reading the 3D view

Each column is one candle (green = close at or above open, red = below), thin lines are wicks, and the blue row in front is volume. Drag or use the arrow keys to rotate, `+`/`-` or the buttons to zoom. It is read-only. If the data cannot be loaded the chart is blank and says so. If the newest candle is older than expected it is labelled **STALE**. It is a way to look at the data, not a signal.

## 3. How ETI decides whether to trade

1. **Market readiness** (`GET /api/readiness` on the Worker): twelve factors give Favourable / Selectively favourable / Uncertain / High risk / Avoid trading. Anything that cannot be verified is reported as *not evaluated* and lowers the verdict. Favourable is never an entry signal.
2. **Signals** (`GET /api/signals`, `GET /api/precision/signal`): BUY, SELL or WAIT/NO TRADE with entry, stop and targets. The score is a heuristic confluence score, **not a probability**. About 18 hard gates can force NO TRADE regardless of score. A displayed historical win rate is withheld below 20 samples and excludes fees and slippage.
3. **Trading council** (`GET /api/intelligence/council`): specialist views, contradictions and a risk veto from the risk officer.
4. **Risk engine**: absolute veto. Every order, paper or live, passes it.

Do not trade when readiness says Avoid, data is stale, or the risk engine vetoes. ETI treats staying out as a valid outcome.

## 4. Paper trading

Paper orders cost nothing and need no exchange credentials (internal paper engine, see [PAPER_TRADING.md](PAPER_TRADING.md)). Equity, positions, drawdown and data freshness are derived by the server; values sent in a request are ignored. Review `/api/paper-trading/portfolio`, `/positions`, `/journal` and `/history`. Judge a strategy on a meaningful number of paper trades, after costs, before considering anything else.

## 5. Risk limits (defaults from `.env.example`)

| Setting | Default |
|---|---|
| `DEFAULT_RISK_PER_TRADE_PCT` | 1.0 |
| `MAX_DAILY_LOSS_PCT` | 3.0 |
| `MAX_PORTFOLIO_DRAWDOWN_PCT` | 10.0 |
| `MAX_OPEN_POSITIONS` | 8 |
| `MAX_POSITION_NOTIONAL_PCT` | 6.0 |
| `KILL_SWITCH` | false (set `true` to halt all order submission) |

## 6. Live trading

Live trading is **off by default**. It needs every one of: `LIVE_TRADING_ENABLED=true`, provider live flags and credentials (`BINANCE_LIVE_TRADING_ENABLED=true`, or `ALPACA_PAPER=false` plus live keys), an `API_KEY` configured on the server, fresh market data, an explicit per-order live confirmation, a verifiable stop loss within the risk limits, and risk-engine approval. Any failure refuses the order. See [LIVE_TRADING.md](LIVE_TRADING.md) and [DEPLOYMENT.md](DEPLOYMENT.md) for the pre-live checklist. The Cloudflare Worker build has no live order path at all.

## 7. What is and is not connected

Check `GET /api/providers/status` and `GET /api/execution/status`. A provider with no credentials reports as not configured; ETI does not simulate a connection. Forex, non-US stocks, futures and options are analysis-only until an execution adapter exists ([MARKETS.md](MARKETS.md)).
