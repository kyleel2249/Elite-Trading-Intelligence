import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withSports, startingBankrollCents, DEFAULT_PAPER_BANKROLL_CENTS } from "./route.ts";
import { withSportsGuard, resetSportsGuardCache, scanCacheKey } from "./guard.ts";
import { estimateFootballMatch, type MatchResult } from "./prediction.ts";

const base = { fetch: () => new Response("base") };
const root = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
async function dashboard(): Promise<string> {
  const r = await withSports(base as any).fetch(new Request("https://eti.test/sports"), {} as any);
  return r.text();
}

beforeEach(() => resetSportsGuardCache());

test("dashboard HTML is a single well-formed document (no duplicated style/header/main blocks)", async () => {
  const html = await dashboard();
  assert.equal((html.match(/<style>/g) || []).length, 1);
  assert.equal((html.match(/<main>/g) || []).length, 1);
  assert.equal((html.match(/<header>/g) || []).length, 1);
  assert.equal((html.match(/id="scan"/g) || []).length, 1);
  assert.equal((html.match(/id="provider"/g) || []).length, 1);
  assert.doesNotMatch(html, /<\/style><\/head><body><header>[\s\S]*<\/style><\/head><body>/);
});

test("dashboard script compiles and declares scan() without redeclaring its response variable", async () => {
  const html = await dashboard();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || "";
  assert.ok(script.length > 1000);
  assert.doesNotThrow(() => new Function(script));
  assert.equal((script.match(/const j=await api\("\/api\/sports\/football\/next/g) || []).length, 1);
  assert.equal((script.match(/\$\("scan"\)\.onclick=/g) || []).length, 1);
});

test("dashboard keeps Nations League selector, SportyBet filter and SportyBet counters together", async () => {
  const html = await dashboard();
  assert.match(html, /id="competition"/);
  assert.match(html, /id="bookmakerFilter"/);
  assert.match(html, /j\.sportybet\?\.fixture_count/);
});

test("scan cache key separates competitions and mirrors the route's default limits", () => {
  assert.notEqual(scanCacheKey(new URLSearchParams("limit=8&competition=all")), scanCacheKey(new URLSearchParams("limit=8&competition=uefa_nations_league")));
  assert.equal(scanCacheKey(new URLSearchParams("competition=uefa_nations_league")), "12:uefa_nations_league");
  assert.equal(scanCacheKey(new URLSearchParams("")), "8:all");
  assert.equal(scanCacheKey(new URLSearchParams("limit=99&competition=ALL")), "12:all");
});

test("guard never serves a cached 'all football' scan for a Nations League request", async () => {
  let calls = 0;
  const next = { fetch: (req: Request) => { calls++; return new Response(JSON.stringify({ competition: new URL(req.url).searchParams.get("competition") }), { status: 200 }); } };
  const app = withSportsGuard(next as any);
  const a = await (await app.fetch(new Request("https://eti.test/api/sports/football/next?limit=8&competition=all"), {} as any)).json() as any;
  const b = await (await app.fetch(new Request("https://eti.test/api/sports/football/next?limit=8&competition=uefa_nations_league"), {} as any)).json() as any;
  assert.equal(a.competition, "all");
  assert.equal(b.competition, "uefa_nations_league");
  assert.equal(calls, 2);
  const again = await app.fetch(new Request("https://eti.test/api/sports/football/next?limit=8&competition=all"), {} as any);
  assert.equal(again.headers.get("x-eti-cache"), "hit");
  assert.equal(calls, 2);
});

test("Nations League model falls back to international results when competition-only history is thin", () => {
  const history: MatchResult[] = [];
  for (let i = 0; i < 30; i++) {
    history.push({ fixtureId: String(i), competition: "International Friendlies", homeTeam: i % 2 ? "Ghana" : "Nigeria", awayTeam: i % 2 ? "Nigeria" : "Ghana", homeGoals: 1 + (i % 3), awayGoals: i % 2, playedAt: 1_700_000_000_000 + i * 86_400_000 });
  }
  const pred = estimateFootballMatch(history, "Ghana", "Nigeria", "UEFA Nations League");
  assert.equal(pred.sample.leagueMatches, 30);
  assert.equal(pred.status, "uncalibrated");
  const club = estimateFootballMatch(history.map(m => ({ ...m, competition: "Premier League" })), "Ghana", "Nigeria", "UEFA Nations League");
  assert.equal(club.status, "insufficient_data");
});

test("starting paper bankroll is configurable, bounded and defaults to a usable amount", () => {
  assert.equal(startingBankrollCents({}), DEFAULT_PAPER_BANKROLL_CENTS);
  assert.equal(startingBankrollCents({ ETI_SPORTS_PAPER_BANKROLL_CENTS: "250000" }), 250000);
  assert.equal(startingBankrollCents({ ETI_SPORTS_PAPER_BANKROLL_CENTS: "abc" }), DEFAULT_PAPER_BANKROLL_CENTS);
  assert.equal(startingBankrollCents({ ETI_SPORTS_PAPER_BANKROLL_CENTS: "-5" }), DEFAULT_PAPER_BANKROLL_CENTS);
});

test("package.json and wrangler.jsonc are valid JSON with no duplicate keys", () => {
  const pkgText = root("package.json");
  const pkg = JSON.parse(pkgText);
  assert.ok(pkg.scripts.test && pkg.scripts.check && pkg.scripts["test:security"] && pkg.scripts["check:worker"]);
  assert.equal((pkgText.match(/"check":/g) || []).length, 1);
  const wranglerText = root("wrangler.jsonc");
  const wrangler = JSON.parse(wranglerText);
  assert.equal(wrangler.main, "worker/main.ts");
  assert.equal((wranglerText.match(/"MARKET_PROVIDER_ORDER"/g) || []).length, 1);
  assert.ok(Array.isArray(wrangler.d1_databases) && wrangler.d1_databases[0].binding === "ETI_PORTFOLIO_DB");
});
