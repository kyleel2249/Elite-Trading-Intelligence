import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { aggregateQuarter, buildSql, resolveTickers, selectFilings, sourceOf, type Filing } from "../scripts/lib/thirteenf.ts";
import { loadInstitutional, type D1Like } from "./analysis/institutional.ts";
import { handleAnalysis } from "./analysis/api.ts";

const NOW = Date.UTC(2026, 10, 12);
const tsv = (rows: string[][]) => rows.map(r => r.join("\t")).join("\n") + "\n";
function dataset(sub: string[][], cover: string[][], info: string[][]) {
  const dir = mkdtempSync(join(tmpdir(), "f13-"));
  writeFileSync(join(dir, "SUBMISSION.tsv"), tsv([["ACCESSION_NUMBER", "FILING_DATE", "SUBMISSIONTYPE", "CIK", "PERIODOFREPORT"], ...sub]));
  writeFileSync(join(dir, "COVERPAGE.tsv"), tsv([["ACCESSION_NUMBER", "REPORTCALENDARORQUARTER", "ISAMENDMENT", "AMENDMENTTYPE", "FILINGMANAGER_NAME"], ...cover]));
  writeFileSync(join(dir, "INFOTABLE.tsv"), tsv([["ACCESSION_NUMBER", "INFOTABLE_SK", "NAMEOFISSUER", "TITLEOFCLASS", "CUSIP", "VALUE", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL"], ...info]));
  return dir;
}
const row = (acc: string, issuer: string, cls: string, cusip: string, value: number, shares: number, type = "SH", pc = "") => [acc, "1", issuer, cls, cusip, String(value), String(shares), type, pc];
const Q3 = () => dataset(
  [["A1", "10-NOV-2026", "13F-HR", "1", "30-SEP-2026"], ["B1", "05-NOV-2026", "13F-HR", "2", "30-SEP-2026"], ["B2", "12-NOV-2026", "13F-HR/A", "2", "30-SEP-2026"], ["C1", "06-NOV-2026", "13F-HR", "3", "30-SEP-2026"], ["C2", "11-NOV-2026", "13F-HR/A", "3", "30-SEP-2026"],
   ["D1", "08-AUG-2026", "13F-HR", "4", "30-JUN-2026"], ["E1", "07-NOV-2026", "13F-NT", "5", "30-SEP-2026"]],
  [["A1", "09-30-2026", "N", "", "Alpha Capital"], ["B1", "09-30-2026", "N", "", "Beta Partners"], ["B2", "09-30-2026", "Y", "RESTATEMENT", "Beta Partners"], ["C1", "09-30-2026", "N", "", "Gamma Fund"], ["C2", "09-30-2026", "Y", "NEW HOLDINGS", "Gamma Fund"], ["D1", "06-30-2026", "N", "", "Delta"], ["E1", "09-30-2026", "N", "", "Epsilon"]],
  [row("A1", "ACME CORP", "COM", "000AAA001", 1000, 1000), row("A1", "BETA INC", "COM", "000BBB002", 500, 500), row("A1", "ACME CORP", "COM", "000AAA001", 200, 200),
   row("A1", "ACME CORP", "COM", "000AAA001", 9999, 9999, "SH", "PUT"), row("A1", "ACME CORP", "NOTE 2.0% 2030", "000AAA999", 700, 700, "PRN"), row("A1", "ACME CORP", "PFD CONV", "000AAA777", 700, 700),
   row("B1", "ACME CORP", "COM", "000AAA001", 2000, 2000), row("B2", "ACME CORP", "COM", "000AAA001", 2500, 2500),
   row("C1", "BETA INC", "COM", "000BBB002", 100, 100), row("C2", "ACME CORP", "COM", "000AAA001", 300, 300),
   row("D1", "ACME CORP", "COM", "000AAA001", 5000, 5000), row("E1", "ACME CORP", "COM", "000AAA001", 5000, 5000), row("A1", "O'REILLY CO", "COM", "000OOO003", 50, 50)]);
const Q2 = () => dataset([["A0", "10-AUG-2026", "13F-HR", "1", "30-JUN-2026"], ["B0", "10-AUG-2026", "13F-HR", "2", "30-JUN-2026"]], [["A0", "06-30-2026", "N", "", "Alpha Capital"], ["B0", "06-30-2026", "N", "", "Beta Partners"]],
  [row("A0", "ACME CORP", "COM", "000AAA001", 1000, 1000), row("B0", "ACME CORP", "COM", "000AAA001", 2000, 2000)]);

test("selectFilings: restatements replace, NEW HOLDINGS amendments add, other periods and non-13F-HR forms are ignored", () => {
  const f = (accession: string, cik: string, filed: string, type: string, amendmentType = "", period = "2026-09-30"): Filing => ({ accession, cik, filed, type, amendmentType, period, name: "" });
  const sel = selectFilings([f("o", "1", "2026-11-01", "13F-HR"), f("r", "1", "2026-11-05", "13F-HR/A", "RESTATEMENT"), f("n", "2", "2026-11-01", "13F-HR"), f("h", "2", "2026-11-04", "13F-HR/A", "NEW HOLDINGS"), f("x", "3", "2026-11-01", "13F-NT"), f("p", "4", "2026-08-01", "13F-HR", "", "2026-06-30")], "2026-09-30");
  assert.deepEqual(sel.map(x => x.accession).sort(), ["h", "n", "r"]);
});
test("aggregation: filters options/bonds/preferreds, merges split rows, counts holders per filing, ranks top filers, handles amendments", async () => {
  const q = await aggregateQuarter(sourceOf(Q3()), "2026-09-30");
  assert.deepEqual(q.filings.map(x => x.accession).sort(), ["A1", "B2", "C1", "C2"]);
  const a = q.holdings.get("000AAA001")!; assert.equal(a.shares, 1000 + 200 + 2500 + 300); assert.equal(a.holders, 3);
  assert.deepEqual(a.top.map(t => [t.accession, t.shares]), [["B2", 2500], ["A1", 1200], ["C2", 300]]);
  const b = q.holdings.get("000BBB002")!; assert.equal(b.shares, 600); assert.equal(b.holders, 2);
  assert.ok(!q.holdings.has("000AAA999") && !q.holdings.has("000AAA777"), "bonds and preferreds are excluded"); assert.ok(q.rowsKept < q.rowsScanned);
});
test("aggregation reads ZIP archives identically to extracted directories", async () => {
  const dir = Q3(), zip = join(dir, "q3.zip"); const z = spawnSync("zip", ["-j", "-q", zip, join(dir, "SUBMISSION.tsv"), join(dir, "COVERPAGE.tsv"), join(dir, "INFOTABLE.tsv")]); assert.equal(z.status, 0);
  const a = await aggregateQuarter(sourceOf(zip), "2026-09-30"), b = await aggregateQuarter(sourceOf(dir), "2026-09-30"); assert.equal(a.holdings.get("000AAA001")!.shares, b.holdings.get("000AAA001")!.shares);
  assert.throws(() => sourceOf(join(dir, "SUBMISSION.tsv")), /neither a .zip nor a directory/);
});
test("OpenFIGI resolution: batches of 10 (100 with a key), prefers common stock, caches, retries on 429, rejects bad shapes", async () => {
  const calls: { n: number; key: boolean }[] = []; let throttled = false;
  const fake = (async (_u: string, init: RequestInit) => { const body = JSON.parse(String(init.body)) as { idValue: string }[]; calls.push({ n: body.length, key: !!(init.headers as Record<string, string>)["X-OPENFIGI-APIKEY"] });
    if (!throttled && calls.length === 2) { throttled = true; return new Response("slow", { status: 429 }); }
    return new Response(JSON.stringify(body.map(b => (b.idValue === "NOPE00000" ? { warning: "No identifier found." } : { data: [{ ticker: "ZZZ", securityType: "Warrant" }, { ticker: "T" + b.idValue.slice(-2), securityType: "Common Stock" }] })))); }) as unknown as typeof fetch;
  const ids = Array.from({ length: 25 }, (_, i) => `00000000${i % 10}`.slice(-9).replace(/^0{8}/, "0000000") + ""); ids[3] = "NOPE00000";
  const uniq = [...new Set(ids)].map((c, i) => (c === "NOPE00000" ? c : `CUS${String(i).padStart(6, "0")}`)); const cache: Record<string, string | null> = {};
  await resolveTickers(uniq, { fetchFn: fake, delayMs: 0, cache }); assert.ok(calls.every(c => c.n <= 10)); assert.equal(cache["NOPE00000"] ?? null, null); assert.equal(cache[uniq[0]], "T" + uniq[0].slice(-2)); assert.ok(throttled);
  const before = calls.length; await resolveTickers(uniq, { fetchFn: fake, delayMs: 0, cache }); assert.equal(calls.length, before, "cached CUSIPs are not re-requested");
  const k: typeof calls = []; await resolveTickers(Array.from({ length: 150 }, (_, i) => `K${String(i).padStart(8, "0")}`), { fetchFn: (async (_u: string, init: RequestInit) => { const b = JSON.parse(String(init.body)); k.push({ n: b.length, key: !!(init.headers as Record<string, string>)["X-OPENFIGI-APIKEY"] }); return new Response(JSON.stringify(b.map(() => ({ data: [] })))); }) as unknown as typeof fetch, apiKey: "key", delayMs: 0, cache: {} });
  assert.deepEqual(k.map(x => x.n), [100, 50]); assert.ok(k.every(x => x.key));
  await assert.rejects(() => resolveTickers(["X00000001"], { fetchFn: (async () => new Response("[]")) as unknown as typeof fetch, delayMs: 0, cache: {} }), /unexpected shape/);
});
// A real SQLite database (D1 is SQLite) built from the actual migration file, loaded with the pipeline's generated SQL.
async function loadedDb() {
  const db = new DatabaseSync(":memory:"); db.exec(readFileSync("migrations/0002_institutional_holdings.sql", "utf8"));
  const cur = await aggregateQuarter(sourceOf(Q3()), "2026-09-30"), prev = await aggregateQuarter(sourceOf(Q2()), "2026-06-30");
  const names = new Map(cur.filings.map(f => [f.accession, { cik: f.cik, name: f.name }]));
  const { sql, stats } = buildSql({ current: cur, previous: prev, tickers: { "000AAA001": "ACME", "000BBB002": "BETA", "000OOO003": null }, filerNames: names, source: "test", loadedAt: "2026-11-12T00:00:00Z" });
  db.exec(sql); return { db, sql, stats };
}
const asD1 = (db: DatabaseSync): D1Like => ({ prepare: (sql: string) => ({ bind: (...v: unknown[]) => ({ first: async <T,>() => (db.prepare(sql).get(...(v as never[])) as T | undefined) ?? null }) }) });
test("generated SQL runs on the real migration; quotes are escaped; previous-quarter change is joined; reruns are idempotent", async () => {
  const { db, sql, stats } = await loadedDb();
  assert.deepEqual(stats, { cusips: 3, resolved: 2, unresolved: 1 });
  const a = db.prepare("SELECT * FROM inst_holdings WHERE ticker='ACME'").get() as any; assert.equal(a.shares, 4000); assert.equal(a.prev_shares, 3000); assert.equal(a.holders, 3); assert.equal(a.prev_holders, 2); assert.equal(JSON.parse(a.top_json)[0].name, "Beta Partners");
  assert.equal((db.prepare("SELECT issuer FROM inst_holdings WHERE cusip='000OOO003'").get() as any).issuer, "O'REILLY CO"); assert.equal((db.prepare("SELECT ticker FROM inst_holdings WHERE cusip='000OOO003'").get() as any).ticker, null);
  const meta = db.prepare("SELECT * FROM inst_meta").get() as any; assert.equal(meta.filings, 4); assert.equal(meta.tickers_resolved, 2); db.exec(sql); assert.equal((db.prepare("SELECT count(*) c FROM inst_holdings").get() as any).c, 3);
});
test("Worker loader: ownership and change are computed against shares outstanding; double counting, staleness and absent data are handled honestly", async () => {
  const { db } = await loadedDb(), d1 = asD1(db);
  const ok = await loadInstitutional(d1, "acme", 10000, NOW); assert.equal(ok.status, "loaded"); assert.equal(ok.ownershipPct, 40); assert.equal(ok.changePp, 10); assert.equal(ok.sharesChangePct, 33.3); assert.equal(ok.top[0].pctOfOutstanding, 25); assert.ok(ok.notes[0].includes("lower bound"));
  const dbl = await loadInstitutional(d1, "ACME", 3000, NOW); assert.equal(dbl.ownershipPct, undefined); assert.ok(dbl.warnings.some(w => /double counting/.test(w)));
  assert.ok((await loadInstitutional(d1, "ACME", undefined, NOW)).warnings.some(w => /Shares outstanding unknown/.test(w)));
  assert.ok((await loadInstitutional(d1, "ACME", 10000, NOW + 300 * 86400000)).warnings.some(w => /newer quarter should be loaded/.test(w)));
  assert.equal((await loadInstitutional(d1, "NOSUCH", 1, NOW)).status, "no_data"); assert.equal((await loadInstitutional(undefined, "ACME", 1, NOW)).status, "unavailable");
  const empty = asD1(new DatabaseSync(":memory:")); const r = await loadInstitutional(empty, "ACME", 1, NOW); assert.equal(r.status, "unavailable"); assert.match(r.notes[0], /apply migrations/);
  assert.equal((await loadInstitutional(d1, "A;DROP TABLE x", 1, NOW)).status, "unavailable", "tickers are validated before reaching SQL");
});
test("API: /api/analysis/institutional serves 13F data from D1, and only for stocks", async () => {
  const { db } = await loadedDb(), env = { ETI_PORTFOLIO_DB: asD1(db) };
  const r = await handleAnalysis(new Request("https://eti.test/api/analysis/institutional?symbol=ACME&sharesOutstanding=10000", { headers: { "cf-connecting-ip": "i1" } }), env); assert.equal(r.status, 200); const j = await r.json() as any; assert.equal(j.ownershipPct, 40); assert.equal(j.holders, 3);
  assert.equal((await handleAnalysis(new Request("https://eti.test/api/analysis/institutional?symbol=NOSUCH", { headers: { "cf-connecting-ip": "i2" } }), env)).status, 404);
  assert.equal((await handleAnalysis(new Request("https://eti.test/api/analysis/institutional?symbol=BTCUSDT", { headers: { "cf-connecting-ip": "i3" } }), env)).status, 400);
  assert.equal((await handleAnalysis(new Request("https://eti.test/api/analysis/institutional?symbol=ACME", { headers: { "cf-connecting-ip": "i4" } }), {})).status, 503);
});
test("stock fundamentals fold 13F ownership into the report and name the source (mocked SEC + Yahoo + real SQLite)", async () => {
  const { db } = await loadedDb(); const orig = globalThis.fetch;
  const f = (end: string, start: string, val: number) => ({ end, start, val, form: "10-K", fp: "FY", filed: end });
  const facts: Record<string, any> = { Revenues: [f("2024-12-31", "2024-01-01", 1000), f("2025-12-31", "2025-01-01", 1200)], NetIncomeLoss: [f("2024-12-31", "2024-01-01", 140), f("2025-12-31", "2025-01-01", 180)], OperatingIncomeLoss: [f("2025-12-31", "2025-01-01", 240)], NetCashProvidedByUsedInOperatingActivities: [f("2025-12-31", "2025-01-01", 260)], PaymentsToAcquirePropertyPlantAndEquipment: [f("2025-12-31", "2025-01-01", 60)] };
  (globalThis as any).fetch = async (u: any) => { u = String(u); if (u.includes("ticker.txt")) return new Response("acme\t1234567\n" + "x".repeat(2000)); const c = u.match(/\/(us-gaap|dei)\/([A-Za-z]+)\.json/);
    if (c) return c[1] === "dei" ? new Response(JSON.stringify({ units: { shares: [{ end: "2026-01-31", val: 100 }] } })) : facts[c[2]] ? new Response(JSON.stringify({ units: { USD: facts[c[2]] } })) : new Response("nf", { status: 404 });
    if (u.includes("submissions")) return new Response(JSON.stringify({ filings: { recent: { form: [] } } })); if (u.includes("yahoo")) return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 40, regularMarketTime: Math.floor(Date.now() / 1000) }, timestamp: [], indicators: { quote: [{}] } }] } })); return new Response("no", { status: 404 }); };
  try {
    db.exec("UPDATE inst_holdings SET shares = 40, prev_shares = 30 WHERE ticker='ACME'");
    const j = await (await handleAnalysis(new Request("https://eti.test/api/analysis/fundamental?symbol=ACME", { headers: { "cf-connecting-ip": "i5" } }), { SEC_USER_AGENT: "t t@e.com", ETI_PORTFOLIO_DB: asD1(db) })).json() as any;
    assert.equal(j.extras.institutional.ownershipPct, 40); assert.equal(j.extras.institutional.changePp, 10); assert.ok(j.sources.some((s: any) => /Form 13F aggregate/.test(s.name))); assert.ok(j.notes.some((n: string) => /lower bound/.test(n)));
    assert.ok(j.findings.some((x: any) => /institutions hold 40%/.test(x.description)));
  } finally { (globalThis as any).fetch = orig; }
});
