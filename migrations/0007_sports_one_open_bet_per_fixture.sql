-- Enforce one open model-backed paper stake per fixture, even across model upgrades.
-- If legacy model versions left multiple open stakes, keep the earliest and refund/void the rest.
DROP INDEX IF EXISTS sports_bets_one_open_model_bet_per_event;

UPDATE sports_bankroll
SET balance_cents = balance_cents + COALESCE((
  SELECT SUM(duplicate.stake_cents)
  FROM sports_bets AS duplicate
  WHERE duplicate.event_id IS NOT NULL
    AND duplicate.model_version IS NOT NULL
    AND duplicate.status = 'OPEN'
    AND EXISTS (
      SELECT 1
      FROM sports_bets AS keeper
      WHERE keeper.event_id = duplicate.event_id
        AND keeper.model_version IS NOT NULL
        AND keeper.status = 'OPEN'
        AND (
          keeper.created_at < duplicate.created_at
          OR (keeper.created_at = duplicate.created_at AND keeper.id < duplicate.id)
        )
    )
), 0),
updated_at = strftime('%s','now') * 1000
WHERE id = 1;

UPDATE sports_bets
SET status = 'VOID',
    profit_cents = 0,
    settled_at = strftime('%s','now') * 1000
WHERE event_id IS NOT NULL
  AND model_version IS NOT NULL
  AND status = 'OPEN'
  AND EXISTS (
    SELECT 1
    FROM sports_bets AS keeper
    WHERE keeper.event_id = sports_bets.event_id
      AND keeper.model_version IS NOT NULL
      AND keeper.status = 'OPEN'
      AND (
        keeper.created_at < sports_bets.created_at
        OR (keeper.created_at = sports_bets.created_at AND keeper.id < sports_bets.id)
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS sports_bets_one_open_model_bet_per_fixture
ON sports_bets(event_id)
WHERE event_id IS NOT NULL AND model_version IS NOT NULL AND status='OPEN';
