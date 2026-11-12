/**
 * SEC EDGAR public-disclosure intelligence: 13F holdings, Form 4 insider transactions, filing classification.
 *
 * - 13F-HR is a PERIODIC, DELAYED snapshot (period end -> filing up to 45 days later) of certain long positions. It is
 *   never presented as a current portfolio. Form 4 is a confirmed transaction filed within ~2 business days.
 * - EDGAR requires a descriptive User-Agent with contact details (SEC_USER_AGENT); without it nothing is fetched.
 * - CIKs in the watch registry are recorded from public knowledge and start UNVERIFIED; verifyEntity() compares the
 *   name EDGAR returns with the expected pattern and persists the result. Unverified entities are never used for following.
 */
import { Budget, sleep, type FetchLike } from "./budget.ts";

export type FormKind = "13F-HR" | "4" | "13D" | "13G" | "other";
export const formKind = (form: string): FormKind => {
  const f = form.toUpperCase().replace(/\s+/g, " ");
  if (f === "13F-HR" || f === "13F-HR/A") return "13F-HR";
  if (f === "4" || f === "4/A") return "4";
  if (/^(SC )?13D(\/A)?$/.test(f) || f === "SCHEDULE 13D" || f === "SCHEDULE 13D/A") return "13D";
  if (/^(SC )?13G(\/A)?$/.test(f) || f === "SCHEDULE 13G" || f === "SCHEDULE 13G/A") return "13G";
  return "other";
};

export interface WatchEntity { id: string; investor: string; entity: string; cik: string; namePattern: string; style: string; horizon: "long_term" | "medium_term" | "high_turnover"; followability: "followable" | "limited" | "not_followable"; followNote: string }
/** CIKs are from public EDGAR knowledge and must be verified at runtime (verifyEntity). */
export const WATCH_ENTITIES: WatchEntity[] = [
  { id: "berkshire", investor: "Warren Buffett", entity: "Berkshire Hathaway Inc", cik: "0001067983", namePattern: "berkshire hathaway", style: "quality value, concentrated", horizon: "long_term", followability: "followable", followNote: "very low turnover; 13F lags 45+ days but holdings change slowly" },
  { id: "scion", investor: "Michael Burry", entity: "Scion Asset Management", cik: "0001649339", namePattern: "scion asset", style: "contrarian deep value", horizon: "medium_term", followability: "limited", followNote: "concentrated, options and shorts are partly invisible in 13F" },
  { id: "pershing", investor: "Bill Ackman", entity: "Pershing Square Capital Management", cik: "0001336528", namePattern: "pershing square capital", style: "activist concentrated", horizon: "long_term", followability: "followable", followNote: "few large positions; 13D filings add timely intent evidence" },
  { id: "soros", investor: "George Soros", entity: "Soros Fund Management", cik: "0001029160", namePattern: "soros fund", style: "global macro (13F shows only US long equities)", horizon: "medium_term", followability: "limited", followNote: "macro book is mostly outside 13F" },
  { id: "duquesne", investor: "Stanley Druckenmiller", entity: "Duquesne Family Office", cik: "0001536411", namePattern: "duquesne", style: "macro-informed concentrated equities", horizon: "medium_term", followability: "limited", followNote: "turnover is high; filings are stale quickly" },
  { id: "appaloosa", investor: "David Tepper", entity: "Appaloosa LP", cik: "0001656456", namePattern: "appaloosa", style: "distressed and macro", horizon: "medium_term", followability: "limited", followNote: "turnover is high" },
  { id: "bridgewater", investor: "Ray Dalio", entity: "Bridgewater Associates", cik: "0001350694", namePattern: "bridgewater", style: "systematic macro, diversified", horizon: "high_turnover", followability: "not_followable", followNote: "13F covers a fraction of a hedged, diversified book" },
  { id: "renaissance", investor: "Jim Simons", entity: "Renaissance Technologies", cik: "0001037389", namePattern: "renaissance technologies", style: "quantitative", horizon: "high_turnover", followability: "not_followable", followNote: "thousands of short-horizon positions; 13F is uninformative to follow" },
  { id: "thirdpoint", investor: "Dan Loeb", entity: "Third Point LLC", cik: "0001040273", namePattern: "third point", style: "event-driven activist", horizon: "medium_term", followability: "limited", followNote: "event-driven; filings lag the events" },
  { id: "greenlight", investor: "David Einhorn", entity: "Greenlight Capital", cik: "0001079114", namePattern: "greenlight capital", style: "value long/short", horizon: "medium_term", followability: "limited", followNote: "shorts are not in 13F" },
  { id: "baupost", investor: "Seth Klarman", entity: "Baupost Group", cik: "0001061768", namePattern: "baupost", style: "deep value", horizon: "long_term", followability: "followable", followNote: "patient value; moderate turnover" },
  { id: "paulson", investor: "John Paulson", entity: "Paulson & Co", cik: "0001035674", namePattern: "paulson", style: "event-driven and special situations", horizon: "medium_term", followability: "limited", followNote: "event-driven; check catalyst timing" },
  { id: "tci", investor: "Chris Hohn", entity: "TCI Fund Management", cik: "0001647251", namePattern: "tci fund", style: "activist concentrated", horizon: "long_term", followability: "followable", followNote: "very concentrated; check the current price versus disclosure" },
  { id: "deshaw", investor: "David Shaw", entity: "D. E. Shaw & Co", cik: "0001009207", namePattern: "d. e. shaw|d e shaw|de shaw", style: "quantitative", horizon: "high_turnover", followability: "not_followable", followNote: "quantitative, high turnover" },
  { id: "point72", investor: "Steven Cohen", entity: "Point72 Asset Management", cik: "0001603466", namePattern: "point72", style: "multi-strategy", horizon: "high_turnover", followability: "not_followable", followNote: "multi-strategy; 13F not representative" },
];

export const padCik = (cik: string | number) => String(cik).replace(/\D/g, "").replace(/^0+/, "").padStart(10, "0");
const unpad = (cik: string) => cik.replace(/^0+/, "") || "0";

// ------------------------------------------------------------------ parsing
export interface Filing { form: string; kind: FormKind; filingDate: string; reportDate: string | null; accession: string; primaryDocument: string }
export function parseSubmissions(json: any): { name: string; cik: string; filings: Filing[] } | null {
  const rec = json?.filings?.recent; if (!json || typeof json.name !== "string" || !rec || !Array.isArray(rec.form)) return null;
  const filings: Filing[] = rec.form.map((form: string, i: number) => ({ form, kind: formKind(form), filingDate: rec.filingDate?.[i] ?? "", reportDate: rec.reportDate?.[i] || null, accession: rec.accessionNumber?.[i] ?? "", primaryDocument: rec.primaryDocument?.[i] ?? "" })).filter((f: Filing) => f.accession && f.filingDate);
  return { name: json.name, cik: padCik(json.cik ?? 0), filings };
}
const tagRe = (tag: string) => new RegExp("<(?:\\w+:)?" + tag + "\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?" + tag + ">", "gi");
const inner = (block: string, tag: string): string | null => { const m = tagRe(tag).exec(block); return m ? m[1].replace(/<[^>]+>/g, "").trim() : null; };
const blocks = (xml: string, tag: string) => [...xml.matchAll(tagRe(tag))].map(m => m[1]);
const num = (s: string | null) => { if (s === null) return null; const v = Number(s.replace(/,/g, "")); return Number.isFinite(v) ? v : null; };

export interface Position { issuer: string; titleOfClass: string; cusip: string; putCall: "Put" | "Call" | null; shares: number; shareType: string; valueUsd: number }
/** `valueInThousands`: 13F values were reported in thousands of dollars for periods before 2023-01-01 and in dollars after. */
export function parse13FInfoTable(xml: string, valueInThousands = false): Position[] {
  const agg = new Map<string, Position>();
  for (const b of blocks(xml, "infoTable")) {
    const cusip = (inner(b, "cusip") || "").toUpperCase(), shares = num(inner(b, "sshPrnamt")), value = num(inner(b, "value"));
    if (!/^[0-9A-Z]{9}$/.test(cusip) || shares === null || value === null) continue;
    const pc = (inner(b, "putCall") || "").toLowerCase(), putCall = pc === "put" ? "Put" : pc === "call" ? "Call" : null, key = cusip + "|" + (putCall ?? "");
    const cur = agg.get(key), usd = valueInThousands ? value * 1000 : value;
    if (cur) { cur.shares += shares; cur.valueUsd += usd; } else agg.set(key, { issuer: inner(b, "nameOfIssuer") || "", titleOfClass: inner(b, "titleOfClass") || "", cusip, putCall, shares, shareType: inner(b, "sshPrnamtType") || "SH", valueUsd: usd });
  }
  return [...agg.values()];
}
export type ChangeKind = "NEW" | "ADDED" | "REDUCED" | "EXITED" | "UNCHANGED";
export interface PositionChange { cusip: string; issuer: string; putCall: "Put" | "Call" | null; kind: ChangeKind; prevShares: number; shares: number; deltaPct: number | null; valueUsd: number }
export function diff13F(prev: Position[], curr: Position[]): PositionChange[] {
  const key = (p: Position) => p.cusip + "|" + (p.putCall ?? ""), pm = new Map(prev.map(p => [key(p), p])), cm = new Map(curr.map(p => [key(p), p])), out: PositionChange[] = [];
  for (const c of curr) { const p = pm.get(key(c)); const d = p && p.shares > 0 ? (c.shares - p.shares) / p.shares : null;
    out.push({ cusip: c.cusip, issuer: c.issuer, putCall: c.putCall, kind: !p ? "NEW" : c.shares > p.shares * 1.02 ? "ADDED" : c.shares < p.shares * 0.98 ? "REDUCED" : "UNCHANGED", prevShares: p?.shares ?? 0, shares: c.shares, deltaPct: d === null ? null : Number((d * 100).toFixed(1)), valueUsd: c.valueUsd }); }
  for (const p of prev) if (!cm.has(key(p))) out.push({ cusip: p.cusip, issuer: p.issuer, putCall: p.putCall, kind: "EXITED", prevShares: p.shares, shares: 0, deltaPct: -100, valueUsd: 0 });
  return out;
}
export interface InsiderTx { issuer: string; ticker: string | null; owner: string; role: string; code: string; date: string; shares: number; price: number | null; acquired: boolean; sharesAfter: number | null; direct: boolean; plan10b5_1: boolean; kind: "open_market_purchase" | "open_market_sale" | "other" }
export function parseForm4(xml: string): InsiderTx[] {
  const issuer = inner(xml, "issuerName") || "", ticker = (inner(xml, "issuerTradingSymbol") || "").toUpperCase() || null, owner = inner(xml, "rptOwnerName") || "";
  const rel = blocks(xml, "reportingOwnerRelationship")[0] || "", roles = [inner(rel, "isDirector") === "1" || inner(rel, "isDirector") === "true" ? "Director" : "", inner(rel, "officerTitle") || (inner(rel, "isOfficer") === "1" ? "Officer" : ""), inner(rel, "isTenPercentOwner") === "1" ? "10% owner" : ""].filter(Boolean).join(", ") || "Reporting owner";
  const plan = /10b5-1/i.test(xml);
  return blocks(xml, "nonDerivativeTransaction").map(b => {
    const code = (inner(blocks(b, "transactionCoding")[0] || "", "transactionCode") || "").toUpperCase(), ad = (inner(blocks(b, "transactionAcquiredDisposedCode")[0] || "", "value") || "").toUpperCase();
    return { issuer, ticker, owner, role: roles, code, date: inner(blocks(b, "transactionDate")[0] || "", "value") || "", shares: num(inner(blocks(b, "transactionShares")[0] || "", "value")) ?? 0, price: num(inner(blocks(b, "transactionPricePerShare")[0] || "", "value")), acquired: ad === "A", sharesAfter: num(inner(blocks(b, "sharesOwnedFollowingTransaction")[0] || "", "value")), direct: (inner(blocks(b, "directOrIndirectOwnership")[0] || "", "value") || "D").toUpperCase() === "D", plan10b5_1: plan,
      kind: code === "P" ? "open_market_purchase" : code === "S" ? "open_market_sale" : "other" } as InsiderTx;
  }).filter(t => t.shares > 0 && /^\d{4}-\d{2}-\d{2}/.test(t.date));
}
/** Raw XML path of a Form 4 primary document (EDGAR lists the XSL-rendered path first). */
export const rawForm4Path = (primary: string) => primary.replace(/^xsl[^/]*\//i, "");

export function infoTableFileName(indexJson: any): string | null {
  const items: { name: string; type?: string }[] = indexJson?.directory?.item ?? []; const xml = items.filter(i => /\.xml$/i.test(i.name) && !/primary_doc/i.test(i.name));
  return (xml.find(i => /infotable|information.?table/i.test(i.name + " " + (i.type || ""))) ?? xml[0])?.name ?? null;
}
/** 13F values: dollars for report periods ending 2023-01-01 or later, thousands before. */
export const valuesInThousands = (reportDate: string | null) => !!reportDate && reportDate < "2023-01-01";

// ------------------------------------------------------- classification
export type Staleness = "fresh" | "aging" | "stale";
export interface DelayInfo { delayDays: number | null; ageDays: number; delayed: boolean; staleness: Staleness; note: string }
const dayMs = 86400000, days = (a: string, b: string | number) => Math.floor(((typeof b === "number" ? b : Date.parse(b)) - Date.parse(a)) / dayMs);
export function classifyDelay(kind: FormKind, eventDate: string | null, filingDate: string, now: number): DelayInfo {
  const ageFiling = days(filingDate, now), ageEvent = eventDate ? days(eventDate, now) : ageFiling, delay = eventDate ? Math.max(0, days(eventDate, Date.parse(filingDate))) : null;
  if (kind === "13F-HR") return { delayDays: delay, ageDays: ageEvent, delayed: true, staleness: ageEvent <= 60 ? "aging" : "stale", note: "13F is a snapshot at quarter end filed up to 45 days later; it is not a current portfolio and never 'fresh'" };
  if (kind === "4") return { delayDays: delay, ageDays: ageEvent, delayed: (delay ?? 0) > 2, staleness: ageEvent <= 5 ? "fresh" : ageEvent <= 30 ? "aging" : "stale", note: "Form 4 reports a confirmed transaction, normally filed within 2 business days" };
  return { delayDays: delay, ageDays: ageEvent, delayed: true, staleness: ageEvent <= 10 ? "fresh" : ageEvent <= 45 ? "aging" : "stale", note: "13D/13G discloses a >5% ownership position; details need the filing document" };
}
export type DisclosureType = "confirmed_purchase" | "confirmed_sale" | "reported_holding" | "new_position" | "position_increase" | "position_reduction" | "position_exit" | "ownership_filing" | "unverified_wallet_activity";
export interface Disclosure {
  id: string; investor: string; entityId: string; entity: string; cik: string; form: string; type: DisclosureType; asset: string; assetKey: string; ticker: string | null;
  eventDate: string | null; filingDate: string; source: string; shares: number | null; valueUsd: number | null; deltaPct: number | null; delay: DelayInfo;
  attribution: { status: "verified" | "unverified"; confidence: number; basis: string }; observedAt: string; note: string;
}
const acc = (a: string) => a.replace(/-/g, "");
export const filingUrl = (cik: string, accession: string, doc = "") => "https://www.sec.gov/Archives/edgar/data/" + unpad(cik) + "/" + acc(accession) + "/" + doc;

export function disclosuresFromChanges(ent: WatchEntity, verified: boolean, f: Filing, changes: PositionChange[], now: number, topN = 25): Disclosure[] {
  const attribution = { status: verified ? "verified" as const : "unverified" as const, confidence: verified ? 0.95 : 0.4, basis: verified ? "EDGAR filer name matched the expected entity" : "CIK not yet verified against EDGAR" };
  const delay = classifyDelay("13F-HR", f.reportDate, f.filingDate, now);
  return changes.filter(c => c.kind !== "UNCHANGED" && !c.putCall).sort((a, b) => Math.max(b.valueUsd, b.prevShares) - Math.max(a.valueUsd, a.prevShares)).slice(0, topN).map(c => ({
    id: "13f:" + ent.cik + ":" + acc(f.accession) + ":" + c.cusip, investor: ent.investor, entityId: ent.id, entity: ent.entity, cik: ent.cik, form: f.form,
    type: c.kind === "NEW" ? "new_position" : c.kind === "ADDED" ? "position_increase" : c.kind === "REDUCED" ? "position_reduction" : "position_exit", asset: c.issuer, assetKey: c.cusip, ticker: null,
    eventDate: f.reportDate, filingDate: f.filingDate, source: filingUrl(ent.cik, f.accession), shares: c.shares, valueUsd: c.valueUsd || null, deltaPct: c.deltaPct, delay, attribution, observedAt: new Date(now).toISOString(),
    note: "Position change between consecutive 13F snapshots; the transaction date within the quarter is unknown" }));
}
export function disclosuresFromForm4(ent: WatchEntity, verified: boolean, f: Filing, txs: InsiderTx[], now: number): Disclosure[] {
  const attribution = { status: verified ? "verified" as const : "unverified" as const, confidence: verified ? 0.95 : 0.4, basis: verified ? "filed under a verified EDGAR entity" : "CIK not yet verified against EDGAR" };
  return txs.filter(t => t.kind !== "other").map((t, i) => ({
    id: "f4:" + ent.cik + ":" + acc(f.accession) + ":" + i, investor: ent.investor, entityId: ent.id, entity: ent.entity, cik: ent.cik, form: f.form, type: t.kind === "open_market_purchase" ? "confirmed_purchase" as const : "confirmed_sale" as const,
    asset: t.issuer, assetKey: t.ticker || t.issuer, ticker: t.ticker, eventDate: t.date, filingDate: f.filingDate, source: filingUrl(ent.cik, f.accession), shares: t.shares, valueUsd: t.price ? Math.round(t.shares * t.price) : null, deltaPct: null,
    delay: classifyDelay("4", t.date, f.filingDate, now), attribution, observedAt: new Date(now).toISOString(), note: (t.plan10b5_1 ? "mentions a 10b5-1 plan (pre-scheduled); " : "") + t.role + (t.direct ? " (direct)" : " (indirect)") }));
}

// ------------------------------------------------------------------- network
export interface SecEnv { SEC_USER_AGENT?: string }
export const secHeaders = (env: SecEnv) => ({ "user-agent": env.SEC_USER_AGENT || "", accept: "application/json, application/xml, text/xml;q=0.9" });
export const secConfigured = (env: SecEnv) => /\S+@\S+\.\S+|https?:\/\//.test(env.SEC_USER_AGENT || "");
export type SecResult<T> = { ok: true; data: T } | { ok: false; reason: string };

async function secGet(url: string, env: SecEnv, budget: Budget, f: FetchLike, asText = false): Promise<SecResult<any>> {
  if (!secConfigured(env)) return { ok: false, reason: "sec_user_agent_not_configured" };
  if (!budget.take()) return { ok: false, reason: "subrequest_budget_exhausted" };
  await sleep(110);
  try { const r = await f(url, { headers: secHeaders(env) }); if (!r.ok) return { ok: false, reason: "http_" + r.status }; return { ok: true, data: asText ? await r.text() : await r.json() }; }
  catch (e) { return { ok: false, reason: "network_error" }; }
}
export const fetchSubmissions = async (cik: string, env: SecEnv, b: Budget, f: FetchLike = fetch) => { const r = await secGet("https://data.sec.gov/submissions/CIK" + padCik(cik) + ".json", env, b, f); if (!r.ok) return r; const p = parseSubmissions(r.data); return p ? { ok: true as const, data: p } : { ok: false as const, reason: "unexpected_payload" }; };

export type EntityVerification = { status: "verified" | "mismatch" | "unreachable"; edgarName: string | null; checkedAt: string; reason?: string };
export async function verifyEntity(ent: WatchEntity, env: SecEnv, b: Budget, f: FetchLike = fetch, now = Date.now()): Promise<EntityVerification> {
  const r = await fetchSubmissions(ent.cik, env, b, f), checkedAt = new Date(now).toISOString();
  if (!r.ok) return { status: "unreachable", edgarName: null, checkedAt, reason: r.reason };
  const ok = new RegExp(ent.namePattern, "i").test(r.data.name); return { status: ok ? "verified" : "mismatch", edgarName: r.data.name, checkedAt };
}
export const fetchInfoTable = async (cik: string, f13: Filing, env: SecEnv, b: Budget, f: FetchLike = fetch): Promise<SecResult<Position[]>> => {
  const idx = await secGet(filingUrl(cik, f13.accession, "index.json"), env, b, f); if (!idx.ok) return idx;
  const name = infoTableFileName(idx.data); if (!name) return { ok: false, reason: "information_table_not_found" };
  const xml = await secGet(filingUrl(cik, f13.accession, name), env, b, f, true); if (!xml.ok) return xml;
  const pos = parse13FInfoTable(xml.data, valuesInThousands(f13.reportDate)); return pos.length ? { ok: true, data: pos } : { ok: false, reason: "no_positions_parsed" };
};
export const fetchForm4 = async (cik: string, f4: Filing, env: SecEnv, b: Budget, f: FetchLike = fetch): Promise<SecResult<InsiderTx[]>> => {
  const r = await secGet(filingUrl(cik, f4.accession, rawForm4Path(f4.primaryDocument)), env, b, f, true); return r.ok ? { ok: true, data: parseForm4(r.data) } : r;
};

// ---------------------------------------------------------- CUSIP -> ticker
/** OpenFIGI v3 mapping (public, 25 requests/minute without a key). Returns only unambiguous US common-stock matches. */
export function parseOpenFigi(resp: any, cusips: string[]): Record<string, { ticker: string; name: string }> {
  const out: Record<string, { ticker: string; name: string }> = {};
  if (!Array.isArray(resp)) return out;
  resp.forEach((e: any, i: number) => { const rows = (e?.data || []).filter((d: any) => d?.ticker && d.exchCode === "US" && /common stock|adr|etp/i.test(d.securityType || "")); const t = [...new Set(rows.map((d: any) => d.ticker))]; if (t.length === 1 && cusips[i]) out[cusips[i]] = { ticker: String(t[0]), name: String(rows[0].name || "") }; });
  return out;
}
export async function mapCusips(cusips: string[], b: Budget, f: FetchLike = fetch, key?: string): Promise<Record<string, { ticker: string; name: string }>> {
  const out: Record<string, { ticker: string; name: string }> = {};
  for (let i = 0; i < cusips.length && b.take(); i += 10) {
    const chunk = cusips.slice(i, i + 10);
    try { const r = await f("https://api.openfigi.com/v3/mapping", { method: "POST", headers: { "content-type": "application/json", ...(key ? { "X-OPENFIGI-APIKEY": key } : {}) }, body: JSON.stringify(chunk.map(c => ({ idType: "ID_CUSIP", idValue: c }))) }); if (!r.ok) break; Object.assign(out, parseOpenFigi(await r.json(), chunk)); } catch { break; }
  }
  return out;
}

// ------------------------------------------------ continuous investor discovery
/** Parses an EDGAR daily form index (fixed-width) into 13F-HR filers. */
export function parseDailyIndex(text: string): { form: string; name: string; cik: string; date: string; file: string }[] {
  const out: { form: string; name: string; cik: string; date: string; file: string }[] = [];
  for (const line of text.split("\n")) { const m = /^(13F-HR(?:\/A)?)\s+(.+?)\s{2,}(\d{3,10})\s+(\d{8})\s+(edgar\/\S+)\s*$/.exec(line.trimEnd()); if (m) out.push({ form: m[1], name: m[2].trim(), cik: padCik(m[3]), date: m[4], file: m[5] }); }
  return out;
}
export interface QualificationEvidence { yearsDocumented: number; independentSources: number; hasPrimaryPerformanceRecord: boolean; drawdownDisclosed: boolean; methodologyDocumented: boolean; wealthOnly: boolean; disclosedAumUsd?: number }
/** Transparent qualification gate for adding an investor to the elite database. Wealth or popularity alone never qualifies. */
export function qualifyInvestor(e: QualificationEvidence): { status: "qualified" | "needs_evidence" | "rejected"; met: string[]; missing: string[] } {
  const met: string[] = [], missing: string[] = [];
  (e.yearsDocumented >= 10 ? met : missing).push("at least 10 years of documented activity (have " + e.yearsDocumented + ")");
  (e.independentSources >= 2 ? met : missing).push("at least 2 independent credible sources (have " + e.independentSources + ")");
  (e.hasPrimaryPerformanceRecord ? met : missing).push("performance from a primary or audited source");
  (e.drawdownDisclosed ? met : missing).push("disclosed drawdown or risk record");
  (e.methodologyDocumented ? met : missing).push("documented methodology");
  if (e.wealthOnly && !e.hasPrimaryPerformanceRecord) return { status: "rejected", met, missing: [...missing, "wealth or popularity is not evidence of skill"] };
  return { status: missing.length === 0 ? "qualified" : "needs_evidence", met, missing };
}
