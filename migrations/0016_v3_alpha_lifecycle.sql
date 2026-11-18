-- Persistent ETIAlgo signal lifecycle state. Existing signal rows retain their original data and default to confirmed.
ALTER TABLE eti_v3_alpha_signals
  ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'confirmed'
  CHECK (lifecycle_status IN ('confirmed','entry_reached','tp1_reached','tp2_reached','tp3_reached','invalidated','expired'));
ALTER TABLE eti_v3_alpha_signals ADD COLUMN lifecycle_updated_at INTEGER;
ALTER TABLE eti_v3_alpha_signals ADD COLUMN lifecycle_note TEXT;
CREATE INDEX IF NOT EXISTS idx_eti_v3_alpha_lifecycle ON eti_v3_alpha_signals(lifecycle_status, signal_time DESC);
