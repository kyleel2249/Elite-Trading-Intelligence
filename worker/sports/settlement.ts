/**
 * Settlement of sports paper bets from results that are already stored in D1.
 *
 * The history sync inserts a result, marks predictions, and settles open bets in separate statements. A failure in between
 * (provider error, Worker timeout) leaves a stored result whose bets are still OPEN, and because the fixture is then treated
 * as "already seen" the sync never revisits it. This pass closes that gap and is idempotent: every update is guarded by
 * status='OPEN' / actual_outcome IS NULL, and the bankroll credit is chained to the bet update with changes()=1.
 */
export interface SettlementResult { predictionsSettled: number; betsSettled: number }

export function fullTimeResultWon(market: string, selection: string, outcome: "H" | "D" | "A"): boolean | null {
  if (String(market || "").toLowerCase() !== "full time result") return null;
  const s = String(selection || "").toLowerCase();
  if (s === "home") return outcome === "H";
  if (s === "draw") return outcome === "D";
  if (s === "away") return outcome === "A";
  return null;
}

export async function settleFromStoredResults(d: D1Database, now: number): Promise<SettlementResult> {
  const preds = await d.prepare(
    "UPDATE sports_model_predictions SET actual_outcome=(SELECT CASE WHEN r.home_goals>r.away_goals THEN 'H' WHEN r.home_goals<r.away_goals THEN 'A' ELSE 'D' END FROM sports_match_results r WHERE r.fixture_id=sports_model_predictions.fixture_id), settled_at=? WHERE actual_outcome IS NULL AND EXISTS (SELECT 1 FROM sports_match_results r WHERE r.fixture_id=sports_model_predictions.fixture_id)"
  ).bind(now).run();
  const open = await d.prepare(
    "SELECT b.id,b.market,b.selection,b.odds,b.stake_cents,r.home_goals,r.away_goals FROM sports_bets b JOIN sports_match_results r ON r.fixture_id=b.event_id WHERE b.status='OPEN' AND b.event_id IS NOT NULL LIMIT 100"
  ).all<any>();
  let betsSettled = 0;
  for (const bet of open.results || []) {
    const hg = Number(bet.home_goals), ag = Number(bet.away_goals);
    const outcome = hg > ag ? "H" : hg < ag ? "A" : "D";
    const won = fullTimeResultWon(bet.market, bet.selection, outcome);
    if (won === null) continue;
    const stake = Number(bet.stake_cents);
    const gross = won ? Math.round(stake * Number(bet.odds)) : 0;
    const profit = gross - stake;
    const res = await d.batch([
      d.prepare("UPDATE sports_bets SET status=?,profit_cents=?,settled_at=? WHERE id=? AND status='OPEN'").bind(won ? "WON" : "LOST", profit, now, bet.id),
      d.prepare("UPDATE sports_bankroll SET balance_cents=balance_cents+?,updated_at=? WHERE id=1 AND changes()=1").bind(gross, now),
    ]);
    if (res[0]?.meta?.changes) betsSettled++;
  }
  return { predictionsSettled: Number((preds as any)?.meta?.changes || 0), betsSettled };
}
