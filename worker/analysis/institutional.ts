// Read-only access to the 13F aggregates loaded into D1 by scripts/13f-build.ts. 13F facts to keep in mind (and to tell the user):
//  * Only managers with >= $100M in 13(f) securities file, and only LONG positions are reported: the total is a LOWER BOUND of institutional ownership.
//  * Filings are due 45 days after quarter end, so the data is 6 weeks to ~4.5 months old.
//  * Co-managers can report the same shares; an aggregate above 100% of shares outstanding means double counting and is rejected, not displayed.
export interface D1Like { prepare(sql: string): { bind(...v: unknown[]): { first<T = unknown>(): Promise<T | null> } } }
export interface InstitutionalData {
  status: "loaded" | "no_data" | "unavailable"; ticker: string; period?: string; issuer?: string; holders?: number; prevHolders?: number | null; shares?: number; prevShares?: number | null;
  ownershipPct?: number; changePp?: number; sharesChangePct?: number; top: { name: string; shares: number; pctOfOutstanding?: number }[]; ageDays?: number; warnings: string[]; notes: string[];
}
interface Row { period: string; issuer: string; shares: number; prev_shares: number | null; holders: number; prev_holders: number | null; top_json: string }
const DAY = 86400000;
export async function loadInstitutional(db: D1Like | undefined, ticker: string, sharesOutstanding: number | undefined, now: number): Promise<InstitutionalData> {
  const t = ticker.toUpperCase(), base: InstitutionalData = { status: "unavailable", ticker: t, top: [], warnings: [], notes: [] };
  if (!db) return { ...base, notes: ["Institutional ownership (13F): no database bound. Bind ETI_PORTFOLIO_DB, apply migration 0002 and load a quarter with scripts/13f-build.ts."] };
  if (!/^[A-Z0-9.-]{1,12}$/.test(t)) return { ...base, notes: ["Invalid ticker for the 13F lookup"] };
  let row: Row | null;
  try { row = await db.prepare("SELECT period, issuer, shares, prev_shares, holders, prev_holders, top_json FROM inst_holdings WHERE ticker = ? ORDER BY period DESC LIMIT 1").bind(t).first<Row>(); }
  catch (e) { return { ...base, notes: [`13F table not available (${e instanceof Error ? e.message.slice(0, 80) : "error"}): apply migrations/0002_institutional_holdings.sql`] }; }
  if (!row) return { ...base, status: "no_data", notes: [`No 13F holdings found for ${t}: the ticker may be unresolved in the loaded quarter, or no filer reports it.`] };
  const ageDays = Math.round((now - Date.parse(row.period)) / DAY), out: InstitutionalData = { ...base, status: "loaded", period: row.period, issuer: row.issuer, holders: row.holders, prevHolders: row.prev_holders, shares: row.shares, prevShares: row.prev_shares, ageDays, top: [] };
  try { const top = JSON.parse(row.top_json) as { name: string; shares: number }[]; out.top = top.slice(0, 10).map(x => ({ name: String(x.name), shares: Number(x.shares), pctOfOutstanding: sharesOutstanding ? Number((x.shares / sharesOutstanding * 100).toFixed(2)) : undefined })); } catch { out.warnings.push("Top-holder list is corrupt and was ignored"); }
  if (sharesOutstanding && sharesOutstanding > 0) {
    const pct = row.shares / sharesOutstanding * 100;
    if (pct > 100) out.warnings.push(`13F aggregate is ${pct.toFixed(0)}% of shares outstanding: co-managers are double counting, so no ownership percentage is shown`);
    else { out.ownershipPct = Number(pct.toFixed(2)); if (row.prev_shares !== null) out.changePp = Number(((row.shares - row.prev_shares) / sharesOutstanding * 100).toFixed(2)); }
  } else out.warnings.push("Shares outstanding unknown: ownership percentage cannot be computed");
  if (row.prev_shares) out.sharesChangePct = Number(((row.shares / row.prev_shares - 1) * 100).toFixed(1));
  if (ageDays > 200) out.warnings.push(`13F data is for the quarter ending ${row.period} (${ageDays} days ago): a newer quarter should be loaded`);
  out.notes.push(`13F (${row.period}): ${row.holders} filers report long positions; this is a lower bound (managers under $100M and short positions are not reported) and lags the market by up to ~4.5 months.`);
  return out;
}
