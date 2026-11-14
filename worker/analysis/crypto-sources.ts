// Keyless/free data sources that fill the crypto-fundamentals gaps the main CoinGecko adapter cannot:
//   GoPlus       -> holder concentration, honeypot/mint/proxy/hidden-owner flags, DEX liquidity, LP locks (EVM chains)
//   DeFiLlama    -> audits and audit links, TVL
//   GitHub       -> real development activity (commits, last push)
//   operator profiles (CRYPTO_PROFILES_JSON) -> team identity, regulatory notes, governance, audits: facts no free API provides
// Each parser is pure and unit-tested on schema-shaped fixtures. Every fetch failure becomes a note, never invented data.
import type { CryptoInput } from "./fundamental.ts";
import { SourceError, type AnalysisEnv, type FetchFn } from "./fundamental-sources.ts";

export const CHAIN_IDS: Record<string, number> = { ethereum: 1, "binance-smart-chain": 56, base: 8453, "arbitrum-one": 42161, "polygon-pos": 137, "optimistic-ethereum": 10, avalanche: 43114 };
const CHAIN_PREFERENCE = ["ethereum", "binance-smart-chain", "base", "arbitrum-one", "polygon-pos", "optimistic-ethereum", "avalanche"];
export function pickContract(platforms: Record<string, string> | undefined): { chain: string; chainId: number; address: string } | null {
  if (!platforms) return null;
  for (const chain of CHAIN_PREFERENCE) { const a = platforms[chain]; if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) return { chain, chainId: CHAIN_IDS[chain], address: a.toLowerCase() }; }
  return null;
}
const TIMEOUT = 9000;
async function getText(f: FetchFn, source: string, url: string, headers: Record<string, string> = {}, accept = "application/json"): Promise<Response> {
  let r: Response;
  try { r = await f(url, { headers: { accept, ...headers }, signal: AbortSignal.timeout(TIMEOUT) }); } catch (e) { throw new SourceError(source, `${source} request failed: ${e instanceof Error ? e.message : "network error"}`); }
  return r;
}
const frac = (v: unknown): number | undefined => { const n = Number(v); return v !== "" && v !== null && v !== undefined && Number.isFinite(n) ? n : undefined; };
const flag = (v: unknown): boolean | undefined => (v === "1" || v === 1 || v === true ? true : v === "0" || v === 0 || v === false ? false : undefined);
const BURN = new Set(["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);

// ------------------------------ GoPlus ------------------------------
export interface GoPlusParsed { input: Partial<CryptoInput>; notes: string[]; warnings: string[] }
export function parseGoPlus(j: any, address: string): GoPlusParsed {
  const t = j?.result?.[address.toLowerCase()] ?? j?.result?.[address];
  if (!t || typeof t !== "object") throw new SourceError("GoPlus", j?.message && j.code !== 1 ? `GoPlus: ${j.message}` : "GoPlus has no record for this contract");
  const notes: string[] = [], warnings: string[] = [];
  const holders: any[] = Array.isArray(t.holders) ? t.holders : [];
  let raw = 0, excl = 0, unlabelled = 0;
  for (const h of holders.slice(0, 10)) {
    const p = frac(h.percent) ?? 0; raw += p;
    const addr = String(h.address ?? "").toLowerCase(), isContract = flag(h.is_contract) === true, locked = flag(h.is_locked) === true, tagged = typeof h.tag === "string" && h.tag.trim() !== "";
    if (BURN.has(addr) || locked || tagged) continue;
    if (isContract) unlabelled++;
    excl += p;
  }
  const dex = (Array.isArray(t.dex) ? t.dex : []).reduce((s: number, d: any) => s + (frac(d.liquidity) ?? 0), 0);
  const lp: any[] = Array.isArray(t.lp_holders) ? t.lp_holders : [];
  const lpLocked = lp.length ? lp.reduce((s, h) => s + ((flag(h.is_locked) === true || BURN.has(String(h.address ?? "").toLowerCase())) ? frac(h.percent) ?? 0 : 0), 0) : undefined;
  const sellTax = frac(t.sell_tax), buyTax = frac(t.buy_tax), owner = String(t.owner_address ?? "").toLowerCase();
  const input: Partial<CryptoInput> = {
    holders: holders.length ? { top10Pct: Number((excl * 100).toFixed(2)), top100Pct: undefined, excludesExchangesAndBurn: true, insiderPct: frac(t.creator_percent) !== undefined ? Number((frac(t.creator_percent)! * 100).toFixed(2)) : undefined } : undefined,
    liquidity: dex > 0 ? { dexLiquidityUsd: Math.round(dex) } : undefined,
    security: { sourceVerified: flag(t.is_open_source), upgradeable: flag(t.is_proxy), mintable: flag(t.is_mintable), freezable: flag(t.transfer_pausable) === true || flag(t.is_blacklisted) === true ? true : flag(t.transfer_pausable) === undefined ? undefined : false,
      honeypot: flag(t.is_honeypot), hiddenOwner: flag(t.hidden_owner) === true || flag(t.can_take_back_ownership) === true ? true : flag(t.hidden_owner) === undefined ? undefined : false,
      sellTaxPct: sellTax !== undefined ? Number((sellTax * 100).toFixed(2)) : undefined, buyTaxPct: buyTax !== undefined ? Number((buyTax * 100).toFixed(2)) : undefined,
      ownerRenounced: owner ? (owner === "" || BURN.has(owner)) : undefined, liquidityLockedPct: lpLocked !== undefined ? Number((lpLocked * 100).toFixed(2)) : undefined },
  };
  if (holders.length) notes.push(`Holder data: raw top-10 ${(raw * 100).toFixed(1)}%; after excluding burn, locked and labelled wallets ${(excl * 100).toFixed(1)}% (a lower bound: only 10 holders are listed).`);
  if (unlabelled > 0) warnings.push(`${unlabelled} of the top holders are unlabelled contracts (could be vesting, staking or exchange wallets): concentration may be overstated`);
  if (flag(t.selfdestruct) === true) warnings.push("Contract contains a self-destruct function");
  if (flag(t.external_call) === true) warnings.push("Contract makes external calls that can change its behaviour");
  notes.push("Contract security (GoPlus) is automated static analysis: it detects known risky patterns but does not replace a manual audit.");
  return { input, notes, warnings };
}
export async function fetchGoPlus(c: { chainId: number; address: string }, f: FetchFn): Promise<GoPlusParsed> {
  const r = await getText(f, "GoPlus", `https://api.gopluslabs.io/api/v1/token_security/${c.chainId}?contract_addresses=${c.address}`);
  if (!r.ok) throw new SourceError("GoPlus", `GoPlus returned HTTP ${r.status}`);
  let j: any; try { j = await r.json(); } catch { throw new SourceError("GoPlus", "GoPlus returned invalid JSON"); }
  return parseGoPlus(j, c.address);
}

// ------------------------------ DeFiLlama (head-only parse to stay inside Free-plan CPU) ------------------------------
/** Reads a JSON value that starts at `start` (after the colon) by bracket matching, without parsing the whole document. */
function readValue(text: string, start: number): unknown {
  let i = start; while (text[i] === " ") i++;
  const open = text[i];
  if (open === "[" || open === "{") {
    const close = open === "[" ? "]" : "}"; let depth = 0, inStr = false, esc = false;
    for (let k = i; k < text.length; k++) { const ch = text[k]; if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; } if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close && --depth === 0) { try { return JSON.parse(text.slice(i, k + 1)); } catch { return undefined; } } }
    return undefined;
  }
  const m = text.slice(i, i + 400).match(/^("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/);
  if (!m) return undefined; try { return JSON.parse(m[1]); } catch { return undefined; }
}
export function extractTopLevel(text: string, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) { const m = text.match(new RegExp(`"${k}"\\s*:`)); if (m && m.index !== undefined) { const v = readValue(text, m.index + m[0].length); if (v !== undefined) out[k] = v; } }
  return out;
}
export interface LlamaParsed { slug: string; audits: number | null; auditLinks: string[]; category?: string; geckoId?: string; forkedFrom: string[]; github: string[] }
export function parseLlamaHead(text: string, slug: string): LlamaParsed {
  const f = extractTopLevel(text, ["audits", "audit_links", "category", "gecko_id", "forkedFrom", "github"]);
  const a = f.audits === undefined || f.audits === null ? null : Number(f.audits);
  return { slug, audits: a !== null && Number.isFinite(a) ? a : null, auditLinks: Array.isArray(f.audit_links) ? (f.audit_links as unknown[]).filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)).slice(0, 8) : [],
    category: typeof f.category === "string" ? f.category : undefined, geckoId: typeof f.gecko_id === "string" ? f.gecko_id : undefined,
    forkedFrom: Array.isArray(f.forkedFrom) ? (f.forkedFrom as unknown[]).filter((x): x is string => typeof x === "string") : [], github: Array.isArray(f.github) ? (f.github as unknown[]).filter((x): x is string => typeof x === "string") : [] };
}
async function readHead(f: FetchFn, url: string, bytes: number): Promise<string | null> {
  const r = await getText(f, "DeFiLlama", url);
  if (r.status === 404) return null;
  if (!r.ok) throw new SourceError("DeFiLlama", `DeFiLlama returned HTTP ${r.status}`);
  const reader = r.body?.getReader(); if (!reader) return (await r.text()).slice(0, bytes);
  const dec = new TextDecoder(); let acc = "";
  while (acc.length < bytes) { const { done, value } = await reader.read(); if (done) break; acc += dec.decode(value, { stream: true }); }
  try { await reader.cancel(); } catch { /* already closed */ }
  return acc;
}
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function llamaToInput(p: LlamaParsed, tvlUsd?: number): { input: Partial<CryptoInput>; notes: string[] } {
  const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
  const audits = p.auditLinks.length ? p.auditLinks.map(u => ({ firm: hostOf(u), url: u })) : (p.audits ?? 0) > 0 ? Array.from({ length: Math.min(3, p.audits!) }, () => ({ firm: "unspecified (listed by DeFiLlama)" })) : [];
  const notes = [`DeFiLlama protocol "${p.slug}"${p.category ? ` (${p.category})` : ""}: ${audits.length} audit(s) listed${p.forkedFrom.length ? `; forked from ${p.forkedFrom.join(", ")}` : ""}`];
  if (p.forkedFrom.length) notes.push("Forked code inherits the original's audits only if unchanged: check the diff");
  return { input: { security: { audits }, network: tvlUsd !== undefined ? { tvlUsd } : undefined }, notes };
}
export async function fetchLlama(cgId: string, name: string | undefined, f: FetchFn): Promise<{ input: Partial<CryptoInput>; notes: string[] } | null> {
  for (const slug of [...new Set([cgId, name ? slugify(name) : ""].filter(Boolean))]) {
    const head = await readHead(f, `https://api.llama.fi/protocol/${encodeURIComponent(slug)}`, 40000);
    if (head === null) continue;
    const p = parseLlamaHead(head, slug);
    if (p.geckoId && p.geckoId !== cgId && !name) continue;
    let tvl: number | undefined; try { const r = await getText(f, "DeFiLlama", `https://api.llama.fi/tvl/${encodeURIComponent(slug)}`); if (r.ok) { const n = Number(await r.text()); if (Number.isFinite(n) && n >= 0) tvl = n; } } catch { /* optional */ }
    return llamaToInput(p, tvl);
  }
  return null;
}

// ------------------------------ GitHub ------------------------------
export function parseGithubUrl(u: string | undefined): { owner: string; repo: string } | null {
  const m = String(u ?? "").match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
export function parseGithubActivity(repo: any, participation: any, contributorsLink: string | null, now: number): { input: Partial<CryptoInput>; notes: string[] } {
  const weeks: number[] = Array.isArray(participation?.all) ? participation.all.filter((x: unknown) => typeof x === "number") : [];
  const commits90d = weeks.length >= 13 ? weeks.slice(-13).reduce((s, v) => s + v, 0) : undefined;
  const last = typeof repo?.pushed_at === "string" ? repo.pushed_at : undefined;
  const lastPage = contributorsLink?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
  const notes = [`GitHub ${repo?.full_name ?? "repository"}: ${repo?.archived ? "ARCHIVED, " : ""}${commits90d !== undefined ? `${commits90d} commits in the last 13 weeks, ` : "commit statistics still being computed by GitHub, "}last push ${last ?? "unknown"}${lastPage ? `, ${lastPage} contributors in total` : ""}.`];
  if (repo?.fork) notes.push("The repository is a fork: activity may reflect upstream, not this project.");
  return { input: { development: { commits90d, lastCommitDate: repo?.archived ? "1970-01-01T00:00:00Z" : last, repoUrl: repo?.html_url } }, notes };
}
export async function fetchGithubActivity(repoUrl: string, env: AnalysisEnv & { GITHUB_TOKEN?: string }, f: FetchFn, now: number) {
  const gh = parseGithubUrl(repoUrl); if (!gh) throw new SourceError("GitHub", "not a github.com repository URL");
  const h: Record<string, string> = { "user-agent": "ETI-Analysis", accept: "application/vnd.github+json", ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) };
  const base = `https://api.github.com/repos/${gh.owner}/${gh.repo}`;
  const repoR = await getText(f, "GitHub", base, h);
  if (repoR.status === 403 || repoR.status === 429) throw new SourceError("GitHub", "GitHub rate limit reached (set GITHUB_TOKEN to raise it)", "Set GITHUB_TOKEN (any fine-grained token with no permissions)");
  if (!repoR.ok) throw new SourceError("GitHub", `GitHub returned HTTP ${repoR.status}`);
  const repo = await repoR.json();
  const [part, contr] = await Promise.all([getText(f, "GitHub", `${base}/stats/participation`, h).then(r => (r.status === 200 ? r.json() : null)).catch(() => null), getText(f, "GitHub", `${base}/contributors?per_page=1&anon=1`, h).then(r => r.headers.get("link")).catch(() => null)]);
  return parseGithubActivity(repo, part, contr, now);
}

// ------------------------------ operator-curated profiles ------------------------------
/** Facts no free API provides (who the team is, regulatory status, audits you have verified) live in an operator-maintained JSON variable. */
export interface CuratedProfile { team?: CryptoInput["team"]; regulatory?: CryptoInput["regulatory"]; governance?: CryptoInput["governance"]; audits?: { firm: string; date?: string; url?: string }[]; unlocks?: CryptoInput["unlocks"]; vesting?: string; knownExploitUnresolved?: boolean; source?: string; asOf?: string }
export function curatedProfile(env: { CRYPTO_PROFILES_JSON?: string }, symbol: string): { profile: CuratedProfile | null; error?: string } {
  if (!env.CRYPTO_PROFILES_JSON) return { profile: null };
  try {
    const all = JSON.parse(env.CRYPTO_PROFILES_JSON), p = all?.[symbol.toUpperCase()];
    if (!p || typeof p !== "object") return { profile: null };
    const out: CuratedProfile = {};
    if (p.team && typeof p.team === "object") out.team = { publiclyIdentified: typeof p.team.publiclyIdentified === "boolean" ? p.team.publiclyIdentified : undefined, founders: Array.isArray(p.team.founders) ? p.team.founders.filter((x: unknown) => typeof x === "string").slice(0, 10) : undefined, notes: typeof p.team.notes === "string" ? p.team.notes.slice(0, 400) : undefined };
    if (p.regulatory && ["low", "medium", "high"].includes(p.regulatory.risk)) out.regulatory = { risk: p.regulatory.risk, notes: typeof p.regulatory.notes === "string" ? p.regulatory.notes.slice(0, 400) : undefined };
    if (p.governance && typeof p.governance === "object") out.governance = { model: typeof p.governance.model === "string" ? p.governance.model : undefined, proposals90d: typeof p.governance.proposals90d === "number" ? p.governance.proposals90d : undefined, turnoutPct: typeof p.governance.turnoutPct === "number" ? p.governance.turnoutPct : undefined };
    if (Array.isArray(p.audits)) out.audits = p.audits.filter((a: any) => a && typeof a.firm === "string").slice(0, 10).map((a: any) => ({ firm: a.firm, date: typeof a.date === "string" ? a.date : undefined, url: typeof a.url === "string" && /^https?:\/\//.test(a.url) ? a.url : undefined }));
    if (Array.isArray(p.unlocks)) out.unlocks = p.unlocks.filter((u: any) => u && typeof u.date === "string" && typeof u.tokens === "number" && u.tokens > 0).slice(0, 50).map((u: any) => ({ date: u.date, tokens: u.tokens, insider: u.insider === true }));
    if (typeof p.vesting === "string") out.vesting = p.vesting.slice(0, 300);
    if (p.knownExploitUnresolved === true) out.knownExploitUnresolved = true;
    out.source = typeof p.source === "string" ? p.source.slice(0, 200) : "operator-curated profile"; out.asOf = typeof p.asOf === "string" ? p.asOf : undefined;
    return { profile: out };
  } catch { return { profile: null, error: "CRYPTO_PROFILES_JSON is not valid JSON" }; }
}
