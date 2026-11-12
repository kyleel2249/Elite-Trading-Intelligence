// Sentiment and news intelligence. Pure functions over NewsItem[]; fetching lives in news-feeds.ts.
// Principles: every event carries a timestamp and source; social claims stay UNVERIFIED until corroborated;
// outdated, conflicting and possibly manipulated items are detected and surfaced, never silently averaged in.
import { TIER, type NewsItem, type SourceType } from "./news-feeds.ts";
import { clamp, round, stanceOf, unavailableReport, type EngineReport, type Finding, type Stance } from "./types.ts";

const HOUR = 3600000;
export const SENTIMENT_RULES = { dedupeSimilarity: 0.5, maxFutureSkewMs: 5 * 60000, halfLifeHours: { social: 6, other: 24 }, outdatedHours: 72, excludeHours: 168, burstWindowMin: 60, burstMinItems: 4, corroborationSimilarity: 0.3 } as const;

const POS = ["surge", "surges", "rally", "rallies", "gain", "gains", "rise", "rises", "beat", "beats", "record", "growth", "approve", "approves", "approved", "approval", "upgrade", "upgrades", "bullish", "strong", "stronger", "recovery", "adoption", "partnership", "launch", "launches", "profit", "profits", "outperform", "raises", "expands", "inflow", "inflows", "easing", "cuts rates", "rate cut", "soft landing", "boost", "boosts", "optimism", "breakthrough"];
const NEG = ["plunge", "plunges", "crash", "crashes", "fall", "falls", "drop", "drops", "miss", "misses", "loss", "losses", "decline", "declines", "downgrade", "downgrades", "bearish", "weak", "weaker", "recession", "hack", "hacked", "exploit", "exploited", "lawsuit", "sues", "sued", "ban", "bans", "banned", "fraud", "probe", "investigation", "default", "bankruptcy", "insolvency", "outflow", "outflows", "rate hike", "hikes", "hawkish", "layoffs", "warning", "warns", "fine", "fined", "delist", "delisting", "sanction", "sanctions", "inflation surges", "concern", "concerns", "selloff", "sell-off", "liquidation", "liquidations"];
const NEGATORS = ["not", "no", "denies", "denied", "without", "fails", "failed", "never", "unlikely", "rejects", "rejected", "dismisses"];
const HYPE = ["guaranteed", "100x", "1000x", "moon", "mooning", "to the moon", "can't lose", "cant lose", "last chance", "don't miss", "dont miss", "insider tip", "secret", "explode", "pump", "risk-free", "risk free", "act now", "huge announcement soon", "next bitcoin", "gem", "easy money"];
const CORRECTION = /\b(denies|denied|debunk\w*|retract\w*|correction|corrected|clarif\w+|false report|fake|hoax|not true|unconfirmed)\b/i;
const PRICE_MOVING = /\b(listing|lists|partnership|partners|acquir\w+|acquisition|merger|hack\w*|exploit\w*|etf|approval|approves|approved|delist\w*|bankrupt\w*|insolven\w*|halt\w*|investigation|sec charges|lawsuit)\b/i;
const SHORTENER = /\b(bit\.ly|tinyurl\.com|goo\.gl|ow\.ly|cutt\.ly|rb\.gy)\b/i;
const STOP = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "as", "at", "by", "with", "from", "that", "this", "it", "its", "be", "has", "have", "will", "says", "said", "after", "new"]);

export const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9%.$\s-]/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
export function similarity(a: string, b: string): number { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i); }
const textOf = (i: NewsItem) => `${i.title}. ${i.summary ?? ""}`;

export function polarity(text: string): { score: number; pos: string[]; neg: string[] } {
  const words = text.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean), joined = " " + words.join(" ") + " ", pos: string[] = [], neg: string[] = [];
  let p = 0, n = 0;
  const scan = (list: string[], sign: 1 | -1) => { for (const term of list) { let idx = joined.indexOf(" " + term + " "); while (idx !== -1) {
    const before = joined.slice(Math.max(0, idx - 28), idx).split(" ").filter(Boolean).slice(-3), negated = before.some(w => NEGATORS.includes(w));
    const positive = (sign > 0) !== negated; if (positive) { p++; pos.push(term); } else { n++; neg.push(term); }
    idx = joined.indexOf(" " + term + " ", idx + 1); } } };
  scan(POS, 1); scan(NEG, -1);
  return { score: p + n === 0 ? 0 : (p - n) / (p + n + 1), pos: [...new Set(pos)], neg: [...new Set(neg)] };
}

export interface RejectedItem { id?: string; title: string; reason: string }
export function validateItems(items: NewsItem[], now: number): { valid: NewsItem[]; rejected: RejectedItem[] } {
  const valid: NewsItem[] = [], rejected: RejectedItem[] = [], seen = new Set<string>();
  for (const i of items) {
    const t = Date.parse(i.publishedAt);
    if (!i.title?.trim()) rejected.push({ id: i.id, title: "(untitled)", reason: "missing title" });
    else if (!i.source?.trim()) rejected.push({ id: i.id, title: i.title, reason: "missing source: every event must name its source" });
    else if (!i.publishedAt || !Number.isFinite(t)) rejected.push({ id: i.id, title: i.title, reason: "missing or invalid timestamp: every event must be timestamped" });
    else if (t - now > SENTIMENT_RULES.maxFutureSkewMs) rejected.push({ id: i.id, title: i.title, reason: `timestamp ${i.publishedAt} is in the future: unreliable or manipulated` });
    else if (!(i.sourceType in TIER)) rejected.push({ id: i.id, title: i.title, reason: `unknown sourceType "${i.sourceType}"` });
    else if (seen.has(i.id)) continue;
    else { seen.add(i.id); valid.push(i); }
  }
  return { valid, rejected };
}

export interface Cluster { id: string; lead: NewsItem; items: NewsItem[]; sources: string[]; independentSources: number; bestTier: 1 | 2 | 3 | 4; polarity: number; first: number; last: number; socialOnly: boolean }
export function clusterItems(items: NewsItem[]): Cluster[] {
  const groups: NewsItem[][] = [];
  for (const it of [...items].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
    const g = groups.find(gr => gr.some(x => similarity(x.title, it.title) >= SENTIMENT_RULES.dedupeSimilarity));
    if (g) g.push(it); else groups.push([it]);
  }
  return groups.map(g => {
    const lead = [...g].sort((a, b) => TIER[a.sourceType] - TIER[b.sourceType] || Date.parse(a.publishedAt) - Date.parse(b.publishedAt))[0];
    const sources = [...new Set(g.map(x => x.source))], times = g.map(x => Date.parse(x.publishedAt)), pol = g.map(x => polarity(textOf(x)).score);
    return { id: lead.id, lead, items: g, sources, independentSources: sources.length, bestTier: Math.min(...g.map(x => TIER[x.sourceType])) as 1 | 2 | 3 | 4, polarity: pol.reduce((s, v) => s + v, 0) / pol.length, first: Math.min(...times), last: Math.max(...times), socialOnly: g.every(x => TIER[x.sourceType] === 4) };
  });
}

export type EventStatus = "confirmed" | "reported" | "unverified" | "disputed" | "outdated";
export interface EventRecord { time: string; source: string; sourceType: SourceType; tier: 1 | 2 | 3 | 4; headline: string; url?: string; status: EventStatus; polarity: number; independentSources: number; ageHours: number; notes: string[] }
export interface ManipulationSignal { kind: string; severity: "low" | "medium" | "high"; detail: string; itemIds: string[] }
export interface SentimentConflict { kind: "contradictory_report" | "divergent_news_flow" | "correction_or_denial"; a: string; b: string; detail: string }
export interface SentimentAssessment { events: EventRecord[]; rejected: RejectedItem[]; conflicts: SentimentConflict[]; manipulation: { risk: number; signals: ManipulationSignal[] }; outdatedCount: number; corroboratedSocial: number; unverifiedSocial: number; report: EngineReport }

export function assessSentiment(subject: string, raw: NewsItem[], now = Date.now(), opts: { feedFailures?: string[] } = {}): SentimentAssessment {
  const { valid, rejected } = validateItems(raw, now);
  const warnings: string[] = [...(opts.feedFailures ?? []).map(f => `News feed unavailable: ${f}`)];
  const clusters = clusterItems(valid).filter(c => (now - c.last) / HOUR <= SENTIMENT_RULES.excludeHours || (warnings.push(`Excluded ${c.lead.source} item older than ${SENTIMENT_RULES.excludeHours / 24} days: "${c.lead.title.slice(0, 70)}"`), false));
  const credible = (c: Cluster) => c.items.filter(x => TIER[x.sourceType] <= 3);
  const corroborated = (c: Cluster) => { // Social/unknown claims need a tier-1 source OR two independent tier<=3 sources that match the claim.
    if (!c.socialOnly) return true;
    const match = valid.filter(x => TIER[x.sourceType] <= 3 && similarity(x.title, c.lead.title) >= SENTIMENT_RULES.corroborationSimilarity && Math.abs(Date.parse(x.publishedAt) - c.first) <= 48 * HOUR);
    return match.some(x => TIER[x.sourceType] === 1) || new Set(match.map(x => x.source)).size >= 2;
  };
  // Manipulation heuristics (indicators of risk, not accusations).
  const signals: ManipulationSignal[] = [];
  for (const c of clusters) for (const it of c.items) {
    const hype = HYPE.filter(h => textOf(it).toLowerCase().includes(h));
    if (hype.length >= 2 || (hype.length >= 1 && TIER[it.sourceType] === 4)) signals.push({ kind: "hype_language", severity: hype.length >= 3 ? "high" : "medium", detail: `${it.source}: promotional language (${hype.slice(0, 4).join(", ")})`, itemIds: [it.id] });
    if (it.anonymous && PRICE_MOVING.test(textOf(it))) signals.push({ kind: "anonymous_price_claim", severity: "medium", detail: `${it.source}: price-moving claim attributed to an anonymous source`, itemIds: [it.id] });
    if (SHORTENER.test(textOf(it) + " " + (it.url ?? ""))) signals.push({ kind: "link_shortener", severity: "low", detail: `${it.source}: shortened link hides the destination`, itemIds: [it.id] });
  }
  const social = valid.filter(i => TIER[i.sourceType] === 4).sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  for (let i = 0; i < social.length; i++) {
    const w = social.filter(x => Math.abs(Date.parse(x.publishedAt) - Date.parse(social[i].publishedAt)) <= SENTIMENT_RULES.burstWindowMin * 60000 && similarity(x.title, social[i].title) >= 0.5);
    if (w.length >= SENTIMENT_RULES.burstMinItems && new Set(w.map(x => x.source)).size >= 3 && !signals.some(s => s.kind === "coordinated_burst" && s.itemIds.includes(social[i].id))) {
      const lead = clusters.find(c => c.items.some(x => x.id === social[i].id));
      signals.push({ kind: "coordinated_burst", severity: lead && corroborated(lead) ? "low" : "high", detail: `${w.length} near-identical posts from ${new Set(w.map(x => x.source)).size} accounts within ${SENTIMENT_RULES.burstWindowMin} minutes${lead && corroborated(lead) ? " (but the claim is independently corroborated)" : " and no credible source corroborates the claim"}`, itemIds: w.map(x => x.id) });
    }
  }
  for (const c of clusters) if (c.socialOnly && PRICE_MOVING.test(textOf(c.lead)) && !corroborated(c)) signals.push({ kind: "uncorroborated_price_claim", severity: "medium", detail: `Price-moving claim "${c.lead.title.slice(0, 80)}" exists only on social/unverified sources`, itemIds: c.items.map(x => x.id) });
  for (const c of clusters) if (c.last - c.first > 48 * HOUR && c.bestTier >= 3 && c.items.length >= 3) signals.push({ kind: "recycled_story", severity: "low", detail: `The same headline resurfaces across ${round((c.last - c.first) / HOUR / 24, 1)} days: possibly recycled content presented as new`, itemIds: c.items.map(x => x.id) });
  const risk = clamp(signals.reduce((s, x) => s + (x.severity === "high" ? 35 : x.severity === "medium" ? 18 : 6), 0), 0, 100);
  // Disputes and conflicts.
  const conflicts: SentimentConflict[] = [], disputed = new Set<string>();
  for (const c of clusters) for (const it of credible(c)) if (CORRECTION.test(it.title)) for (const o of clusters) if (o !== c && similarity(o.lead.title, it.title.replace(CORRECTION, " ")) >= 0.25 && o.first <= c.last) { disputed.add(o.id); conflicts.push({ kind: "correction_or_denial", a: o.lead.title, b: it.title, detail: `${it.source} issued a denial/correction/clarification that targets this report` }); }
  const cr = clusters.filter(c => c.bestTier <= 3 && !disputed.has(c.id));
  for (let i = 0; i < cr.length; i++) for (let j = i + 1; j < cr.length; j++) { const a = cr[i], b = cr[j];
    if (Math.abs(a.polarity) >= 0.25 && Math.abs(b.polarity) >= 0.25 && Math.sign(a.polarity) !== Math.sign(b.polarity) && Math.abs(a.last - b.last) <= 48 * HOUR && (now - a.last) / HOUR <= 48 && (now - b.last) / HOUR <= 48) {
      const same = similarity(a.lead.title, b.lead.title) >= 0.12;
      conflicts.push({ kind: same ? "contradictory_report" : "divergent_news_flow", a: `${a.lead.source}: ${a.lead.title}`, b: `${b.lead.source}: ${b.lead.title}`,
        detail: same ? `Credible sources lean opposite ways (${round(a.polarity, 2)} vs ${round(b.polarity, 2)}) on overlapping subject matter` : `Credible but unrelated developments point opposite ways (${round(a.polarity, 2)} vs ${round(b.polarity, 2)}): the news flow is mixed, not contradictory` }); } }
  // Event ledger + weighted score.
  const events: EventRecord[] = [], findings: Finding[] = [];
  let wSum = 0, sSum = 0, outdated = 0, corrobSocial = 0, unverSocial = 0;
  for (const c of clusters.sort((a, b) => b.last - a.last)) {
    const ageH = (now - c.last) / HOUR, notes: string[] = [], isOutdated = ageH > SENTIMENT_RULES.outdatedHours;
    let status: EventStatus = c.bestTier <= 2 ? "confirmed" : c.bestTier === 3 ? "reported" : "unverified";
    if (c.socialOnly) { if (corroborated(c)) { status = "reported"; corrobSocial++; notes.push("Social claim corroborated by independent credible source(s)"); } else { status = "unverified"; unverSocial++; notes.push("Unverified: social/unknown source, no credible corroboration"); } }
    if (disputed.has(c.id)) { status = "disputed"; notes.push("Disputed by a correction or denial"); }
    if (isOutdated) { status = "outdated"; outdated++; notes.push(`Outdated: ${Math.round(ageH)}h old`); }
    const tier = c.bestTier, half = tier === 4 ? SENTIMENT_RULES.halfLifeHours.social : SENTIMENT_RULES.halfLifeHours.other;
    const fresh = Math.pow(0.5, Math.max(0, ageH) / half), tierW = { 1: 1, 2: 0.8, 3: 0.5, 4: 0.1 }[tier] * (c.socialOnly && corroborated(c) ? 5 : 1);
    const w = tierW * fresh * (status === "disputed" ? 0.3 : 1) * (isOutdated ? 0.2 : 1) * Math.min(1.45, 1 + 0.15 * (c.independentSources - 1));
    wSum += w; sSum += w * c.polarity;
    events.push({ time: new Date(c.last).toISOString(), source: c.lead.source, sourceType: c.lead.sourceType, tier, headline: c.lead.title, url: c.lead.url, status, polarity: round(c.polarity, 2), independentSources: c.independentSources, ageHours: round(ageH, 1), notes });
    if (!isOutdated && Math.abs(c.polarity) > 0.1) findings.push({ id: `ev-${c.id}`, kind: "news_event", stance: stanceOf(c.polarity * 100, 10), strength: Math.round(clamp(w * 80, 5, 100)), time: c.last, description: `[${status}] ${c.lead.source} @ ${new Date(c.last).toISOString()}: ${c.lead.title}` });
  }
  if (conflicts.length) findings.unshift({ id: "conflicts", kind: "conflicting_reports", stance: "conflicted", strength: 70, description: `${conflicts.length} conflicting/disputed report pair(s): ${conflicts.slice(0, 2).map(c => c.detail).join("; ")}` });
  if (signals.length) findings.unshift({ id: "manipulation", kind: "manipulation_risk", stance: "neutral", strength: risk, description: `Manipulation indicators (risk ${risk}/100): ${[...new Set(signals.map(s => s.kind))].join(", ")}` });
  if (outdated) warnings.push(`${outdated} item(s) are older than ${SENTIMENT_RULES.outdatedHours}h and are heavily discounted`);
  if (rejected.length) warnings.push(`${rejected.length} item(s) rejected for missing/invalid source or timestamp`);
  if (unverSocial) warnings.push(`${unverSocial} social/unverified narrative(s) are tracked but carry minimal weight until corroborated`);
  const usable = clusters.filter(c => !(now - c.last > SENTIMENT_RULES.outdatedHours * HOUR));
  if (!usable.length) return { events, rejected, conflicts, manipulation: { risk, signals }, outdatedCount: outdated, corroboratedSocial: corrobSocial, unverifiedSocial: unverSocial, report: { ...unavailableReport("sentiment", "sentiment", subject, "No recent, valid, sourced news items were available for this subject", ["recent news within 72h"], now), warnings: warnings.length ? warnings : ["No recent news found"] } };
  const sat = Math.min(1, wSum / 2.5), score = wSum > 0 ? clamp(sSum / wSum * 100 * 1.6 * sat, -100, 100) : 0;
  const conf = clamp(20 + Math.min(wSum, 4) * 12 + (usable.some(c => c.bestTier <= 2) ? 15 : 0) - risk * 0.4 - conflicts.length * 12 - outdated * 2, 0, 100);
  const conflicted = conflicts.length > 0 && usable.length >= 2;
  const report: EngineReport = { engine: "sentiment", domain: "sentiment", subject, stance: conflicted ? "conflicted" : stanceOf(score, 15), score: round(score), confidence: round(conf, 0), confidenceType: "evidence_quality_not_probability", status: valid.length ? "ok" : "partial",
    completeness: round(Math.min(1, usable.length / 5), 2), findings: findings.slice(0, 14), warnings, missing: [], sources: [...new Map(valid.map(i => [i.source, { name: i.source, url: i.url, publishedAt: i.publishedAt, retrievedAt: i.retrievedAt ?? new Date(now).toISOString() }])).values()].slice(0, 20), asOf: new Date(now).toISOString(),
    methodology: `Lexicon-based polarity (finance word lists with negation handling: coarse, not ML), source-tier weighting (regulator/central bank/exchange/company 1.0, wire/research 0.8, media 0.5, social 0.1 until corroborated), freshness decay (half-life ${SENTIMENT_RULES.halfLifeHours.other}h, social ${SENTIMENT_RULES.halfLifeHours.social}h), near-duplicate clustering (Jaccard >= ${SENTIMENT_RULES.dedupeSimilarity}), corroboration rule (tier-1 source or two independent tier<=3 sources), correction/denial detection, and manipulation heuristics. Heuristic indicators are risk flags, not proof of manipulation.`,
    extras: { manipulationRisk: risk, conflictCount: conflicts.length, unverifiedSocial: unverSocial } };
  return { events, rejected, conflicts, manipulation: { risk, signals }, outdatedCount: outdated, corroboratedSocial: corrobSocial, unverifiedSocial: unverSocial, report };
}
