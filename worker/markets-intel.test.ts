// Parity: the TypeScript market layer must reproduce what the Python layer computed (worker/markets.golden.json).
// Regenerate with `python scripts/export_markets.py` after changing app/markets. No network is used.
import test from "node:test";
import assert from "node:assert/strict";
import golden from "./markets.golden.json" with { type: "json" };
import { classify, sessionStatus, assess, marketRiskReview, listInstruments, routesFor, calendarInfo, calendarKeys, normalizeSymbol, oandaInstrument } from "./markets.ts";

const G: any = golden;
const SETTINGS: Record<string, any> = {
  none: {},
  both: { oanda_api_token: "x", oanda_account_id: "y", alpaca_api_key: "a", alpaca_secret_key: "b" },
};
const ms = (iso: string) => Date.parse(iso);

/** Deep equality with a tiny numeric tolerance; returns the first differing path or null. */
function diff(a: any, b: any, path = "$"): string | null {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} !== ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${path}: keys differ: ${ka.filter((k) => !kb.includes(k))} vs ${kb.filter((k) => !ka.includes(k))}`;
  for (const k of ka) { const d = diff(a[k], b[k], `${path}.${k}`); if (d) return d; }
  return null;
}
function check(label: string, got: any, want: any, failures: string[]) { const d = diff(got, want); if (d) failures.push(`${label} -> ${d}`); }
const report = (name: string, f: string[], total: number) => assert.equal(f.length, 0, `${f.length}/${total} ${name} vectors differ:\n${f.slice(0, 8).join("\n")}`);

test("classifier matches Python for every golden symbol", () => {
  const f: string[] = [];
  for (const c of G.classify) check(`classify(${JSON.stringify(c.symbol)}, ${c.provider})`, classify(c.symbol, c.provider), c.result, f);
  report("classify", f, G.classify.length);
});

test("session engine matches Python across all sessions and DST/holiday instants", () => {
  const f: string[] = [];
  for (const c of G.sessions) check(`${c.session_id}@${c.now}`, sessionStatus(c.session_id, ms(c.now)), c.result, f);
  report("session", f, G.sessions.length);
});

test("assess matches Python (sizing, costs, routes, verdicts, warnings)", () => {
  const f: string[] = [];
  for (const c of G.assess) check(`assess(${JSON.stringify(c.args)})@${c.now}/${c.creds}`, assess(c.args.symbol, { ...c.args, now: ms(c.now), settings: SETTINGS[c.creds] }), c.result, f);
  report("assess", f, G.assess.length);
});

test("per-order market risk review matches Python", () => {
  const f: string[] = [];
  for (const c of G.review) check(`review(${c.symbol},${c.provider},${c.environment})@${c.now}`, marketRiskReview(c.symbol, c.provider, c.environment, ms(c.now)), c.result, f);
  report("review", f, G.review.length);
});

// --- behaviour checks that do not depend on the golden file ---
test("US session follows daylight saving: 14:35Z is the open in November (EST) and 13:35Z in March (EDT)", () => {
  assert.equal(sessionStatus("us_equity", ms("2026-11-09T14:35:00Z")).state, "open");
  assert.equal(sessionStatus("us_equity", ms("2026-03-09T13:35:00Z")).state, "open");
  assert.equal(sessionStatus("us_equity", ms("2026-11-09T14:25:00Z")).state, "extended");
});
test("holidays and early closes are honoured and tagged by provenance", () => {
  const thanks = sessionStatus("us_equity", ms("2026-11-26T15:00:00Z"));
  assert.equal(thanks.state, "closed"); assert.equal(thanks.reason, "holiday"); assert.equal(thanks.holiday_calendar, "applied");
  assert.equal(sessionStatus("us_equity", ms("2026-11-27T18:30:00Z")).state, "extended");        // 13:00 ET early close
  assert.equal(sessionStatus("tse", ms("2026-11-10T02:45:00Z")).reason, "intraday_break");
  assert.equal(sessionStatus("ngx", ms("2026-11-10T11:00:00Z")).holiday_calendar, "not_applied");  // no verifiable NGX calendar loaded
  assert.equal(sessionStatus("jse", ms("2027-03-26T10:00:00Z")).holiday_calendar, "partial");
});
test("catalog, calendars and routing expose what the Python layer does", () => {
  assert.ok(listInstruments().length > 100);
  assert.ok(listInstruments("forex", "EUR").every((i) => i.asset_class === "forex"));
  assert.deepEqual(calendarKeys(), ["asx", "euronext", "gse", "hkex", "jse", "lse", "nse_in", "nse_ke", "nyse", "six", "tse", "xetra"]);
  assert.equal(calendarInfo("nyse")!.years["2026"], "official");
  assert.equal(calendarInfo("ngx"), null);
  assert.equal(normalizeSymbol(" eur/usd "), "EURUSD");
  assert.deepEqual(routesFor(classify("ESZ6")), []);                                              // futures: analysis only
  assert.equal(routesFor(classify("SPX"), { oanda_api_token: "x", oanda_account_id: "y" })[0].kind, "cfd");
});

test("metals: gold, silver, platinum, palladium, copper, stablecoin-quoted contracts and gold tokens classify and route consistently", () => {
  for (const [sym, base, quote] of [["XAUUSD", "XAU", "USD"], ["XAGUSD", "XAG", "USD"], ["XPTUSD", "XPT", "USD"], ["XPDUSD", "XPD", "USD"], ["XCUUSD", "XCU", "USD"], ["XAUUSDT", "XAU", "USDT"], ["COPPERUSDT", "XCU", "USDT"]] as const) {
    const i = classify(sym);
    assert.equal(i.asset_class, "metal", sym); assert.equal(i.base, base, sym); assert.equal(i.quote, quote, sym); assert.equal(i.session_id, "metals_otc", sym);
  }
  assert.equal(classify("XCUUSD").profile_key, "metal.copper");
  assert.ok(classify("XAUUSDT").tags.includes("stablecoin_quoted"));
  assert.equal(oandaInstrument(classify("XAUUSDT")), "XAU_USD");
  for (const t of ["PAXGUSDT", "XAUTUSDT"]) { const i = classify(t); assert.equal(i.asset_class, "crypto"); assert.equal(i.tier, "gold_token"); assert.equal(i.profile_key, "crypto.gold_token"); assert.ok(i.tags.includes("gold_backed")); }
  assert.notEqual(classify("XAUSUSDT").asset_class, "metal"); // not a metal code
  const a = assess("XCUUSD", { now: Date.UTC(2026, 10, 12, 15), price: 4.5 });
  assert.equal(a.profile.key, "metal.copper"); assert.equal(a.session.state, "open");
});
