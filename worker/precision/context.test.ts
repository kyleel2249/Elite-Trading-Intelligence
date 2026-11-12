import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "./config.ts";
import { assessFundamentals, assessNews, mergeNews, parseFundamentalContext, parseNewsContext } from "./context.ts";
import { HOUR_MS, MINUTE_MS } from "./util.ts";
import { NOW } from "./testkit.ts";

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const ctx = DEFAULT_CONFIG.context, gates = DEFAULT_CONFIG.gates;

test("fundamental input is validated field by field; malformed input is rejected, not repaired", () => {
  const ok = { asOf: iso(-HOUR_MS), source: "feed", factors: [{ name: "A", bias: 0.5 }] };
  assert.ok(parseFundamentalContext(ok));
  assert.equal(parseFundamentalContext(null), null);
  assert.equal(parseFundamentalContext({ ...ok, asOf: "yesterday-ish" }), null);
  assert.equal(parseFundamentalContext({ ...ok, source: "" }), null);
  assert.equal(parseFundamentalContext({ ...ok, factors: [] }), null);
  assert.equal(parseFundamentalContext({ ...ok, factors: [{ name: "A", bias: 3 }] }), null, "bias outside -1..1 drops the factor");
  assert.equal(parseFundamentalContext({ ...ok, factors: [{ name: "A", bias: 0.5, weight: -1 }] }), null);
  const cleaned = parseFundamentalContext({ ...ok, factors: [{ name: "A\u0000\nB", bias: 0.2, note: "x".repeat(1000) }] })!;
  assert.equal(cleaned.factors[0].name, "A B", "control characters are stripped");
  assert.ok(cleaned.factors[0].note.length <= 240);
});

test("news input drops malformed events and non-http links", () => {
  const n = parseNewsContext({ asOf: iso(-HOUR_MS), source: "cal", events: [
    { title: "CPI", time: iso(HOUR_MS), impact: "high", url: "https://example.com/cpi" },
    { title: "Bad impact", time: iso(HOUR_MS), impact: "huge" },
    { title: "No time", impact: "low" },
    { title: "Link", time: iso(HOUR_MS), impact: "low", url: "javascript:alert(1)", sentiment: 5 },
  ] })!;
  assert.equal(n.events.length, 2);
  assert.equal(n.events[0].url, "https://example.com/cpi");
  assert.equal(n.events[1].url, null);
  assert.equal(n.events[1].sentiment, null, "out-of-range sentiment is discarded");
  assert.equal(parseNewsContext({ asOf: iso(0), source: "s" }), null);
});

test("missing fundamentals are unavailable, never neutral; stale fundamentals are not used", () => {
  const none = assessFundamentals(null, 1, NOW, ctx);
  assert.equal(none.status, "unavailable");
  assert.equal(none.score, null);
  const stale = assessFundamentals({ asOf: iso(-(ctx.fundamentalsMaxAgeHours + 1) * HOUR_MS), source: "feed", factors: [{ name: "A", bias: 1, weight: 1, note: "" }] }, 1, NOW, ctx);
  assert.equal(stale.status, "stale");
  assert.equal(stale.score, null);
  const future = assessFundamentals({ asOf: iso(2 * HOUR_MS), source: "feed", factors: [{ name: "A", bias: 1, weight: 1, note: "" }] }, 1, NOW, ctx);
  assert.equal(future.status, "stale", "future-dated data is not trusted");
});

test("fundamental alignment is directional: the same facts help a long and hurt a short", () => {
  const f = { asOf: iso(-HOUR_MS), source: "feed", factors: [{ name: "Adoption", bias: 0.8, weight: 1, note: "up" }, { name: "Supply", bias: 0.4, weight: 1, note: "" }] };
  const long = assessFundamentals(f, 1, NOW, ctx), short = assessFundamentals(f, -1, NOW, ctx);
  assert.equal(long.status, "available");
  assert.ok(long.score! > 70 && short.score! < 30, `${long.score} / ${short.score}`);
  assert.ok(Math.abs(long.score! + short.score! - 100) < 0.2, "symmetric around 50");
  assert.ok(long.points.some(p => /supports this trade/.test(p)) && short.points.some(p => /opposes this trade/.test(p)));
  assert.ok(long.points.at(-1)!.includes("does not verify") || /not verify/.test(long.points.at(-1)!), "source caveat is stated");
});

test("no news data is unavailable rather than 'low risk'; stale news is not used", () => {
  const none = assessNews(null, 1, NOW, ctx, gates);
  assert.equal(none.status, "unavailable");
  assert.equal(none.score, null);
  assert.equal(none.blackout, false);
  const stale = assessNews({ asOf: iso(-(ctx.newsMaxAgeHours + 1) * HOUR_MS), source: "cal", events: [] }, 1, NOW, ctx, gates);
  assert.equal(stale.status, "stale");
  assert.equal(stale.score, null);
});

test("a high-impact event inside the window triggers a blackout and a zero score", () => {
  const mk = (offsetMin: number, impact: "low" | "medium" | "high" = "high") => ({ asOf: iso(-HOUR_MS), source: "cal", events: [{ title: "FOMC decision", time: iso(offsetMin * MINUTE_MS), impact, sentiment: null, scheduled: true, source: null, url: null }] });
  const before = assessNews(mk(30), 1, NOW, ctx, gates);
  assert.equal(before.blackout, true);
  assert.equal(before.score, 0);
  assert.match(before.blackoutReason!, /FOMC decision/);
  assert.equal(assessNews(mk(-20), 1, NOW, ctx, gates).blackout, true, "still blacked out shortly after the event");
  assert.equal(assessNews(mk(-45), 1, NOW, ctx, gates).blackout, false, "past the after-window");
  assert.equal(assessNews(mk(180), 1, NOW, ctx, gates).blackout, false, "far enough ahead");
  assert.equal(assessNews(mk(30, "medium"), 1, NOW, ctx, gates).blackout, false, "only high-impact events black out trading");
  assert.equal(assessNews(mk(180), 1, NOW, ctx, gates).nextHighImpactAt, NOW + 180 * MINUTE_MS);
});

test("upcoming events lower the news score and supplied sentiment is directional", () => {
  const clear = assessNews({ asOf: iso(-HOUR_MS), source: "cal", events: [] }, 1, NOW, ctx, gates);
  assert.equal(clear.status, "available");
  assert.equal(clear.score, 100);
  const busy = assessNews({ asOf: iso(-HOUR_MS), source: "cal", events: [
    { title: "A", time: iso(5 * HOUR_MS), impact: "high", sentiment: null, scheduled: true, source: null, url: null },
    { title: "B", time: iso(8 * HOUR_MS), impact: "medium", sentiment: null, scheduled: true, source: null, url: null }] }, 1, NOW, ctx, gates);
  assert.ok(busy.score! < clear.score! && busy.score! > 0);
  const sent = (s: number, dir: 1 | -1) => assessNews({ asOf: iso(-HOUR_MS), source: "cal", events: [{ title: "Listing", time: iso(-2 * HOUR_MS), impact: "high", sentiment: s, scheduled: false, source: null, url: null }] }, dir, NOW, ctx, gates);
  assert.ok(sent(0.9, 1).score! >= sent(0.9, -1).score!);
});

test("merging asset and market news dedupes and is only as fresh as its stalest input", () => {
  const a = { asOf: iso(-HOUR_MS), source: "A", events: [{ title: "X", time: iso(HOUR_MS), impact: "low" as const, sentiment: null, scheduled: true, source: null, url: null }] };
  const b = { asOf: iso(-5 * HOUR_MS), source: "B", events: [{ title: "x", time: iso(HOUR_MS), impact: "low" as const, sentiment: null, scheduled: true, source: null, url: null }, { title: "Y", time: iso(2 * HOUR_MS), impact: "low" as const, sentiment: null, scheduled: true, source: null, url: null }] };
  const m = mergeNews(a, b)!;
  assert.equal(m.events.length, 2);
  assert.equal(m.asOf, b.asOf);
  assert.equal(m.source, "A + B");
  assert.equal(mergeNews(null, b), b);
  assert.equal(mergeNews(a, null), a);
  assert.equal(mergeNews(null, null), null);
});
