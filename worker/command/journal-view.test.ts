import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { commandPageComplete } from "./compose.ts";

const html = commandPageComplete();
const script = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || "";

test("complete page script is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(script), "complete script has a syntax error");
});

test("every static element id the complete script looks up exists", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dynamic = new Set(["chart", "sigDetail", "sigMore", "agRaw", "pfc", "jnText", "jnTags", "jnCorr", "jnSave", "jnMsg"]);
  const used = [...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used)].filter(id => !ids.has(id) && !dynamic.has(id)), []);
  for (const k of ["jsum", "jins", "jtrades", "anal", "abs", "absym", "abenv", "abwd", "abhr", "apred"]) assert.ok(ids.has("b-" + k), "b-" + k);
});

test("Trade Journal and Analytics are real navigation items; only genuinely unbuilt items stay disabled", () => {
  assert.match(html, /data-view="journal" href="#journal">Trade Journal</);
  assert.match(html, /data-view="analytics" href="#analytics">Analytics</);
  assert.doesNotMatch(html, /Trade Journal <em>soon/); assert.doesNotMatch(html, /Analytics <em>soon/);
  for (const name of ["Crawler Intel", "Reports"]) assert.match(html, new RegExp(name + " <em>soon</em>"));
});

test("authentication: an automatic cookie session is used, and the effective authHdr goes through bearer()", () => {
  assert.match(script, /\/api\/auth\/session/);
  assert.match(script, /credentials:'same-origin'/);
  const lastAuth = script.slice(script.lastIndexOf("function authHdr"));
  assert.match(lastAuth.slice(0, 120), /var b=bearer\(\)/, "the last authHdr definition (the one that wins) must use bearer()");
  assert.match(script, /function bearer\(\)\{return S\.token&&S\.token!==SESSION/);
  // the only places that may build an Authorization header from S.token: bearer() and the superseded original authHdr in page.ts
  assert.ok((script.match(/'Bearer '\+S\.token/g) || []).length <= 2);
});

test("the journal views never claim more than the data supports", () => {
  assert.match(html, /Append-only and hash-chained/);
  assert.match(html, /never edited or deleted/);
  assert.match(script, /No figure is shown without a real journal response/);
  assert.match(script, /not a meaningful sample/);
  assert.match(script, /ranking, not a probability/);
  assert.doesNotMatch(html, /\+\$2,450|68\.0%|99\.9%|1,247/);
});
