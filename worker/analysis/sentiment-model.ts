// Sentiment model v2 (local, deterministic, no network). Replaces the flat word-list scorer with:
//  * weighted multi-word phrases (longest match first) and word weights
//  * negation, intensifiers/diminishers, hedging ("could", "rumor"), questions, scheduled/routine (neutral) cues
//  * clause structure: "X despite Y" counts Y at 35%, "X but Y" counts X at 50%
//  * adverse nouns: a move word near "unemployment/costs/yields/..." flips ("unemployment falls" is good news)
//  * asset-class-aware polarity: a rate hike is bullish for a currency, bearish for equities/crypto
//  * market-reaction cues: "shares tumble" outweighs the news words around it
// It is a transparent rule model, not a trained classifier: its measured accuracy is in docs/ANALYSIS_ENGINE.md, with the caveat that it was tuned by its author.
export type Cls = "equity" | "crypto" | "fx" | "macro" | "unknown";
export interface ModelCtx { cls?: Cls; ccy?: string }
export interface Match { term: string; weight: number }
export interface ModelScore { score: number; confidence: number; hedged: boolean; question: boolean; neutralCue: boolean; matches: Match[] }

type Entry = { w: number; move?: boolean };
const W = (w: number, move = false): Entry => ({ w, move });
const WORDS: Record<string, Entry> = {};
const add = (words: string, e: Entry) => { for (const x of words.split(/\s+/).filter(Boolean)) WORDS[x] = e; };
// ---- positive
add("surge surges surged soar soars soared spike spikes spiked", W(2.5, true)); add("jump jumps jumped rally rallies rallied", W(2, true)); add("rise rises rose rising gain gains gained", W(1.2, true)); add("climb climbs climbed rebound rebounds rebounded", W(1.5, true));
add("recover recovers recovered recovery", W(1.3, true)); add("strengthens strengthen strengthened firms firmed", W(1.5, true)); add("strong stronger strength", W(1.5)); add("boost boosts boosted lifts lift lifted", W(1.5)); add("upgrade upgrades upgraded", W(2));
add("outperform outperforms outperformed beat beats beating tops topped", W(2)); add("exceed exceeds exceeded", W(1.8)); add("record", W(1.2)); add("growth grow grows expand expands expanded", W(1.1)); add("profit profits profitable", W(1)); add("wins win won", W(2));
add("approve approves approved approval", W(2)); add("launch launches launched", W(1)); add("adoption", W(1.5)); add("partnership", W(1)); add("inflow inflows", W(2)); add("accelerates accelerate accelerated", W(1.5)); add("doubles doubled tripled", W(2.2));
add("buyback repurchase", W(2)); add("dividend", W(0.5)); add("lists", W(1.5)); add("optimism optimistic bullish", W(1.8)); add("upside", W(1.5)); add("improves improved improving improvement", W(1.2)); add("stabilizes stabilises", W(1)); add("resumes", W(1));
add("cleared", W(1.8)); add("adds accumulates", W(1.2)); add("buys acquires", W(1)); add("beating", W(2)); add("soaring", W(2.5, true)); add("rallying", W(2, true)); add("outperforming", W(2)); add("meets", W(0.6)); add("returns", W(0.8)); add("launched", W(1));
// ---- negative
add("plunge plunges plunged plummets plummeted crash crashes crashed", W(-3, true)); add("tumble tumbles tumbled slump slumps slumped", W(-2.5, true)); add("sink sinks sank slides slide slid", W(-2, true)); add("fall falls fell falling drop drops dropped decline declines declined", W(-1.5, true));
add("slip slips slipped", W(-1, true)); add("weakens weaken weakened", W(-1.5, true)); add("cools cooled cooling", W(-1.2, true)); add("weak weaker weakness", W(-1.5)); add("miss misses missed", W(-2)); add("loss losses", W(-1.5)); add("lawsuit sues sued", W(-1.6)); add("probe investigation", W(-2));
add("fraud hack hacked", W(-3)); add("hackers exploit exploited exploits", W(-2.5)); add("drain drains drained stolen theft", W(-2.5)); add("bankruptcy insolvent insolvency", W(-3)); add("default defaults", W(-2.5)); add("recall recalls recalled", W(-2));
add("grounds grounded ground", W(-2)); add("halts halted halt suspends suspended", W(-2)); add("outage", W(-2)); add("delay delays delayed", W(-1)); add("layoffs layoff", W(-1.5)); add("resigns resigned resignation quits quit", W(-1.5)); add("charged indicted", W(-2.7));
add("fined fine penalty", W(-2)); add("ban bans banned", W(-2)); add("delist delists delisting delisted", W(-2.5)); add("downgrade downgrades downgraded", W(-2)); add("warning warns warn warned", W(-1.5)); add("concern concerns worries worry fears fear", W(-1.3));
add("softens soften softened", W(-1.5)); add("shrinks shrink shrank", W(-2, true)); add("recession downturn", W(-2)); add("bad", W(-1.5)); add("defect defects", W(-2)); add("struggling struggles", W(-1.5)); add("disappoint disappoints disappointing", W(-2)); add("slowdown", W(-1.5)); add("slows slowed", W(-1.2));
add("collapse collapses collapsed", W(-3)); add("turmoil crisis scandal", W(-2.4)); add("manipulation", W(-2)); add("suffers suffer", W(-1.5)); add("sanction sanctions", W(-2)); add("dilution", W(-1.5)); add("liquidation liquidations", W(-2)); add("outflow outflows", W(-2)); add("dump dumps", W(-2));
add("depeg depegs depegged loses lost", W(-2)); add("tensions escalate escalates", W(-1.2)); add("unexpectedly", W(0)); add("slumping", W(-2.5, true)); add("sinking", W(-2, true)); add("hits", W(0)); add("deficit", W(-1)); add("sell-off selloff", W(-2.5));
// ---- phrases (matched longest-first on space-joined tokens; hyphens become spaces)
const PHRASES: Record<string, Entry> = {
  "record high": W(2.5, true), "all time high": W(2.5, true), "month high": W(1.5, true), "year high": W(1.5, true), "week high": W(1.2, true), "record low": W(-2.5, true), "all time low": W(-2.5, true), "month low": W(-1.5, true), "year low": W(-1.5, true), "week low": W(-1.2, true),
  "beats estimates": W(2.5), "beat estimates": W(2.5), "tops estimates": W(2.5), "beat forecasts": W(2.3), "beats forecasts": W(2.3), "tops forecasts": W(2.3), "beats expectations": W(2.3), "beat expectations": W(2.3), "above expectations": W(2), "above consensus": W(2), "above forecasts": W(2),
  "better than expected": W(2), "stronger than expected": W(2), "better than feared": W(2.5), "not as bad as feared": W(3), "surprises to the upside": W(2), "raises guidance": W(2.5), "raises forecast": W(2.5), "raises outlook": W(2.5), "lifts guidance": W(2.5), "lifts outlook": W(2.5), "lifts forecast": W(2.5),
  "raises profit forecast": W(3), "share buyback": W(2.5), "share repurchase": W(2.5), "buyback program": W(2.5), "no charges": W(3), "no evidence of wrongdoing": W(3), "probe ends": W(3), "wins approval": W(3), "fda approval": W(3), "cut costs": W(1.5), "cuts costs": W(1.5), "takes stake": W(1.5), "acquires stake": W(1.5),
  "outlook improves": W(2), "cleared of": W(2.5), "meets main goal": W(3), "clears merger": W(2.5), "launches custody": W(2),
  "miss forecasts": W(-2.5), "misses forecasts": W(-2.5), "miss estimates": W(-2.5), "misses estimates": W(-2.5), "misses expectations": W(-2.5), "below expectations": W(-2), "below forecasts": W(-2), "worse than expected": W(-2), "weaker than expected": W(-2), "files for bankruptcy": W(-3), "chapter 11": W(-3), "chapter 7": W(-3),
  "rules against": W(-2.5), "halts withdrawals": W(-3), "liquidity concerns": W(-2.5), "bad loans": W(-2), "token unlock": W(-2), "token unlocks": W(-2), "rug pull": W(-3), "sold off": W(-2.5), "sell off": W(-2.5), "recession worries": W(-3), "unregistered securities": W(-2), "loses peg": W(-3),
  "network upgrade": W(0), "routine maintenance": W(0), "security patch": W(0), "in line with": W(0), "little changed": W(0), "holds steady": W(0), "no change": W(0), "unchanged": W(0),
};
// ---- asset-class dependent policy/macro phrases: [phrase, weight for FX perspective, weight for everything else]
const POLICY: [string, number, number][] = [
  ["rate hikes", 2, -1.5], ["rate hike", 2, -1.5], ["raises rates", 2, -1.5], ["hikes rates", 2, -1.5], ["raising rates", 2, -1.5], ["rate increase", 2, -1.5], ["rate rise", 2, -1.5], ["higher rates", 1.8, -1.2], ["hawkish", 2, -1.5], ["higher for longer", 1.5, -1.2], ["more hikes", 2, -1.5], ["further hikes", 2, -1.5],
  ["rate cuts", -2, 1.5], ["rate cut", -2, 1.5], ["cuts rates", -2, 1.5], ["lowers rates", -2, 1.5], ["cutting rates", -2, 1.5], ["dovish", -2, 1.5], ["fed cuts", -2, 1.5], ["ultra loose", -1.8, 1], ["stays hot", 1.5, -1.5], ["runs hot", 1.5, -1.5], ["inflation hot", 1.5, -1.5],
];
const NEUTRAL_CUES = ["routine", "scheduled", "to speak", "to hold", "to present", "annual meeting", "annual shareholder meeting", "conference", "maintenance", "attestation", "bulletin", "publishes", "schedules", "earnings call", "governance update", "to speak at"];
const HARD_HEDGES = ["could", "may", "might", "if", "rumor", "rumour", "rumors", "reportedly", "speculation", "considering", "consider", "mulls", "exploring"];
const SOFT_HEDGES = ["expected to", "poised to", "set to", "likely to", "plans to", "planning to"];
const NEGATORS = new Set(["not", "no", "never", "without", "fails", "failed", "denies", "denied", "rejects", "rejected", "unlikely", "nothing"]);
const INTENSIFIERS = new Set(["sharply", "significantly", "steeply", "dramatically", "massively", "heavily", "soaring"]);
const DIMINISHERS = new Set(["slightly", "modestly", "marginally", "mildly", "little"]);
const REACTION_SUBJECTS = new Set(["shares", "share", "stock", "stocks", "price", "prices", "equities", "index", "indices", "bitcoin", "btc", "ether", "eth", "token", "crypto", "dollar", "euro", "yen", "sterling", "pound", "franc", "loonie", "aussie", "kiwi", "gold", "oil", "copper", "market", "markets"]);
const ADVERSE_BASE = new Set(["unemployment", "jobless", "deficit", "debt", "costs", "cost", "expenses", "losses", "defaults", "delinquencies", "vix", "volatility", "outflows", "withdrawals", "claims", "layoffs", "mortgage", "borrowing"]);
const ADVERSE_NON_FX = new Set(["inflation", "yields", "yield"]);
const CUT_VERBS = new Set(["cuts", "cut", "lowers", "slashes", "trims", "reduces"]);
const CUT_TARGETS = new Set(["outlook", "guidance", "forecast", "forecasts", "target", "estimate", "estimates", "view", "dividend", "payout"]);

const tokenize = (s: string) => s.toLowerCase().replace(/[\u2019']/g, "'").replace(/-/g, " ").replace(/[^a-z0-9$%.'\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
// Phrases are indexed by their first token (longest first) so matching costs a Map lookup per token instead of a scan over every phrase.
const PHRASE_INDEX = new Map<string, string[][]>();
for (const k of Object.keys(PHRASES).map(k => k.split(" ")).sort((a, b) => b.length - a.length)) (PHRASE_INDEX.get(k[0]) ?? PHRASE_INDEX.set(k[0], []).get(k[0])!).push(k);
const POLICY_INDEX = new Map<string, { t: string[]; a: number; b: number }[]>();
for (const x of POLICY.map(([p, a, b]) => ({ t: p.split(" "), a, b })).sort((x, y) => y.t.length - x.t.length)) (POLICY_INDEX.get(x.t[0]) ?? POLICY_INDEX.set(x.t[0], []).get(x.t[0])!).push(x);
const freeAt = (used: boolean[], i: number, len: number) => { for (let k = 0; k < len; k++) if (used[i + k]) return false; return true; };
const matchesAt = (tokens: string[], i: number, t: string[]) => { if (i + t.length > tokens.length) return false; for (let k = 0; k < t.length; k++) if (tokens[i + k] !== t[k]) return false; return true; };
const SINGLE_HARD = new Set(HARD_HEDGES.filter(h => !h.includes(" "))), SINGLE_NEUTRAL = new Set(NEUTRAL_CUES.filter(h => !h.includes(" "))), MULTI_NEUTRAL = NEUTRAL_CUES.filter(h => h.includes(" "));

function scoreClause(tokens: string[], ctx: ModelCtx, matches: Match[]): { sum: number; hedge: number; neutral: boolean } {
  let sum = 0, hedge = 1, neutral = false;
  const fx = ctx.cls === "fx", adverse = (t: string) => ADVERSE_BASE.has(t) || (!fx && ADVERSE_NON_FX.has(t));
  const joined = " " + tokens.join(" ") + " ";
  if (tokens.some(t => SINGLE_HARD.has(t))) hedge = 0.15; else if (SOFT_HEDGES.some(h => joined.includes(" " + h + " "))) hedge = 0.7;
  if (tokens.some(t => SINGLE_NEUTRAL.has(t)) || MULTI_NEUTRAL.some(c => joined.includes(" " + c + " "))) neutral = true;
  const used = new Array(tokens.length).fill(false);
  const take = (i: number, len: number) => { for (let k = 0; k < len; k++) used[i + k] = true; };
  const nearBefore = (i: number, n: number, pred: (t: string) => boolean) => { for (let k = Math.max(0, i - n); k < i; k++) if (pred(tokens[k])) return true; return false; };
  const emit = (term: string, e: Entry, i: number, len: number, inherentNeg = false) => {
    let w = e.w; if (w === 0) { return; }
    const negated = !inherentNeg && nearBefore(i, 3, t => NEGATORS.has(t));
    if (negated) w = -w * 0.8;
    const after = tokens[i + len];   // modifiers can follow the verb ("fall sharply") as well as precede it ("sharply lower")
    if (nearBefore(i, 2, t => INTENSIFIERS.has(t)) || (after !== undefined && INTENSIFIERS.has(after)) || (i >= 2 && tokens[i - 2] === "more" && tokens[i - 1] === "than")) w *= 1.4; else if (nearBefore(i, 2, t => DIMINISHERS.has(t)) || (after !== undefined && DIMINISHERS.has(after))) w *= 0.5;
    if (e.move) { if (nearBefore(i, 4, adverse)) w = -w; if (nearBefore(i, 3, t => REACTION_SUBJECTS.has(t))) w *= 1.5; }
    sum += w; matches.push({ term, weight: Number(w.toFixed(2)) });
  };
  // 1. policy phrases (class dependent)
  for (let i = 0; i < tokens.length; i++) for (const p of POLICY_INDEX.get(tokens[i]) ?? []) { if (freeAt(used, i, p.t.length) && matchesAt(tokens, i, p.t)) { const w = fx ? p.a : p.b; sum += w; matches.push({ term: p.t.join(" "), weight: w }); take(i, p.t.length); break; } }
  // 2. fixed phrases, longest first
  for (let i = 0; i < tokens.length; i++) { if (used[i]) continue; for (const k of PHRASE_INDEX.get(tokens[i]) ?? []) { if (freeAt(used, i, k.length) && matchesAt(tokens, i, k)) { const key = k.join(" "), e = PHRASES[key]; if (e.w === 0) neutral = true; emit(key, e, i, k.length, k[0] === "no" || k[0] === "not"); take(i, k.length); break; } } }
  // 3. cut/lower + guidance-type object
  for (let i = 0; i < tokens.length; i++) if (!used[i] && CUT_VERBS.has(tokens[i])) { for (let j = i + 1; j <= Math.min(i + 4, tokens.length - 1); j++) if (CUT_TARGETS.has(tokens[j])) { sum -= 2.5; matches.push({ term: `${tokens[i]} … ${tokens[j]}`, weight: -2.5 }); take(i, 1); used[j] = true; break; } }
  // 4. single words
  for (let i = 0; i < tokens.length; i++) { if (used[i]) continue; const e = WORDS[tokens[i]]; if (e && e.w !== 0) emit(tokens[i], e, i, 1); }
  return { sum, hedge, neutral };
}
/** Scores one text. `score` is in [-1, 1]; `confidence` in [0, 1] reflects evidence strength (not a probability of being right). */
export function scoreText(text: string, ctx: ModelCtx = {}): ModelScore {
  const question = /\?\s*$/.test(text.trim());
  const norm = " " + tokenize(text).join(" ") + " ";
  const parts = norm.split(/(?= despite | although | even though | though | but | however | yet )|;|:/).map(s => s.trim()).filter(Boolean);
  const matches: Match[] = []; let total = 0, hedge = 1, neutral = false, clauses = parts.length;
  parts.forEach((p, idx) => {
    const tk = p.split(" ").filter(Boolean); if (!tk.length) return;
    const sub = /^(despite|although|though)$/.test(tk[0]) || /^even though/.test(p);
    const nextContrast = parts[idx + 1] && /^(but|however|yet) /.test(parts[idx + 1]);
    const weight = sub ? 0.35 : nextContrast ? 0.5 : 1;
    const c = scoreClause(tk, ctx, matches); total += weight * c.sum; if (c.hedge < hedge) hedge = c.hedge; if (c.neutral) neutral = true;
  });
  let score = Math.tanh(total / 3.5) * (hedge < 1 ? hedge : 1);
  if (question) score *= 0.15;
  if (neutral && Math.abs(total) < 2) score *= 0.3;
  const strength = Math.min(1, Math.abs(total) / 4);
  const confidence = matches.length === 0 ? (neutral ? 0.6 : 0.15) : Math.max(0.1, Math.min(1, 0.25 + strength * 0.75)) * (hedge < 1 ? 0.5 : 1) * (question ? 0.3 : 1) * (clauses > 3 ? 0.8 : 1);
  return { score: Number(score.toFixed(3)), confidence: Number(confidence.toFixed(2)), hedged: hedge < 1, question, neutralCue: neutral, matches };
}
export const classify = (score: number, threshold = 0.15): "p" | "n" | "0" => (score > threshold ? "p" : score < -threshold ? "n" : "0");

// ------------------------------ currency perspective for FX pairs ------------------------------
const CCY_KEYS: Record<string, RegExp> = {
  USD: /\b(dollar|greenback|u\.s\.|fed|fomc|federal reserve|treasury|powell|payrolls|nonfarm)\b|\bus\b/i, EUR: /\b(euro|ecb|eurozone|euro area|lagarde)\b/i, GBP: /\b(sterling|pound|bank of england|boe|u\.k\.|uk|gilt)\b/i, JPY: /\b(yen|boj|bank of japan|japan)\b/i,
  CHF: /\b(franc|snb|swiss)\b/i, AUD: /\b(aussie|australian|australia|rba)\b/i, CAD: /\b(loonie|canada|canadian|boc)\b/i, NZD: /\b(kiwi|new zealand|rbnz)\b/i,
};
export function currenciesIn(text: string): string[] { return Object.entries(CCY_KEYS).filter(([, re]) => re.test(text)).map(([c]) => c); }
/** Orientation of a headline for a pair: +1 favours the base currency, -1 the quote, 0 when it concerns both or neither (no safe attribution). */
export function pairOrientation(text: string, base: string, quote: string): { sign: 1 | -1 | 0; ccy?: string } {
  const c = currenciesIn(text), b = c.includes(base), q = c.includes(quote);
  return b && !q ? { sign: 1, ccy: base } : q && !b ? { sign: -1, ccy: quote } : { sign: 0 };
}
