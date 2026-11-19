# ETI MT5 Windows Bridge

A local Windows connector that controls an installed MetaTrader 5 terminal through the official MetaTrader5 Python package. It supports demo and live account login, account snapshots, symbols, ticks, positions, pending orders, deal history and risk-checked execution.

## Security model

- The service binds to `127.0.0.1` only. Do not change this to `0.0.0.0` or expose port 8765 to the internet.
- The broker login and password are submitted directly to this local process and passed to the MT5 terminal. They are never written to disk or logged.
- All API routes except `/health` require a bearer token.
- Live execution is disabled unless the Windows operator explicitly sets `ETI_MT5_LIVE_TRADING=true`.
- Every new order requires SL and TP, validates broker volume rules, calculates stop-loss cash risk and applies the configured maximum risk percentage, then calls `order_check` before `order_send`.
- Use a dedicated MT5 demo account first. Do not grant withdrawal permissions (MT5 trading credentials do not provide withdrawal functionality).

## Install on Windows

1. Install MetaTrader 5 from your broker and sign in to a demo account once.
2. Install 64-bit Python 3.11 or 3.12.
3. Open PowerShell in this folder and run:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\start-mt5-bridge.ps1
   ```

4. Keep the terminal and bridge running. The launcher prints a random bearer token once.
5. Health check: `http://127.0.0.1:8765/health`.

## API

Send `Authorization: Bearer <token>` on authenticated calls.

- `POST /login`: `{ "login": 123456, "password": "...", "server": "Broker-Demo", "terminal_path": "C:\\Program Files\\..." }`
- `POST /logout`
- `GET /account`
- `GET /symbols?search=EUR`
- `GET /tick/EURUSD`
- `GET /positions`
- `GET /orders`
- `GET /history/deals?days=30`
- `POST /orders`: market or pending order with explicit `sl` and `tp`
- `POST /positions/close`: full or partial close by position ticket

Example order:

```json
{ "symbol":"EURUSD", "side":"buy", "volume":0.01, "order_type":"market", "sl":1.0800, "tp":1.0900 }
```

## Demo/live policy

The bridge accepts both demo and live MT5 accounts. Demo trading is available with live mode disabled. Real-money orders are rejected by default. To enable them after demo validation, set `ETI_MT5_LIVE_TRADING=true` in the Windows environment before starting the bridge. Keep `ETI_MT5_MAX_RISK_PERCENT` at or below 1.0 unless an independently reviewed risk policy requires otherwise.

## Current integration boundary

This is the local MT5 execution adapter and API. It does not yet create a cloud-paired ETI account registry, remote command queue, or ETI dashboard account selector. Those require a separately authenticated cloud bridge protocol; never expose this local API publicly or place broker passwords in ETI's Cloudflare Worker.
