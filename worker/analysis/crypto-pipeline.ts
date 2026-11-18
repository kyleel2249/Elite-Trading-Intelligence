// Assembles a CryptoInput from every available source. Sources run in parallel and fail independently: a dead API lowers coverage
// (and is reported) but never aborts the analysis or gets papered over with invented values.
import type { CryptoInput } from "./fundamental.ts";
import { fetchCryptoFundamentals, SourceError, type AnalysisEnv, type FetchFn } from "./fundamental-sources.ts";
import { curatedProfile, fetchGithubActivity, fetchGoPlus, fetchLlama, pickContract } from "./crypto-sources.ts";
import { fetchUnlockEvents, summarizeUnlocks, type KVLike } from "./tokenomist.ts";

const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
/** One-level deep merge where `undefined` never overwrites a known value. */
export function mergeCrypto(base: Partial<CryptoInput>, patch: Partial<CryptoInput>): Partial<CryptoInput> {
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur) ? { ...defined(cur), ...defined(v as object) } : v;
  }
  return out;
}
export interface CryptoBuild { input: CryptoInput; notes: string[]; warnings: string[]; used: string[]; unavailable: { source: string; reason: string; configure?: string }[]; unlockSummary: ReturnType<typeof summarizeUnlocks> | null }

export async function buildCryptoInput(symbol: string, env: AnalysisEnv, f: FetchFn, kv: KVLike | undefined, now: number): Promise<CryptoBuild> {
  const cg = await fetchCryptoFundamentals(symbol, env, f, now);
  let input: Partial<CryptoInput> = cg.input; const notes = [...cg.notes], warnings: string[] = [], used = ["CoinGecko"], unavailable: CryptoBuild["unavailable"] = [];
  const contract = pickContract(cg.ctx.platforms), curated = curatedProfile(env, symbol);
  const fail = (source: string, e: unknown) => unavailable.push({ source, reason: e instanceof Error ? e.message : "failed", configure: e instanceof SourceError ? e.configure : undefined });

  const [goplus, llama, github, unlocks] = await Promise.allSettled([
    contract ? fetchGoPlus(contract, f) : Promise.resolve(null),
    cg.ctx.id ? fetchLlama(cg.ctx.id, cg.ctx.name, f) : Promise.resolve(null),
    cg.ctx.repoUrl ? fetchGithubActivity(cg.ctx.repoUrl, env, f, now) : Promise.resolve(null),
    env.TOKENOMIST_API_KEY && cg.ctx.id ? fetchUnlockEvents(cg.ctx.id, env, f, kv, now) : Promise.resolve(null),
  ]);
  if (goplus.status === "fulfilled" && goplus.value) { input = mergeCrypto(input, goplus.value.input); notes.push(...goplus.value.notes); warnings.push(...goplus.value.warnings); used.push(`GoPlus (${contract!.chain})`); }
  else if (goplus.status === "rejected") fail("GoPlus", goplus.reason);
  else notes.push("No EVM contract address for this asset (native or non-EVM chain): contract-level checks (honeypot, mint, proxy, holders) do not apply or are unavailable.");
  if (llama.status === "fulfilled" && llama.value) { input = mergeCrypto(input, llama.value.input); notes.push(...llama.value.notes); used.push("DeFiLlama"); }
  else if (llama.status === "rejected") fail("DeFiLlama", llama.reason);
  else if (llama.status === "fulfilled") notes.push("Not listed as a DeFiLlama protocol: audit and TVL data unavailable from this source.");
  if (github.status === "fulfilled" && github.value) { input = mergeCrypto(input, github.value.input); notes.push(...github.value.notes); used.push("GitHub"); }
  else if (github.status === "rejected") fail("GitHub", github.reason);
  let unlockSummary: CryptoBuild["unlockSummary"] = null;
  if (unlocks.status === "fulfilled" && unlocks.value) {
    const ev = unlocks.value.events; input = mergeCrypto(input, { unlocks: ev.map(e => ({ date: e.date, tokens: e.tokens, insider: e.insider })) }); used.push("Tokenomist");
    unlockSummary = summarizeUnlocks(ev, input.supply?.circulating, now);
    notes.push(`Token unlocks (Tokenomist): ${unlockSummary.count} upcoming event(s) in 90 days; raw schedule is not redistributed.`);
    if (unlocks.value.truncated) warnings.push("Tokenomist results were truncated at the page limit: unlock pressure may be understated");
  } else if (unlocks.status === "rejected") fail("Tokenomist", unlocks.reason);
  else if (!env.TOKENOMIST_API_KEY) unavailable.push({ source: "Tokenomist", reason: "TOKENOMIST_API_KEY not configured: unlock schedules unavailable", configure: "Set TOKENOMIST_API_KEY, or list unlocks in CRYPTO_PROFILES_JSON" });

  if (curated.error) warnings.push(curated.error);
  const p = curated.profile;
  if (p) {
    used.push(`operator profile${p.source ? ` (${p.source})` : ""}`);
    input = mergeCrypto(input, { team: p.team, regulatory: p.regulatory, governance: p.governance, vesting: p.vesting, ...(p.unlocks && !unlockSummary ? { unlocks: p.unlocks } : {}) });
    const sec = { ...(input.security ?? {}), knownExploitUnresolved: p.knownExploitUnresolved ?? input.security?.knownExploitUnresolved } as NonNullable<CryptoInput["security"]>;
    if (p.audits?.length) sec.audits = [...(sec.audits ?? []).filter(a => !p.audits!.some(x => x.firm === a.firm)), ...p.audits];
    input = { ...input, security: sec };
    notes.push(`Operator-curated facts applied (team, regulatory, audits as supplied)${p.asOf ? `, as of ${p.asOf}` : ""}. These are your assertions, not independently verified.`);
  } else unavailable.push({ source: "operator profile", reason: "no curated profile for this symbol: team identity, regulatory status and verified audits are unknown", configure: "Add the symbol to CRYPTO_PROFILES_JSON" });
  return { input: { ...(input as CryptoInput), symbol: input.symbol ?? symbol, now }, notes, warnings, used, unavailable, unlockSummary };
}
