import { test } from "node:test";
import assert from "node:assert/strict";
import { withSports } from "./route.ts";

const base={fetch:()=>new Response("base")};
test("sports dashboard is served as a separate paper-only workspace",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/sports"),{} as any);const html=await r.text();
 assert.equal(r.status,200);assert.match(html,/SPORTS BETTING INTELLIGENCE/);assert.match(html,/PAPER ONLY/);assert.match(html,/No bookmaker was contacted|ETI never places a bookmaker wager/);assert.match(html,/Model probability/);assert.match(html,/Recommended stake USD/);assert.match(html,/id="place" disabled/);
});
test("sports status reports real provider and database configuration without fabricating readiness",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/api/sports/status"),{} as any);const j=await r.json() as any;
 assert.equal(j.mode,"paper_only");assert.equal(j.real_money_execution,false);assert.equal(j.odds_providers.the_odds_api,"not_configured");assert.equal(j.odds_providers.oddspapi,"not_configured");assert.equal(j.database,"not_configured");assert.ok(j.sports.length>0);
});
test("odds endpoint fails honestly when provider credentials are absent",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/api/sports/events?sport=soccer_epl"),{} as any);const j=await r.json() as any;
 assert.equal(r.status,503);assert.equal(j.error,"odds_provider_not_configured");
});
test("global football scan fails honestly without the regional odds provider key",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/api/sports/football/next"),{} as any);const j=await r.json() as any;
 assert.equal(r.status,503);assert.equal(j.error,"global_odds_provider_not_configured");
});
test("unrelated routes are delegated unchanged",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/market"),{} as any);assert.equal(await r.text(),"base");
});

test("sports health endpoint reports provider and migration readiness without leaking credentials",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/api/sports/health"),{} as any);const j=await r.json() as any;
 assert.equal(r.status,200);assert.equal(j.providers.oddspapi.configured,false);assert.equal(j.database.ready,false);assert.equal(JSON.stringify(j).includes("api_key"),false);
});
test("historical football result sync is protected by the paper token",async()=>{
 const app=withSports(base as any);const r=await app.fetch(new Request("https://eti.test/api/sports/football/sync-history",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),{} as any);const j=await r.json() as any;
 assert.equal(r.status,401);assert.equal(j.error,"unauthorized");
});
