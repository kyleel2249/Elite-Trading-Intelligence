# Live trading integration

Live orders always pass **Helena Frost / RiskEngine** before provider submission.

## Requirements

1. `LIVE_TRADING_ENABLED=true`
2. Provider credentials configured
3. For Binance live: `BINANCE_LIVE_TRADING_ENABLED=true` and live keys
4. For Alpaca live: `ALPACA_PAPER=false` and live base URL/keys
5. Optional: `API_KEY` set — send header `X-API-Key` on mutating routes

## Strategy runner

```bash
# Paper
curl -X POST localhost:8000/api/backtest/signal -H 'Content-Type: application/json' \
  -d '{"module_id":"minervini_vcp","symbol":"BTCUSDT","environment":"paper","qty":0.01,"execute":true}'

# Live (blocked unless flags + keys OK)
curl -X POST localhost:8000/api/backtest/signal -H 'Content-Type: application/json' \
  -d '{"module_id":"turtle_trend","symbol":"BTCUSDT","environment":"live","qty":0.01,"execute":true}'
```

## ETI desk on every path

- Adrian Cole — synthesis
- Elena Varga — technical / VCP structure
- Helena Frost — risk veto
- Omar Diallo — execution
- Claire Bennett — journal/audit
- Kenji Mori — quant/backtest discipline

Historical knowledge traders (Soros, Buffett, …) inform **strategy modules & attribution**, not direct order placement without risk checks.
