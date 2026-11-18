-- Institutional ownership aggregated from SEC Form 13F bulk data sets by scripts/13f-build.ts (offline pipeline).
-- Applied by: npx wrangler d1 migrations apply eti-portfolio-db --remote   |   Read-only from the Worker (worker/analysis/institutional.ts).
-- One row per quarter and CUSIP. `ticker` is resolved through OpenFIGI and may be NULL when unresolved.
CREATE TABLE IF NOT EXISTS inst_holdings (
  period TEXT NOT NULL,            -- quarter end, YYYY-MM-DD
  cusip TEXT NOT NULL,
  ticker TEXT,
  issuer TEXT NOT NULL,
  shares REAL NOT NULL,            -- total reported shares (SH only, no options/bonds)
  prev_shares REAL,                -- same CUSIP in the previous quarter's data set
  value_usd REAL,
  holders INTEGER NOT NULL,        -- distinct 13F filings reporting the CUSIP
  prev_holders INTEGER,
  top_json TEXT NOT NULL,          -- JSON [{name,cik,shares}] top filers by shares
  PRIMARY KEY (period, cusip)
);
CREATE INDEX IF NOT EXISTS inst_holdings_ticker ON inst_holdings (ticker, period);
CREATE TABLE IF NOT EXISTS inst_meta (
  period TEXT PRIMARY KEY,
  loaded_at TEXT NOT NULL,
  source TEXT NOT NULL,
  filings INTEGER NOT NULL,        -- 13F filings aggregated
  rows_scanned INTEGER NOT NULL,
  rows_kept INTEGER NOT NULL,
  cusips INTEGER NOT NULL,
  tickers_resolved INTEGER NOT NULL,
  note TEXT
);
