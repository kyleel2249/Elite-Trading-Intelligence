import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { handleOmniUi, OMNI_JS, OMNI_HTML } from "./algo/omni-ui.ts";

const get = (p: string, m = "GET") => handleOmniUi(new Request("https://x.test" + p, { method: m }));

test("page and script served with strict CSP", async () => {
  for (const p of ["/omnisignal", "/omnisignal.js"]) {
    const r = get(p)!;
    assert.equal(r.status, 200);
    const csp = r.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline.*script-src|script-src[^;]*unsafe/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  }
  assert.match(get("/omnisignal")!.headers.get("content-type")!, /text\/html/);
  assert.match(get("/omnisignal.js")!.headers.get("content-type")!, /javascript/);
});
test("script parses and never uses innerHTML/eval", () => {
  new vm.Script(OMNI_JS);
  assert.doesNotMatch(OMNI_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});
test("html has no inline script, no live-trading control, token not persisted", () => {
  assert.doesNotMatch(OMNI_HTML, /<script(?![^>]*src=)/);
  assert.doesNotMatch(OMNI_JS, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(OMNI_JS, /\/api\/orders|environment["']?\s*:\s*["'](live|testnet)|\/withdraw|\/transfer/i);
});
test("routing: other paths null, non-GET 405, HEAD has no body", async () => {
  assert.equal(get("/other"), null);
  assert.equal(get("/omnisignal", "POST")!.status, 405);
  const h = get("/omnisignal", "HEAD")!;
  assert.equal(h.status, 200);
  assert.equal(await h.text(), "");
});

test("el() flattens child arrays (regression: tables rendered nothing)", () => {
  assert.match(OMNI_JS, /Array\.isArray\(c\)/);
});

test("scanner card present, GET-only, text-rendered", () => {
  assert.match(OMNI_HTML, /id="scan-form"/);
  assert.match(OMNI_JS, /\/api\/omnisignal\/scan\?/);
  new vm.Script(OMNI_JS);
});
