# Security

- Never commit `.env` or real API keys.
- Secrets are loaded only from environment / secret managers.
- No withdrawal permissions are requested from exchanges.
- Live trading is gated by:
  1. `LIVE_TRADING_ENABLED`
  2. Provider-specific flags
  3. RiskEngine approval
  4. Data freshness (when configured)
- RiskEngine has absolute veto authority.
- Private endpoints must not return raw provider secrets.
