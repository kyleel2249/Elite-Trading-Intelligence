import { test } from "node:test";
import assert from "node:assert/strict";
import { commandPageFull } from "./views.ts";
import { withReportLinks, reportLinksApplied, NAV_REPORTS_OLD } from "./nav.ts";
import { withCommand } from "./route.ts";

test("the Command Centre page still carries the Reports marker, so the link swap can apply", () => {
  assert.ok(commandPageFull().includes(NAV_REPORTS_OLD), "page.ts changed: update nav.ts to the new Reports item");
});

test("Reports becomes a real link to /daily and the Pro dashboard is linked, with no other nav item touched", () => {
  const before = commandPageFull(), after = withReportLinks(before);
  assert.ok(reportLinksApplied(after));
  assert.ok(!after.includes("Reports <em>soon</em>"));
  assert.equal((before.match(/class="item soon"/g) ?? []).length - 1, (after.match(/class="item soon"/g) ?? []).length);
  assert.ok(after.includes('href="#portfolio"') && after.includes('href="#scanner"'));
});

test("link injection is a no-op when the marker is absent", () => {
  assert.equal(withReportLinks("<nav></nav>"), "<nav></nav>");
});

test("/command is served with the report links", async () => {
  const app = withCommand({ fetch: async () => new Response("base") } as any);
  const res = await app.fetch(new Request("https://eti.test/command"), {} as any);
  assert.equal(res.status, 200);
  assert.ok(reportLinksApplied(await res.text()));
});
