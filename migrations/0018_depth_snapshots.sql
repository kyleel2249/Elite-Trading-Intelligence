-- Durable, bounded order-book depth snapshots for historical liquidity analysis (additive; no existing table is altered).
-- One row per venue/market/symbol per 5-second bucket: INSERT OR IGNORE on the primary key makes concurrent or retried writes idempotent.
-- Snapshots are market observations, not financial or audit records, so retention pruning is permitted (see worker/analysis/depth-store.ts).
CREATE TABLE IF NOT EXISTS eti_depth_snapshots (
  venue TEXT NOT NULL CHECK(venue IN ('bybit','bitget')),
  market TEXT NOT NULL CHECK(market IN ('spot','futures')),
  symbol TEXT NOT NULL,
  bucket_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  best_bid REAL NOT NULL CHECK(best_bid > 0),
  best_ask REAL NOT NULL CHECK(best_ask >= best_bid),
  bids_json TEXT NOT NULL,
  asks_json TEXT NOT NULL,
  PRIMARY KEY (venue, market, symbol, bucket_at)
);
CREATE INDEX IF NOT EXISTS idx_eti_depth_snapshots_time ON eti_depth_snapshots(bucket_at);
