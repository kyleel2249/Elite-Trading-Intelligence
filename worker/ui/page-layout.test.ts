import test from "node:test";
import assert from "node:assert/strict";
import app from "../main.ts";

const pages = [
  { path: "/agents", label: "AI Agents", expected: ["max-width:1920px", "eti-nav", "href='/alpha'", "href='/journal'"] },
  { path: "/gainz", label: "GainzAlgo Intelligence", expected: ["max-width:1920px"] },
  { path: "/alpha", label: "Global Alpha Center", expected: ["max-width:1920px"] },
  { path: "/journal", label: "Trade Journal", expected: ["max-width:1920px"] },
  { path: "/sports", label: "Sports Betting Intelligence", expected: ["max-width:1920px"] },
  { path: "/pro", label: "ETI Pro", expected: ["max-width:1700px", "1920px"] },
  { path: "/terminal", label: "Pro Terminal", expected: ["max-width:1920px", "tt-shell"] }
];

test("main dashboard links directly to the dedicated AI Agents workspace", async () => {
  const response = await app.fetch(new Request("https://eti.test/"), {} as any);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes("href=\"/agents\""));
  assert.match(html, />AI Agents</);
});

test("standalone ETI workspaces use the dashboard's 1920px outer layout", async () => {
  for (const page of pages) {
    const response = await app.fetch(new Request("https://eti.test" + page.path), {} as any);
    assert.equal(response.status, 200, page.label + " route");
    const html = await response.text();
    for (const token of page.expected) assert.ok(html.includes(token), page.label + " missing layout token " + token);
    assert.ok(html.includes("<main") || html.includes("tt-shell") || html.includes("eti-nav"), page.label + " has no page content root");
  }
});
