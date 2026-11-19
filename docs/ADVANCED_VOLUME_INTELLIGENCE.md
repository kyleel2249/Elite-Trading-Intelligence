# ETI Advanced Multi-Market Volume Intelligence

## Scope

The read-only `/api/analysis/volume-profile` endpoint provides exchange-specific Point of Control and Volume Profile analysis. It is integrated with the existing market-data layer and terminal POC panel. Existing signal, risk, paper and execution paths are not changed by this feature.

## Supported inputs

- **Bybit:** public trade prints and candles through ETI's Bybit V5 market-data adapter.
- **Bitget:** public trade prints and candles through ETI's Bitget adapter. If Worker egress is blocked for a request, the terminal can submit the same-origin browser connector's validated prints.
- **Other exchanges and financial feeds:** POST normalized execution prints using `time` (Unix milliseconds), `price`, `qty`, and `isBuyerMaker`. This adapter contract can carry feeds from additional CEXs, brokers, equities, futures, FX and other licensed providers without coupling the profile engine to one vendor.
- **Blockchain / DEX:** POST decoded swap events with `time`, execution `price`, and either `baseQuantity` or `quoteQuantity`; optional `side`, `source`, `txHash` and `pool` are retained as provenance. This supports indexed swap feeds from EVM chains, Solana and other networks when a decoder/indexer supplies execution prices and quantities.

A plain wallet transfer, token mint, bridge transfer, deposit, withdrawal or generic blockchain transaction is **not** an executed market trade and is excluded unless it is decoded into a priced swap. Do not infer a price or trade direction from a transfer alone.

## Endpoint

### Read live exchange data

```http
GET /api/analysis/volume-profile?symbol=BTCUSDT&venue=all&market=futures&bins=64&valueAreaPct=0.7
```

- `venue`: `bybit`, `bitget`, or `all`.
- `market`: `spot` or `futures`.
- `bins`: 24–200 (default 64).
- `valueAreaPct`: 0.5–0.9 (default 0.70).
- `timeframe`: candle interval used for fallback context.

The `all` option returns independent venue profiles and a comparison. It deliberately does not add Bybit and Bitget volume together: the same economic activity may be represented on multiple venues and their liquidity/contract specifications differ.

### Submit normalized multi-source data

```http
POST /api/analysis/volume-profile?symbol=ETHUSDT&venue=bybit&market=futures
Content-Type: application/json
```

```json
{
  "trades": [
    { "time": 1795000000000, "price": 3000, "qty": 0.25, "isBuyerMaker": false }
  ],
  "candles": [
    [1794999960000, 2995, 3005, 2990, 3000, 120]
  ],
  "swaps": [
    {
      "time": 1795000000000,
      "price": 3000,
      "baseQuantity": 2.5,
      "quoteQuantity": 7500,
      "side": "buy",
      "source": "ethereum:uniswap-v3",
      "txHash": "0x...",
      "pool": "0x..."
    }
  ]
}
```

For multiple sources, send a `sources` array. Each source may contain `venue`, `provider`, `trades` and `swaps`. Each exchange trade must include the exchange's reliable maker/aggressor flag. Do not manufacture aggressor-side data.

## Analytics

- Trade-level POC, VAH and VAL when execution prints or decoded swaps are available.
- OHLCV fallback profile when no transaction-level events are supplied. The response explicitly labels this as an approximation.
- Configurable value-area percentage and price-row count.
- Per-price-row buy volume, sell volume, delta and delta percentage when side is known.
- HVN and LVN candidates.
- Developing POC progression through the supplied trade tape.
- UTC Asia, London, New York and off-hours volume summaries.
- Optional historical naked-POC revisit classification when historical POCs and post-formation candles are supplied to the calculation engine.
- Source counts, provider provenance, trade freshness and failure reporting.
- Independent per-venue profiles to prevent misleading cross-exchange volume aggregation.

## Response and safety contract

The endpoint returns `submitsOrder: false` and `liveExecutionAllowed: false`. It is analytical only. The POC panel in the trading terminal first renders the existing candle estimate, then replaces it with the transaction-level profile when the validated feed is available. If the advanced request fails, the candle estimate remains visible and the status reports the failure.

## Coverage limits

There is no single public feed containing every financial transaction worldwide. Private exchange executions, broker fills, OTC trades, dark-pool prints, payment transfers and permissioned market data require the relevant account authorization, licensed feed or operator-configured provider. Public exchange trades are not a substitute for private account executions. Blockchain indexing also depends on chain coverage, RPC/indexer availability, pool discovery and swap decoding. The engine accepts normalized events from these providers, reports source coverage and never labels missing data as live.

Before using the output for live trading, validate each provider's timestamp units, contract multiplier, quantity denomination, quote currency, aggressor-side semantics, symbol mapping, duplicate handling and rate limits. POC is descriptive evidence, not a standalone entry signal or a guarantee that price will revisit the level.
