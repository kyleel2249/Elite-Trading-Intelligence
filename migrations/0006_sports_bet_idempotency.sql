-- Prevent duplicate open model-backed paper exposure on the same fixture/model.
-- A settled fixture can no longer be re-entered because its kickoff is in the past.
CREATE UNIQUE INDEX IF NOT EXISTS sports_bets_one_open_model_bet_per_event
ON sports_bets(event_id, model_version)
WHERE event_id IS NOT NULL AND model_version IS NOT NULL AND status='OPEN';
