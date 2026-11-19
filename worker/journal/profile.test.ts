import test from "node:test";
import assert from "node:assert/strict";
import { journalProfilePage } from "./profile.ts";

test("profile review page renders and includes journal API integrations", () => {
 const html = journalProfilePage();
 assert.match(html, /ETI Trading Profile & Review/);
 assert.match(html, /\/api\/journal\/summary/);
 assert.match(html, /\/api\/journal\/trades/);
 assert.match(html, /Sync missing records/);
 assert.match(html, /30 closed trades/);
 assert.match(html, /revenge entries/);
 assert.match(html, /Live account syncing remains governed/);
});
