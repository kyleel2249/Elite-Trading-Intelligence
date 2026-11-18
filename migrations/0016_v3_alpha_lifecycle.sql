-- Separate, idempotent lifecycle journal; existing signal rows remain immutable and require no ALTER TABLE.
CREATE TABLE IF NOT EXISTS eti_v3_alpha_lifecycle (
  signal_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('confirmed','entry_reached','tp1_reached','tp2_reached','tp3_reached','invalidated','expired')),
  updated_at INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  bars_observed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(signal_id) REFERENCES eti_v3_alpha_signals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eti_v3_alpha_lifecycle_status ON eti_v3_alpha_lifecycle(status, updated_at DESC);
