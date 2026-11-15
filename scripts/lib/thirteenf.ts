// SEC Form 13F bulk data sets -> per-CUSIP institutional holdings -> SQL for the D1 tables inst_holdings / inst_meta.
// Offline pipeline used by scripts/13f-build.ts (rebuilt from worker/thirteenf.test.ts, which defines the behaviour):
//  - Only 13F-HR filings for the requested period count. A RESTATEMENT amendment replaces the original; NEW HOLDINGS amendments add to it.
//  - Only plain share lines are kept (SSHPRNAMTTYPE = SH, no PUT/CALL, no notes, bonds, preferreds, warrants, rights).
//  - Holders are counted per filing, so a manager that files two documents for one quarter is counted twice (documented lower-bound behaviour).
import { createReadStream, existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

export interface Filing { accession: string; cik: string; filed: string; type: string; amendmentType: string; period: string; name: string }
export interface Holding { cusip: string; issuer: string; shares: number; valueUsd: number; holders: number; top: { accession: string; shares: number }[] }
export interface Quarter { period: string; filings: Filing[]; holdings: Map<string, Holding>; rowsScanned: number; rowsKept: number }
export interface Source { label: string; lines(file: string): AsyncIterable<string> }

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "10-NOV-2026" or "09-30-2026" or "2026-09-30" -> "2026-09-30" ("" when unreadable). */
export function isoDate(s: string): string {
  const t = String(s ?? "").trim().toUpperCase();
  let m = t.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export function sourceOf(path: string): Source {
  if (/\.zip$/i.test(path) && existsSync(path) && statSync(path).isFile()) {
    return { label: path, lines: async function* (file) {
      const p = spawn("unzip", ["-p", path, file], { stdio: ["ignore", "pipe", "ignore"] });
      yield* createInterface({ input: p.stdout, crlfDelay: Infinity });
    } };
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    return { label: path, lines: (file) => createInterface({ input: createReadStream(join(path, file)), crlfDelay: Infinity }) };
  }
  throw new Error(`${path} is neither a .zip nor a directory`);
}

/** Pick the filings that make up one quarter: per manager, the latest RESTATEMENT (else the latest original) plus NEW HOLDINGS amendments filed after it. */
export function selectFilings(all: Filing[], period: string): Filing[] {
  const byCik = new Map<string, Filing[]>();
  for (const f of all) {
    if (f.period !== period || (f.type !== "13F-HR" && f.type !== "13F-HR/A")) continue;
    (byCik.get(f.cik) ?? byCik.set(f.cik, []).get(f.cik)!).push(f);
  }
  const out: Filing[] = [];
  for (const list of byCik.values()) {
    list.sort((a, b) => (a.filed < b.filed ? -1 : a.filed > b.filed ? 1 : a.accession < b.accession ? -1 : 1));
    const restatements = list.filter((f) => f.type === "13F-HR/A" && f.amendmentType.toUpperCase() === "RESTATEMENT");
    const originals = list.filter((f) => f.type === "13F-HR");
    const base = restatements.length ? restatements[restatements.length - 1] : originals[originals.length - 1];
    if (!base) continue;
    out.push(base);
    for (const f of list) if (f !== base && f.type === "13F-HR/A" && f.amendmentType.toUpperCase() === "NEW HOLDINGS" && f.filed >= base.filed) out.push(f);
  }
  return out;
}

async function* rows(src: Source, file: string): AsyncGenerator<Record<string, string>> {
  let head: string[] | null = null;
  for await (const line of src.lines(file)) {
    if (!line) continue;
    const cells = line.split("\t");
    if (!head) { head = cells.map((c) => c.trim().toUpperCase()); continue; }
    const r: Record<string, string> = {};
    head.forEach((h, i) => { r[h] = (cells[i] ?? "").trim(); });
    yield r;
  }
}
const NOT_COMMON = /\b(PFD|PREF|PREFERRED|NOTES?|BONDS?|DEBS?|DEBENTURES?|WARRANTS?|WTS?|RIGHTS?|RTS|CONV|CONVERTIBLE|ETN)\b/i;

export async function aggregateQuarter(src: Source, period: string, opts: { valueMultiplier?: number; topN?: number } = {}): Promise<Quarter> {
  const mult = opts.valueMultiplier ?? 1, topN = opts.topN ?? 10;
  const subs = new Map<string, Filing>();
  for await (const r of rows(src, "SUBMISSION.tsv")) {
    subs.set(r.ACCESSION_NUMBER, { accession: r.ACCESSION_NUMBER, cik: r.CIK, filed: isoDate(r.FILING_DATE), type: r.SUBMISSIONTYPE, amendmentType: "", period: isoDate(r.PERIODOFREPORT), name: "" });
  }
  for await (const r of rows(src, "COVERPAGE.tsv")) {
    const f = subs.get(r.ACCESSION_NUMBER);
    if (f) { f.name = r.FILINGMANAGER_NAME ?? ""; f.amendmentType = r.ISAMENDMENT === "Y" ? r.AMENDMENTTYPE ?? "" : ""; }
  }
  const filings = selectFilings([...subs.values()], period);
  const chosen = new Set(filings.map((f) => f.accession));
  const acc = new Map<string, { issuer: string; shares: number; value: number; per: Map<string, number> }>();
  let scanned = 0, kept = 0;
  for await (const r of rows(src, "INFOTABLE.tsv")) {
    if (!chosen.has(r.ACCESSION_NUMBER)) continue;
    scanned++;
    if (r.SSHPRNAMTTYPE !== "SH" || r.PUTCALL || NOT_COMMON.test(r.TITLEOFCLASS ?? "")) continue;
    const cusip = (r.CUSIP ?? "").toUpperCase();
    const shares = Number(r.SSHPRNAMT), value = Number(r.VALUE) * mult;
    if (!cusip || !Number.isFinite(shares) || shares <= 0) continue;
    kept++;
    const h = acc.get(cusip) ?? { issuer: r.NAMEOFISSUER ?? "", shares: 0, value: 0, per: new Map<string, number>() };
    h.shares += shares; h.value += Number.isFinite(value) ? value : 0;
    h.per.set(r.ACCESSION_NUMBER, (h.per.get(r.ACCESSION_NUMBER) ?? 0) + shares);
    acc.set(cusip, h);
  }
  const holdings = new Map<string, Holding>();
  for (const [cusip, h] of acc) {
    holdings.set(cusip, { cusip, issuer: h.issuer, shares: h.shares, valueUsd: h.value, holders: h.per.size,
      top: [...h.per].map(([accession, shares]) => ({ accession, shares })).sort((a, b) => b.shares - a.shares).slice(0, topN) });
  }
  return { period, filings, holdings, rowsScanned: scanned, rowsKept: kept };
}

// ------------------------------------------------------------------------------------------------ OpenFIGI (CUSIP -> ticker)
export interface FigiOpts { fetchFn?: typeof fetch; apiKey?: string; delayMs?: number; cache: Record<string, string | null> }
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
export async function resolveTickers(cusips: string[], o: FigiOpts): Promise<Record<string, string | null>> {
  const f = o.fetchFn ?? fetch, size = o.apiKey ? 100 : 10, delay = o.delayMs ?? (o.apiKey ? 300 : 2600);
  const todo = [...new Set(cusips)].filter((c) => !(c in o.cache));
  for (let i = 0; i < todo.length; i += size) {
    const batch = todo.slice(i, i + size);
    let res: Response | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await f("https://api.openfigi.com/v3/mapping", { method: "POST", headers: { "content-type": "application/json", ...(o.apiKey ? { "X-OPENFIGI-APIKEY": o.apiKey } : {}) }, body: JSON.stringify(batch.map((idValue) => ({ idType: "ID_CUSIP", idValue }))) });
      if (res.status !== 429) break;
      await sleep(delay ? 7000 : 0);
    }
    if (!res || !res.ok) throw new Error(`OpenFIGI HTTP ${res?.status}`);
    const j: unknown = await res.json();
    if (!Array.isArray(j) || j.length !== batch.length) throw new Error("OpenFIGI returned an unexpected shape");
    batch.forEach((c, k) => {
      const data = (j[k] as { data?: { ticker?: string; securityType?: string }[] })?.data ?? [];
      const pick = data.find((d) => d.securityType === "Common Stock" && d.ticker) ?? data.find((d) => d.ticker);
      o.cache[c] = pick?.ticker ? String(pick.ticker).toUpperCase() : null;
    });
    await sleep(delay);
  }
  return o.cache;
}

// ------------------------------------------------------------------------------------------------ SQL for D1
const q = (s: string | null | undefined) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const n = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "NULL" : String(x));
export function buildSql(i: { current: Quarter; previous?: Quarter; tickers: Record<string, string | null>; filerNames: Map<string, { cik: string; name: string }>; source: string; loadedAt: string; note?: string }) {
  const { current, previous } = i;
  const out: string[] = [`DELETE FROM inst_holdings WHERE period = ${q(current.period)};`, `DELETE FROM inst_meta WHERE period = ${q(current.period)};`];
  let resolved = 0;
  for (const h of current.holdings.values()) {
    const t = i.tickers[h.cusip] ?? null;
    if (t) resolved++;
    const p = previous?.holdings.get(h.cusip);
    const top = h.top.map((x) => ({ name: i.filerNames.get(x.accession)?.name ?? "", cik: i.filerNames.get(x.accession)?.cik ?? "", shares: x.shares }));
    out.push(`INSERT INTO inst_holdings (period, cusip, ticker, issuer, shares, prev_shares, value_usd, holders, prev_holders, top_json) VALUES (${q(current.period)}, ${q(h.cusip)}, ${q(t)}, ${q(h.issuer)}, ${n(h.shares)}, ${n(p?.shares)}, ${n(h.valueUsd)}, ${h.holders}, ${p ? p.holders : "NULL"}, ${q(JSON.stringify(top))});`);
  }
  const cusips = current.holdings.size;
  out.push(`INSERT INTO inst_meta (period, loaded_at, source, filings, rows_scanned, rows_kept, cusips, tickers_resolved, note) VALUES (${q(current.period)}, ${q(i.loadedAt)}, ${q(i.source)}, ${current.filings.length}, ${current.rowsScanned}, ${current.rowsKept}, ${cusips}, ${resolved}, ${q(i.note ?? null)});`);
  return { sql: out.join("\n") + "\n", stats: { cusips, resolved, unresolved: cusips - resolved } };
}
