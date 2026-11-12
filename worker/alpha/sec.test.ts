import test from "node:test";
import assert from "node:assert/strict";
import { Budget } from "./budget.ts";
import * as S from "./sec.ts";

const NS = 'xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable"';
const info = (rows: string) => `<?xml version="1.0"?><informationTable ${NS}>${rows}</informationTable>`;
const row = (name: string, cusip: string, val: number, sh: number, pc = "") => `<infoTable><nameOfIssuer>${name}</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${cusip}</cusip><value>${val}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>${pc ? `<putCall>${pc}</putCall>` : ""}<investmentDiscretion>SOLE</investmentDiscretion></infoTable>`;

test("formKind recognises 13F, Form 4 and 13D/G variants", () => {
  assert.equal(S.formKind("13F-HR"), "13F-HR"); assert.equal(S.formKind("13F-HR/A"), "13F-HR"); assert.equal(S.formKind("4"), "4");
  assert.equal(S.formKind("SC 13D/A"), "13D"); assert.equal(S.formKind("SCHEDULE 13G"), "13G"); assert.equal(S.formKind("8-K"), "other");
});
test("parseSubmissions reads EDGAR's parallel arrays and pads the CIK", () => {
  const p = S.parseSubmissions({ name: "BERKSHIRE HATHAWAY INC", cik: "1067983", filings: { recent: { form: ["13F-HR", "4"], filingDate: ["2026-08-14", "2026-09-02"], reportDate: ["2026-06-30", "2026-08-31"], accessionNumber: ["0000950123-26-000001", "0000950123-26-000002"], primaryDocument: ["x.xml", "xslF345X05/wk-form4.xml"] } } })!;
  assert.equal(p.cik, "0001067983"); assert.equal(p.filings.length, 2); assert.equal(p.filings[1].kind, "4"); assert.equal(S.parseSubmissions({}), null);
});
test("parse13FInfoTable aggregates lots, separates options and converts pre-2023 thousands", () => {
  const xml = info(row("APPLE INC", "037833100", 1000, 10) + row("APPLE INC", "037833100", 500, 5) + row("APPLE INC", "037833100", 50, 1, "Put") + row("BAD", "xx", 1, 1));
  const p = S.parse13FInfoTable(xml); assert.equal(p.length, 2); const a = p.find(x => !x.putCall)!; assert.equal(a.shares, 15); assert.equal(a.valueUsd, 1500);
  assert.equal(S.parse13FInfoTable(xml, true).find(x => !x.putCall)!.valueUsd, 1_500_000);
  assert.equal(S.valuesInThousands("2022-12-31"), true); assert.equal(S.valuesInThousands("2023-03-31"), false);
});
test("parse13FInfoTable tolerates namespace prefixes", () => {
  const xml = '<ns1:informationTable xmlns:ns1="x"><ns1:infoTable><ns1:nameOfIssuer>X</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>000000001</ns1:cusip><ns1:value>7</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>3</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt></ns1:infoTable></ns1:informationTable>';
  assert.equal(S.parse13FInfoTable(xml).length, 1);
});
test("diff13F classifies NEW / ADDED / REDUCED / EXITED / UNCHANGED", () => {
  const prev = S.parse13FInfoTable(info(row("A", "000000001", 1, 100) + row("B", "000000002", 1, 100) + row("C", "000000003", 1, 100) + row("D", "000000004", 1, 100)));
  const curr = S.parse13FInfoTable(info(row("A", "000000001", 1, 150) + row("B", "000000002", 1, 50) + row("C", "000000003", 1, 100) + row("E", "000000005", 1, 10)));
  const k = Object.fromEntries(S.diff13F(prev, curr).map(c => [c.issuer, c]));
  assert.equal(k.A.kind, "ADDED"); assert.equal(k.A.deltaPct, 50); assert.equal(k.B.kind, "REDUCED"); assert.equal(k.C.kind, "UNCHANGED"); assert.equal(k.D.kind, "EXITED"); assert.equal(k.E.kind, "NEW");
});
const f4 = (code: string, ad: string, extra = "") => `<ownershipDocument><issuer><issuerCik>1</issuerCik><issuerName>ACME CORP</issuerName><issuerTradingSymbol>acme</issuerTradingSymbol></issuer><reportingOwner><reportingOwnerId><rptOwnerCik>2</rptOwnerCik><rptOwnerName>DOE JOHN</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common</value></securityTitle><transactionDate><value>2026-10-01</value></transactionDate><transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1,000</value></transactionShares><transactionPricePerShare><value>12.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable>${extra}</ownershipDocument>`;
test("parseForm4 reads open-market purchases and sales and flags 10b5-1 plans", () => {
  const [p] = S.parseForm4(f4("P", "A")); assert.equal(p.kind, "open_market_purchase"); assert.equal(p.ticker, "ACME"); assert.equal(p.shares, 1000); assert.equal(p.price, 12.5); assert.equal(p.role, "Director, CEO"); assert.equal(p.sharesAfter, 5000);
  assert.equal(S.parseForm4(f4("S", "D", "<footnotes>Sale under a Rule 10b5-1 trading plan</footnotes>"))[0].plan10b5_1, true);
  assert.equal(S.parseForm4(f4("A", "A"))[0].kind, "other"); assert.equal(S.rawForm4Path("xslF345X05/wk-form4_1.xml"), "wk-form4_1.xml");
});
test("infoTableFileName picks the information table, not primary_doc", () => {
  assert.equal(S.infoTableFileName({ directory: { item: [{ name: "primary_doc.xml" }, { name: "form13fInfoTable.xml" }, { name: "x.txt" }] } }), "form13fInfoTable.xml"); assert.equal(S.infoTableFileName({}), null);
});
test("classifyDelay: 13F is never fresh; Form 4 ages; delay days measured", () => {
  const now = Date.parse("2026-11-09"), d = S.classifyDelay("13F-HR", "2026-09-30", "2026-11-05", now);
  assert.equal(d.delayed, true); assert.equal(d.staleness, "aging"); assert.equal(d.delayDays, 36); assert.match(d.note, /not a current portfolio/);
  assert.equal(S.classifyDelay("13F-HR", "2026-03-31", "2026-05-14", now).staleness, "stale");
  assert.equal(S.classifyDelay("4", "2026-11-06", "2026-11-07", now).staleness, "fresh"); assert.equal(S.classifyDelay("4", "2026-09-01", "2026-09-03", now).staleness, "stale");
});
test("disclosures carry attribution confidence: unverified entities are labelled as such", () => {
  const ent = S.WATCH_ENTITIES[0], filing: S.Filing = { form: "13F-HR", kind: "13F-HR", filingDate: "2026-11-05", reportDate: "2026-09-30", accession: "0000950123-26-000001", primaryDocument: "x" };
  const ch = [{ cusip: "037833100", issuer: "APPLE", putCall: null, kind: "ADDED" as const, prevShares: 1, shares: 2, deltaPct: 100, valueUsd: 5 }];
  const v = S.disclosuresFromChanges(ent, true, filing, ch, Date.parse("2026-11-09")), u = S.disclosuresFromChanges(ent, false, filing, ch, Date.parse("2026-11-09"));
  assert.equal(v[0].attribution.status, "verified"); assert.equal(u[0].attribution.status, "unverified"); assert.ok(u[0].attribution.confidence < v[0].attribution.confidence);
  assert.match(v[0].source, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1067983\/000095012326000001\/$/);
});
test("fetches fail closed without a SEC User-Agent and respect the budget", async () => {
  const never = async () => { throw new Error("must not fetch"); };
  assert.deepEqual(await S.fetchSubmissions("1", {}, new Budget(5), never as any), { ok: false, reason: "sec_user_agent_not_configured" });
  assert.equal((await S.fetchSubmissions("1", { SEC_USER_AGENT: "ETI research eti@example.org" }, new Budget(0), never as any) as any).reason, "subrequest_budget_exhausted");
});
test("verifyEntity compares EDGAR's name with the expected pattern", async () => {
  const mk = (name: string) => (async () => new Response(JSON.stringify({ name, cik: "1", filings: { recent: { form: [], filingDate: [], accessionNumber: [] } } }))) as any;
  const env = { SEC_USER_AGENT: "ETI research eti@example.org" }, ent = S.WATCH_ENTITIES[0];
  assert.equal((await S.verifyEntity(ent, env, new Budget(3), mk("BERKSHIRE HATHAWAY INC"))).status, "verified");
  assert.equal((await S.verifyEntity(ent, env, new Budget(3), mk("SOMEONE ELSE LLC"))).status, "mismatch");
  assert.equal((await S.verifyEntity(ent, env, new Budget(3), (async () => new Response("no", { status: 503 })) as any)).status, "unreachable");
});
test("fetchInfoTable walks index.json then the information table", async () => {
  const f13: S.Filing = { form: "13F-HR", kind: "13F-HR", filingDate: "2026-11-05", reportDate: "2026-09-30", accession: "0000950123-26-000001", primaryDocument: "" }, urls: string[] = [];
  const f = (async (u: string) => { urls.push(u); return u.endsWith("index.json") ? new Response(JSON.stringify({ directory: { item: [{ name: "primary_doc.xml" }, { name: "infotable.xml" }] } })) : new Response(info(row("A", "000000001", 9, 3))); }) as any;
  const r = await S.fetchInfoTable("1067983", f13, { SEC_USER_AGENT: "ETI research eti@example.org" }, new Budget(5), f);
  assert.ok(r.ok && r.data[0].valueUsd === 9); assert.equal(urls.length, 2); assert.match(urls[1], /infotable\.xml$/);
});
test("parseOpenFigi keeps only unambiguous US common-stock matches", () => {
  const m = S.parseOpenFigi([{ data: [{ ticker: "AAPL", exchCode: "US", securityType: "Common Stock", name: "APPLE INC" }] }, { data: [{ ticker: "A", exchCode: "US", securityType: "Common Stock" }, { ticker: "B", exchCode: "US", securityType: "Common Stock" }] }, { warning: "none" }], ["c1", "c2", "c3"]);
  assert.deepEqual(Object.keys(m), ["c1"]); assert.equal(m.c1.ticker, "AAPL");
});
test("parseDailyIndex extracts 13F-HR filers", () => {
  const t = "Form Type   Company Name   CIK   Date Filed   File Name\n---\n13F-HR      EXAMPLE CAPITAL LP                                            1234567     20261105    edgar/data/1234567/0001234567-26-000001.txt\n8-K         OTHER INC                                                     7654321     20261105    edgar/data/1/x.txt\n";
  const r = S.parseDailyIndex(t); assert.equal(r.length, 1); assert.equal(r[0].cik, "0001234567"); assert.equal(r[0].name, "EXAMPLE CAPITAL LP");
});
test("qualification never admits wealth alone", () => {
  assert.equal(S.qualifyInvestor({ yearsDocumented: 30, independentSources: 3, hasPrimaryPerformanceRecord: true, drawdownDisclosed: true, methodologyDocumented: true, wealthOnly: false }).status, "qualified");
  assert.equal(S.qualifyInvestor({ yearsDocumented: 2, independentSources: 1, hasPrimaryPerformanceRecord: false, drawdownDisclosed: false, methodologyDocumented: false, wealthOnly: true }).status, "rejected");
  assert.equal(S.qualifyInvestor({ yearsDocumented: 12, independentSources: 2, hasPrimaryPerformanceRecord: true, drawdownDisclosed: false, methodologyDocumented: true, wealthOnly: false }).status, "needs_evidence");
});
test("watch registry has unique ids and CIKs and every entity starts unverified by design", () => {
  assert.equal(new Set(S.WATCH_ENTITIES.map(e => e.id)).size, S.WATCH_ENTITIES.length); assert.equal(new Set(S.WATCH_ENTITIES.map(e => e.cik)).size, S.WATCH_ENTITIES.length);
  for (const e of S.WATCH_ENTITIES) assert.match(e.cik, /^\d{10}$/);
});
