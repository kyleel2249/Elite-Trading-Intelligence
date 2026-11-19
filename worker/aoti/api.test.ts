import test from "node:test";
import assert from "node:assert/strict";
import { withAoti } from "./api.ts";
const base={fetch:async()=>new Response("<!doctype html><html><body><header>ETI</header></body></html>",{headers:{"content-type":"text/html; charset=utf-8"}})};
const app=withAoti(base);
test("AOTI page is served and linked from the existing ETI dashboards",async()=>{
 const page=await app.fetch(new Request("https://eti.test/aoti"),{} as any);
 assert.equal(page.status,200);assert.match(await page.text(),/On-chain Trading Intelligence/);
 const home=await app.fetch(new Request("https://eti.test/"),{} as any);
 assert.match(await home.text(),/href="\/aoti"/);
});
test("AOTI mutation endpoints require an authenticated paper session",async()=>{
 const r=await app.fetch(new Request("https://eti.test/api/aoti/scan",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),{} as any);
 assert.equal(r.status,401);
});
test("AOTI overview fails clearly when durable D1 storage is not bound",async()=>{
 const r=await app.fetch(new Request("https://eti.test/api/aoti/overview"),{} as any);
 assert.equal(r.status,503);
});
