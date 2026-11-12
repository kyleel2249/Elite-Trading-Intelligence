// Live data adapters for the fundamental engines. Each adapter has a pure parser (unit-tested on fixtures) and a thin fetcher.
// Adapters never invent data: a missing credential or failed request throws SourceError, which the API surfaces as "unavailable".
import type { CryptoInput, CurrencyMacro, StockInput } from "./fundamental.ts";
import type { SourceRef } from "./types.ts";

export interface AnalysisEnv { FRED_API_KEY?: string; SEC_USER_AGENT?: string; COINGECKO_API_KEY?: string; NEWS_FEEDS_JSON?: string; FRED_SERIES_JSON?: string }
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export class SourceError extends Error {
  source: string; configure?: string;
  constructor(source: string, message: string, configure?: string) { super(message); this.source = source; this.configure = configure; }
}
const TIMEOUT = 9000;
async function getJson(f: FetchFn, source: string, url: string, headers: Record<string, string> = {}): Promise<any> {
  let r: Response;
  try { r = await f(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT) }); }
  catch (e) { throw new SourceError(source, `${source} request failed: ${e instanceof Error ? e.message : "network error"}`); }
  if (!r.ok) throw new SourceError(source, `${source} returned HTTP ${r.status}`);
  try { return await r.json(); } catch { throw new SourceError(source, `${source} returned invalid JSON`); }
}
const ref = (name: string, url: string, now: number): SourceRef => ({ name, url, retrievedAt: new Date(now).toISOString() });
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ------------------------------ CoinGecko (crypto) ------------------------------
export function parseCoinGecko(j: any, now: number): { input: Partial<CryptoInput>; notes: string[] } {
  const md = j?.market_data ?? {}, dev = j?.developer_data ?? {}, notes: string[] = [];
  const tickers: any[] = Array.isArray(j?.tickers) ? j.tickers : [];
  const markets = new Map<string, boolean>();
  for (const t of tickers) { const id = t?.market?.identifier; if (id) markets.set(id, (markets.get(id) ?? false) || t.trust_score === "green"); }
  const names = [...new Set(tickers.map((t: any) => t?.market?.name).filter(Boolean))] as string[];
  const input: Partial<CryptoInput> = {
    name: j?.name, purpose: j?.description?.en ? String(j.description.en).replace(/<[^>]+>/g, "").trim().slice(0, 600) || undefined : undefined, genesisDate: j?.genesis_date ?? undefined,
    supply: { total: n(md.total_supply), circulating: n(md.circulating_supply), max: n(md.max_supply), priceUsd: n(md.current_price?.usd), marketCapUsd: n(md.market_cap?.usd), fdvUsd: n(md.fully_diluted_valuation?.usd) },
    liquidity: { volume24hUsd: n(md.total_volume?.usd) },
    exchanges: markets.size ? { tier1Count: [...markets.values()].filter(Boolean).length, totalCount: markets.size, names: names.slice(0, 8) } : undefined,
    development: n(dev.commit_count_4_weeks) !== undefined ? { commits90d: Math.round(dev.commit_count_4_weeks * 90 / 28), repoUrl: j?.links?.repos_url?.github?.[0] || undefined } : undefined,
    asOf: j?.last_updated ?? undefined,
  };
  if (!input.supply?.fdvUsd && input.supply?.priceUsd && input.supply.max) { input.supply.fdvUsd = input.supply.priceUsd * input.supply.max; notes.push("FDV derived as price x max supply"); }
  if (input.exchanges) notes.push("Tier-1 venue count uses CoinGecko 'green' trust-score venues as a proxy");
  if (input.development) notes.push("90-day commit count is extrapolated from CoinGecko's 4-week figure");
  notes.push("CoinGecko does not provide: team, holder concentration, unlock schedules, security audits, governance or regulatory data. Supply these via POST or a dedicated provider.");
  return { input, notes };
}
export async function fetchCryptoFundamentals(symbol: string, env: AnalysisEnv, f: FetchFn, now = Date.now()): Promise<{ input: CryptoInput; notes: string[] }> {
  const base = symbol.toUpperCase().replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, "") || symbol.toUpperCase();
  const h: Record<string, string> = env.COINGECKO_API_KEY ? { "x-cg-demo-api-key": env.COINGECKO_API_KEY } : {};
  const root = "https://api.coingecko.com/api/v3";
  const s = await getJson(f, "CoinGecko", `${root}/search?query=${encodeURIComponent(base)}`, h);
  const hit = (s?.coins ?? []).filter((c: any) => String(c.symbol).toUpperCase() === base).sort((a: any, b: any) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
  if (!hit) throw new SourceError("CoinGecko", `No CoinGecko asset found for ticker ${base}`);
  const url = `${root}/coins/${encodeURIComponent(hit.id)}?localization=false&tickers=true&market_data=true&community_data=false&developer_data=true&sparkline=false`;
  const { input, notes } = parseCoinGecko(await getJson(f, "CoinGecko", url, h), now);
  notes.unshift(`Resolved ticker ${base} to CoinGecko id "${hit.id}" (market-cap rank ${hit.market_cap_rank ?? "unranked"}). Tickers are not unique: verify this is the intended asset.`);
  return { input: { symbol: base, ...input, sources: [ref("CoinGecko", url, now)], now }, notes };
}

// ------------------------------ SEC EDGAR (stocks) ------------------------------
interface Fact { end: string; val: number; start?: string; form?: string; fp?: string; filed?: string }
const CONCEPTS: Record<string, string[]> = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], netIncome: ["NetIncomeLoss"], grossProfit: ["GrossProfit"], operatingIncome: ["OperatingIncomeLoss"],
  ocf: ["NetCashProvidedByUsedInOperatingActivities"], capex: ["PaymentsToAcquirePropertyPlantAndEquipment"], da: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization"],
  interest: ["InterestExpense", "InterestExpenseDebt"], debt: ["LongTermDebt", "LongTermDebtNoncurrent"], debtCurrent: ["DebtCurrent", "LongTermDebtCurrent"], cash: ["CashAndCashEquivalentsAtCarryingValue"], equity: ["StockholdersEquity"],
};
const DAYS = 86400000;
function annualFlows(facts: any, concepts: string[]): Fact[] {
  for (const c of concepts) {
    const arr: Fact[] = facts?.["us-gaap"]?.[c]?.units?.USD ?? [];
    const yr = arr.filter(x => x.start && x.form === "10-K" && x.fp === "FY" && (Date.parse(x.end) - Date.parse(x.start)) / DAYS > 340 && (Date.parse(x.end) - Date.parse(x.start)) / DAYS < 390);
    const byEnd = new Map<string, Fact>(); for (const x of yr) { const cur = byEnd.get(x.end); if (!cur || (x.filed ?? "") > (cur.filed ?? "")) byEnd.set(x.end, x); }
    const out = [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)); if (out.length) return out;
  }
  return [];
}
function latestInstant(facts: any, concepts: string[]): Fact | undefined {
  for (const c of concepts) { const arr: Fact[] = (facts?.["us-gaap"]?.[c]?.units?.USD ?? []).filter((x: Fact) => !x.start && (x.form === "10-K" || x.form === "10-Q")); if (arr.length) return arr.sort((a, b) => b.end.localeCompare(a.end))[0]; }
  return undefined;
}
export function parseSecCompanyFacts(j: any, now: number): { input: Partial<StockInput>; notes: string[] } {
  const f = j?.facts, notes: string[] = [], g = (k: string) => annualFlows(f, CONCEPTS[k]);
  const rev = g("revenue"), ni = g("netIncome"), gp = g("grossProfit"), oi = g("operatingIncome"), ocf = g("ocf"), cx = g("capex"), da = g("da"), ie = g("interest");
  const debt = latestInstant(f, CONCEPTS.debt), debtC = latestInstant(f, CONCEPTS.debtCurrent), cash = latestInstant(f, CONCEPTS.cash), eq = latestInstant(f, CONCEPTS.equity);
  const shares: Fact[] = (f?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).slice().sort((a: Fact, b: Fact) => b.end.localeCompare(a.end));
  const ebitda = oi[0] && da[0] && oi[0].end === da[0].end ? oi[0].val + da[0].val : undefined;
  const input: Partial<StockInput> = { name: j?.entityName, asOf: rev[0]?.end ?? ni[0]?.end, revenueTTM: rev[0]?.val, revenuePrev: rev[1]?.val, netIncomeTTM: ni[0]?.val, netIncomePrev: ni[1]?.val, grossProfitTTM: gp[0]?.val, operatingIncomeTTM: oi[0]?.val,
    ebitdaTTM: ebitda, operatingCashFlowTTM: ocf[0]?.val, capexTTM: cx[0]?.val, interestExpenseTTM: ie[0]?.val, totalDebt: debt || debtC ? (debt?.val ?? 0) + (debtC?.val ?? 0) : undefined, cash: cash?.val, shareholdersEquity: eq?.val, sharesOutstanding: shares[0]?.val, sharesOutstandingPrev: shares[1]?.val };
  notes.push("Figures are the latest annual (10-K) statements, labelled TTM for scoring purposes; they are not trailing-twelve-month if the latest 10-K is old (see warnings).");
  notes.push("EDGAR provides no market price, sector medians, insider transactions or institutional ownership: valuation and ownership need those supplied via POST or another provider.");
  return { input, notes };
}
export async function fetchStockFundamentals(ticker: string, env: AnalysisEnv, f: FetchFn, now = Date.now()): Promise<{ input: StockInput; notes: string[] }> {
  if (!env.SEC_USER_AGENT) throw new SourceError("SEC EDGAR", "SEC_USER_AGENT is not configured (SEC requires a descriptive User-Agent with contact details)", "Set SEC_USER_AGENT, e.g. 'Your Org admin@yourdomain.com'");
  const h = { "user-agent": env.SEC_USER_AGENT };
  const map = await getJson(f, "SEC EDGAR", "https://www.sec.gov/files/company_tickers.json", h);
  const hit: any = Object.values(map ?? {}).find((x: any) => String(x?.ticker).toUpperCase() === ticker.toUpperCase());
  if (!hit) throw new SourceError("SEC EDGAR", `Ticker ${ticker} not found in SEC company list (non-US or not an SEC registrant)`);
  const cik = String(hit.cik_str).padStart(10, "0"), url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const { input, notes } = parseSecCompanyFacts(await getJson(f, "SEC EDGAR", url, h), now);
  const sources = [ref("SEC EDGAR company facts", url, now)];
  try {
    const ins = await fetchInsiderTransactions(cik, env, f, now);
    if (ins.filings > 0) { input.insiderTransactions = ins.txs; sources.push(ref("SEC EDGAR Form 4 filings", `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=4`, now)); notes.push(`Insider data: ${ins.filings} Form 4 filing(s) in the last 180 days parsed (${ins.txs.length} open-market transaction(s)${ins.failures ? `, ${ins.failures} filing(s) failed to load` : ""}).`); }
    else notes.push("No Form 4 filings in the last 180 days: insider activity is genuinely nil or unavailable; no insider conclusion is drawn.");
  } catch (e) { notes.push(`Insider data unavailable: ${e instanceof Error ? e.message : "error"}`); }
  notes.push("Institutional ownership (13F) is not ingested: aggregating 13F holdings needs a paid provider or a bulk pipeline.");
  return { input: { symbol: ticker.toUpperCase(), ...input, sources, now }, notes };
}


// ------------------------------ SEC Form 4 (insider transactions) ------------------------------
export interface InsiderTxParsed { date: string; type: "buy" | "sell"; shares: number; valueUsd?: number; role?: string; plannedSale?: boolean }
/**
 * Parses one Form 4 XML document. Only OPEN-MARKET purchases (code P) and sales (code S) are kept: grants, option exercises,
 * tax withholding and gifts carry little information about insider conviction. Sales referencing a 10b5-1 plan are flagged as planned.
 */
export function parseForm4Xml(xml: string): InsiderTxParsed[] {
  const out: InsiderTxParsed[] = [];
  const val = (b: string, t: string) => b.match(new RegExp(`<${t}>\\s*<value>([^<]*)</value>`, "i"))?.[1]?.trim();
  const title = xml.match(/<officerTitle>([^<]*)<\/officerTitle>/i)?.[1]?.trim(), isDir = /<isDirector>\s*(1|true)\s*<\/isDirector>/i.test(xml), isTen = /<isTenPercentOwner>\s*(1|true)\s*<\/isTenPercentOwner>/i.test(xml);
  const role = title || (isDir ? "Director" : isTen ? "10% owner" : undefined);
  const notes = new Map<string, string>(); for (const m of xml.matchAll(/<footnote\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/footnote>/gi)) notes.set(m[1], m[2]);
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)) {
    const b = m[1], code = b.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i)?.[1]?.toUpperCase();
    if (code !== "P" && code !== "S") continue;
    const date = val(b, "transactionDate"), shares = Number(val(b, "transactionShares")), price = Number(val(b, "transactionPricePerShare"));
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date) || !Number.isFinite(shares) || shares <= 0) continue;
    const ids = [...b.matchAll(/<footnoteId\s+id="([^"]+)"/gi)].map(x => x[1]);
    out.push({ date: date.slice(0, 10), type: code === "P" ? "buy" : "sell", shares, valueUsd: Number.isFinite(price) && price > 0 ? shares * price : undefined, role, plannedSale: code === "S" && ids.some(id => /10b5-?1/i.test(notes.get(id) ?? "")) });
  }
  return out;
}
export function form4Urls(cik: string, submissions: any, now: number, max = 8): string[] {
  const r = submissions?.filings?.recent, urls: string[] = [];
  if (!r || !Array.isArray(r.form)) return urls;
  const c = String(Number(cik));
  for (let i = 0; i < r.form.length && urls.length < max; i++) {
    if (r.form[i] !== "4") continue;
    const d = Date.parse(r.filingDate?.[i]); if (!Number.isFinite(d) || now - d > 180 * DAYS) continue;
    const acc = String(r.accessionNumber?.[i] ?? "").replace(/-/g, ""), doc = String(r.primaryDocument?.[i] ?? "").replace(/^xsl[^/]*\//i, "");
    if (/^\d{18}$/.test(acc) && /^[\w.-]+\.xml$/i.test(doc)) urls.push(`https://www.sec.gov/Archives/edgar/data/${c}/${acc}/${doc}`);
  }
  return urls;
}
export async function fetchInsiderTransactions(cik: string, env: AnalysisEnv, f: FetchFn, now: number): Promise<{ txs: InsiderTxParsed[]; filings: number; failures: number }> {
  const h = { "user-agent": env.SEC_USER_AGENT ?? "" };
  const subs = await getJson(f, "SEC EDGAR", `https://data.sec.gov/submissions/CIK${cik}.json`, h), urls = form4Urls(cik, subs, now);
  const txs: InsiderTxParsed[] = []; let failures = 0;
  await Promise.all(urls.map(async u => { try { const r = await f(u, { headers: h, signal: AbortSignal.timeout(TIMEOUT) }); if (!r.ok) throw new Error(String(r.status)); txs.push(...parseForm4Xml(await r.text())); } catch { failures++; } }));
  return { txs, filings: urls.length, failures };
}

// ------------------------------ FRED (FX macro) ------------------------------
export interface SeriesSpec { id: string; transform?: "level" | "yoy_index" }
export type MacroField = "policyRate" | "inflation" | "unemployment" | "gdp" | "yield10y";
export type FredConfig = Record<string, Partial<Record<MacroField, string | SeriesSpec>>>;
/** Built-in series are limited to USD ones whose IDs are well established. Other currencies must be configured via FRED_SERIES_JSON. */
/**
 * USD and EUR series are well-established. GBP/JPY/CAD/AUD/NZD/CHF use FRED's OECD "Main Economic Indicators" naming pattern; those IDs are
 * UNVERIFIED from the build environment and some OECD mirrors on FRED are no longer updated, which the staleness check will flag.
 * Anything wrong or missing is reported per field; override everything with FRED_SERIES_JSON.
 */
export const DEFAULT_FRED: FredConfig = {
  USD: { policyRate: "FEDFUNDS", inflation: { id: "CPIAUCSL", transform: "yoy_index" }, unemployment: "UNRATE", gdp: "A191RL1Q225SBEA", yield10y: "DGS10" },
  EUR: { policyRate: "ECBDFR", inflation: { id: "CP0000EZ19M086NEST", transform: "yoy_index" }, unemployment: "LRHUTTTTEZM156S", yield10y: "IRLTLT01EZM156N" },
  GBP: { policyRate: "IRSTCB01GBM156N", inflation: "CPALTT01GBM659N", unemployment: "LRHUTTTTGBM156S", yield10y: "IRLTLT01GBM156N" }, JPY: { policyRate: "IRSTCB01JPM156N", inflation: "CPALTT01JPM659N", unemployment: "LRHUTTTTJPM156S", yield10y: "IRLTLT01JPM156N" }, CAD: { policyRate: "IRSTCB01CAM156N", inflation: "CPALTT01CAM659N", unemployment: "LRHUTTTTCAM156S", yield10y: "IRLTLT01CAM156N" }, AUD: { policyRate: "IRSTCB01AUM156N", inflation: "CPALTT01AUM659N", unemployment: "LRHUTTTTAUM156S", yield10y: "IRLTLT01AUM156N" }, NZD: { policyRate: "IRSTCB01NZM156N", inflation: "CPALTT01NZM659N", unemployment: "LRHUTTTTNZM156S", yield10y: "IRLTLT01NZM156N" }, CHF: { policyRate: "IRSTCB01CHM156N", inflation: "CPALTT01CHM659N", unemployment: "LRHUTTTTCHM156S", yield10y: "IRLTLT01CHM156N" },
};
export const DOLLAR_INDEX_SERIES = "DTWEXBGS";
export function parseFredObservations(j: any): { date: string; value: number }[] {
  return (Array.isArray(j?.observations) ? j.observations : []).map((o: any) => ({ date: String(o.date), value: Number(o.value) })).filter((o: any) => Number.isFinite(o.value) && /^\d{4}-\d{2}-\d{2}$/.test(o.date)).sort((a: any, b: any) => b.date.localeCompare(a.date));
}
export function yoyFromIndex(obs: { date: string; value: number }[]): { date: string; value: number } | null {
  const latest = obs[0]; if (!latest) return null;
  const target = new Date(latest.date); target.setUTCFullYear(target.getUTCFullYear() - 1);
  const prior = obs.find(o => Math.abs(Date.parse(o.date) - target.getTime()) <= 20 * DAYS);
  return prior ? { date: latest.date, value: (latest.value / prior.value - 1) * 100 } : null;
}
async function fred(f: FetchFn, key: string, id: string, limit: number) {
  return parseFredObservations(await getJson(f, "FRED", `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=${limit}`));
}
export function fredConfig(env: AnalysisEnv): FredConfig {
  if (!env.FRED_SERIES_JSON) return DEFAULT_FRED;
  try { return { ...DEFAULT_FRED, ...JSON.parse(env.FRED_SERIES_JSON) }; } catch { throw new SourceError("FRED", "FRED_SERIES_JSON is not valid JSON"); }
}
export async function fetchCurrencyMacro(code: string, env: AnalysisEnv, f: FetchFn): Promise<{ macro: CurrencyMacro; missing: string[] }> {
  if (!env.FRED_API_KEY) throw new SourceError("FRED", "FRED_API_KEY is not configured", "Create a free key at https://fred.stlouisfed.org/docs/api/api_key.html and set FRED_API_KEY");
  const cfg = fredConfig(env)[code], macro: CurrencyMacro = { code }, missing: string[] = [];
  if (!cfg) return { macro, missing: [`No FRED series configured for ${code} (set FRED_SERIES_JSON, or POST macro data)`] };
  let newest = "";
  const fields: [MacroField, keyof CurrencyMacro][] = [["policyRate", "policyRatePct"], ["inflation", "inflationYoYPct"], ["unemployment", "unemploymentPct"], ["gdp", "gdpGrowthPct"], ["yield10y", "yield10yPct"]];
  await Promise.all(fields.map(async ([k, out]) => {
    const spec = cfg[k]; if (!spec) { missing.push(`${code} ${k}`); return; }
    const s: SeriesSpec = typeof spec === "string" ? { id: spec } : spec;
    try {
      const obs = await fred(f, env.FRED_API_KEY!, s.id, s.transform === "yoy_index" ? 16 : k === "policyRate" ? 12 : 5);
      const v = s.transform === "yoy_index" ? yoyFromIndex(obs) : obs[0] ?? null;
      if (!v) { missing.push(`${code} ${k} (series ${s.id} had no usable observation)`); return; }
      (macro as any)[out] = Number(v.value.toFixed(3)); if (v.date > newest) newest = v.date;
      if (k === "policyRate") { const old = obs.find(o => Date.parse(v.date) - Date.parse(o.date) >= 150 * DAYS); if (old && !macro.policyBias) { const d = v.value - old.value; macro.policyBias = d > 0.2 ? "hawkish" : d < -0.2 ? "dovish" : "neutral"; macro.policyBiasSource = `derived from the policy-rate change over ~6 months (${old.value} -> ${v.value}); not a reading of central-bank guidance`; } }
      if (k === "gdp") macro.gdpBasis = "real GDP, % change from prior period, annualised (US); not directly comparable to YoY series";
    } catch (e) { missing.push(`${code} ${k}: ${e instanceof Error ? e.message : "failed"}`); }
  }));
  macro.asOf = newest || undefined;
  return { macro, missing };
}
export async function fetchDollarTrend(env: AnalysisEnv, f: FetchFn): Promise<{ value: number; periodDays: number; asOf: string } | null> {
  if (!env.FRED_API_KEY) return null;
  const obs = await fred(f, env.FRED_API_KEY, DOLLAR_INDEX_SERIES, 30);
  if (obs.length < 15) return null;
  const a = obs[0], b = obs[Math.min(obs.length - 1, 19)];
  return { value: Number(((a.value / b.value - 1) * 100).toFixed(3)), periodDays: Math.round((Date.parse(a.date) - Date.parse(b.date)) / DAYS), asOf: a.date };
}
