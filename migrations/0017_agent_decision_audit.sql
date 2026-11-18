-- Immutable, durable audit snapshots for the existing twelve-agent orchestration.
-- Each row preserves the full validated reports, evidence, message bus, risk decision and final decision.
CREATE TABLE IF NOT EXISTS eti_agent_decisions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('BUY','SELL','NO_TRADE')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  executed INTEGER NOT NULL DEFAULT 0 CHECK(executed IN (0,1)),
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eti_agent_decisions_created
  ON eti_agent_decisions(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_eti_agent_decisions_symbol_created
  ON eti_agent_decisions(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eti_agent_decisions_action_created
  ON eti_agent_decisions(action, created_at DESC);

-- Audit snapshots are append-only. Corrections are new records, never in-place edits.
CREATE TRIGGER IF NOT EXISTS eti_agent_decisions_no_update
BEFORE UPDATE ON eti_agent_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent decision snapshots are immutable');
END;
CREATE TRIGGER IF NOT EXISTS eti_agent_decisions_no_delete
BEFORE DELETE ON eti_agent_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent decision snapshots are immutable');
END;
