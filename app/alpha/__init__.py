"""ETI Global Alpha Intelligence.

Three independent layers:
  Discovery AI  - finds candidates early (app.alpha.discovery)
  Research AI   - studies investors, filings, wallets, strategies
  Decision AI   - independently validates / rejects / authorizes (app.alpha.fusion)

No layer may approve its own conclusions. Execution always passes through
ETI's server-side RiskEngine via TradingService.
"""
ALPHA_VERSION = "1.0.0"
