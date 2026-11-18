# Bitget WebSocket transport matrix

The browser adapter exposes `window.ETIBitget.subscribeTransport(options, handlers)` for public streams and `subscribePrivate(options, handlers)` for authenticated streams.

## Supported endpoint matrix

| Environment | Account/protocol | Public | Private |
|---|---|---|---|
| Production | UTA V3 JSON | `wss://ws.bitget.com/v3/ws/public` | `wss://ws.bitget.com/v3/ws/private` |
| Production | UTA V3 SBE | `wss://ws.bitget.com/v3/ws/public/sbe` | Not applicable |
| Demo | UTA V3 JSON | `wss://wspap.bitget.com/v3/ws/public` | `wss://wspap.bitget.com/v3/ws/private` |
| Production | Classic V2 | `wss://ws.bitget.com/v2/ws/public` | `wss://ws.bitget.com/v2/ws/private` |

Bitget does not document a Demo Classic V2 endpoint in this matrix. The adapter deliberately rejects `environment: "demo", account: "classic"` instead of silently routing it to production. SBE is public UTA market data only and is enabled only on the documented production SBE URL; Bitget does not document a separate Demo SBE URL in its endpoint matrix.

## Browser usage

```js
const stream = window.ETIBitget.subscribeTransport({
  symbol: "BTCUSDT",
  market: "futures",          // "spot" or "futures"
  category: "USDT-FUTURES",  // USDT-FUTURES, USDC-FUTURES, COIN-FUTURES
  environment: "demo",       // "production" or "demo"
  account: "uta",            // "uta" or "classic"
  protocol: "json"           // "json" or "sbe" (SBE is UTA public only)
}, {
  onStatus: console.log,
  onMessage: console.log
});
```

For Classic V2, the subscription adapter uses `instType`, `channel`, and `instId`; candle intervals are encoded in channel names (for example, `candle1m`). UTA V3 uses `instType`, `topic`, `symbol`, and `interval`.

## Private stream usage and credentials

```js
const privateStream = window.ETIBitget.subscribePrivate({
  environment: "demo", // defaults to production
  account: "uta"        // "uta" or "classic"
}, {
  onStatus: console.log,
  onMessage: console.log
});
```

Private browser sessions connect only to the same-origin ETI relay and require the authenticated operator session. Bitget API credentials and signatures remain in Worker bindings. Configure separate credentials for each account mode:

- Production UTA: `BITGET_API_KEY`, `BITGET_API_SECRET`, `BITGET_API_PASSPHRASE`
- Demo UTA: `BITGET_DEMO_API_KEY`, `BITGET_DEMO_API_SECRET`, `BITGET_DEMO_API_PASSPHRASE`
- Production Classic: `BITGET_CLASSIC_API_KEY`, `BITGET_CLASSIC_API_SECRET`, `BITGET_CLASSIC_API_PASSPHRASE`

Demo must use a Demo API key created while the Bitget account is in Demo mode. Do not copy production credentials into demo variables. Never commit credentials or send them in chat.

UTA private topics are account, order, position and fill. Classic private subscriptions cover Spot account/order and USDT-, USDC-, and Coin-margined futures order/position channels.

## SBE decoder

The SBE client decodes little-endian FIX SBE frames for template IDs 1001 (Depth50), 1002 (BBO) and 1003 (public trades), validates schema ID, frame lengths and group bounds, applies price/size exponents, and surfaces sequence metadata. Binary frames are requested by setting `protocol: "sbe"`. The browser sets `binaryType = "arraybuffer"`.

Depth50 schema v5 exposes `pseq` and `depthAction`; consumers should treat a gap or an incremental update without a valid base snapshot as a reason to rebuild the book from REST. Historical candles/trades must be backfilled through REST because the current V3 stream pushes updates only.
Depth50 schema v5 exposes `pseq` and `depthAction`. The browser adapter merges incremental levels, ignores duplicate sequence numbers, and reconnects after a missing base snapshot or continuity gap to request a fresh stream snapshot; consumers should still use REST snapshots as the recovery fallback. Historical candles/trades must be backfilled through REST because the current V3 stream pushes updates only. UTA order and fill channels do not send a complete initial order/fill history on subscription; reconcile existing orders and historical fills through REST.

## Operational boundaries

- The public client retries with exponential backoff, re-subscribes after reconnect, sends 30-second heartbeats, and reports transport errors through `onStatus` / `onMessage`.
- The private relay also sends 30-second upstream heartbeats and authenticates separately for each environment/account pair.
- These WebSockets deliver market/account events; they do not themselves reconcile durable portfolio state, enable Agent Council order execution, or guarantee that a real Bitget account is reachable.
- A successful unit test or deployment is not proof of live exchange connectivity. Verify each environment with its own credentials and a live operator session before enabling any dependent workflow.
