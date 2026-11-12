-- ETI portfolio ledger (D1). Applied by: npx wrangler d1 migrations apply eti-portfolio-db --remote
-- Mirrors SCHEMA in worker/portfolio/store.ts (the Worker also creates these tables on first use if they are missing).
CREATE TABLE IF NOT EXISTS pf_events (env TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (env, id));
CREATE INDEX IF NOT EXISTS pf_events_order ON pf_events (env, at, id);
CREATE TABLE IF NOT EXISTS pf_kv (env TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, exp INTEGER, PRIMARY KEY (env, k));
