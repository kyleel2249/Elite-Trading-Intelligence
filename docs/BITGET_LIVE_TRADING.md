# Bitget live trading

ETI now supports explicitly confirmed Bitget live orders through the master-authenticated `POST /api/orders/live` endpoint. This is separate from the existing ETI Internal Paper, Alpaca Paper and Binance Spot/Futures Testnet paths.

## Supported Bitget account API mode

The order adapter uses Bitget's Classic V2 spot, margin and contract endpoints, matching the existing ETI Bitget account/history connector. If the Bitget account has been upgraded to Unified Trading Account (UTA) and requires V3 order endpoints, do not enable live orders with this Classic V2 adapter; the UTA V3 order and account-mode adapter must be implemented and tested first.

## Required Worker secrets and optional GitHub Actions sync

- `BITGET_API_KEY` — Bitget API key with trade permission enabled.
- `BITGET_API_SECRET` — matching API secret.
- `BITGET_API_PASSPHRASE` — matching API passphrase.
- `ETI_EXECUTION_TOKEN` — master ETI token required for live order submission.

Create a Bitget API key with **trade permission only**. Keep withdrawal and transfer permissions disabled. Never place API credentials in `wrangler.jsonc`, the browser, or source control. If the matching GitHub Actions secrets are present, the deploy workflow syncs them into Worker secrets. Otherwise, existing Cloudflare Worker secrets are retained; post-deploy readiness verifies that all three are present.

## Markets and order sizing

The Bitget order adapter supports spot, cross margin, isolated margin, USDT-margined futures, USDC-margined futures and coin-margined futures. Spot and margin market buys use quote-currency `quoteAmount`; spot/margin sells and limit orders use base-coin quantity. Futures use contract quantity and the selected product type, margin mode and leverage. The futures adapter sets margin mode and leverage before placing the order. The exchange can still reject a symbol, leverage, size, or margin configuration that its current contract rules do not permit.

ETI requires a valid reference price for notional validation except quote-sized market buys. Defaults are a 10,000 quote-unit maximum notional and a 150x maximum futures leverage; both are configurable with `ETI_BITGET_MAX_NOTIONAL_USDT` and `ETI_BITGET_MAX_LEVERAGE`. The exchange's own lower contract limits always take precedence.

## Safeguards and outcomes

- `ETI_BITGET_LIVE_ENABLED=true` is the explicit live adapter switch.
- Only the master ETI execution token can authorise Bitget live orders; automatic paper/testnet sessions cannot.
- `ETI_KILL_SWITCH=true` blocks every new order.
- `riskConfirmed: true`, a valid execution source and a unique ETI client order ID are required.
- Each client order ID is reserved in `ETI_EXECUTION_LOG` before contacting Bitget. An ambiguous network result stays reserved; check Bitget order history before retrying.
- Bitget acknowledgements mean accepted, not necessarily filled. Confirm final status and fills in Bitget order history.
- No withdrawal, transfer, or funding endpoints are exposed by this adapter.

## Market data refresh

The Bitget spot and all three perpetual-futures symbol catalogues refresh at a maximum 60-second cache interval. The dashboard reloads pair lists every 60 seconds. Cross/isolated margin pairs are added from Bitget's public margin-pair catalogue and chart against Bitget spot candles. The scheduled Bitget account/fill-history sync runs on ETI's one-minute monitor cron when credentials and KV storage are configured.

