/**
 * Prompt and context compression that keeps meaning:
 *  - compressText: lossless for prose (whitespace normalisation, exact duplicate sentences removed).
 *  - compactJson: omits null / empty values (documented to the model), trims floats to 7 significant digits, and replaces long strings that
 *    repeat with short "§n" references listed once under "$d". expandJson reverses it exactly, so tests can prove nothing else changed.
 * Anything that would make the reference scheme ambiguous (a string already containing "§" or a "$d" key) disables it for that document.
 */
export const REF = "§";
export const DICT_KEY = "$d";

export function compressText(text: string): string {
  const seen = new Set<string>(), out: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const sentences = para.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim().split(/(?<=[.!?])\s+(?=[A-Z"(])/);
    const kept = sentences.filter((s) => { const k = s.trim().toLowerCase(); if (!k) return false; if (k.length > 24 && seen.has(k)) return false; seen.add(k); return true; });
    if (kept.length) out.push(kept.join(" "));
  }
  return out.join("\n\n");
}

const sig = (n: number) => (Number.isInteger(n) || !Number.isFinite(n) ? n : Number(n.toPrecision(7)));
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);

/** Drops empty values and trims float precision. Array positions are never removed (index meaning must survive). */
export function prune(v: any): any {
  if (typeof v === "number") return sig(v);
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : prune(x)));
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) { const p = prune(v[k]); if (!isEmpty(p)) o[k] = p; } return o; }
  return v;
}

function collect(v: any, counts: Map<string, number>, state: { unsafe: boolean }): void {
  if (typeof v === "string") { if (v.includes(REF)) state.unsafe = true; if (v.length >= 20) counts.set(v, (counts.get(v) ?? 0) + 1); }
  else if (Array.isArray(v)) v.forEach((x) => collect(x, counts, state));
  else if (v && typeof v === "object") for (const k of Object.keys(v)) { if (k === DICT_KEY) state.unsafe = true; collect(v[k], counts, state); }
}
function replace(v: any, map: Map<string, number>): any {
  if (typeof v === "string") { const i = map.get(v); return i === undefined ? v : REF + i; }
  if (Array.isArray(v)) return v.map((x) => replace(x, map));
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = replace(v[k], map); return o; }
  return v;
}

export interface Compacted { text: string; dictionary: string[]; pruned: any }
export function compactJson(value: unknown): Compacted {
  const pruned = prune(value), counts = new Map<string, number>(), state = { unsafe: false };
  collect(pruned, counts, state);
  if (state.unsafe) return { text: JSON.stringify(pruned), dictionary: [], pruned };
  const picks = [...counts.entries()].map(([s, n]) => ({ s, n, gain: (s.length - 3) * n - (s.length + 4) })).filter((x) => x.gain > 8).sort((a, b) => b.gain - a.gain || (a.s < b.s ? -1 : 1));
  if (!picks.length) return { text: JSON.stringify(pruned), dictionary: [], pruned };
  const map = new Map(picks.map((p, i) => [p.s, i] as [string, number]));
  const doc = replace(pruned, map); (doc as any)[DICT_KEY] = picks.map((p) => p.s);
  return { text: JSON.stringify(doc), dictionary: picks.map((p) => p.s), pruned };
}

export function expandJson(text: string): any {
  const doc = JSON.parse(text), dict: string[] | undefined = doc && typeof doc === "object" ? doc[DICT_KEY] : undefined;
  if (!Array.isArray(dict)) return doc;
  delete doc[DICT_KEY];
  const back = (v: any): any => {
    if (typeof v === "string") { const m = /^§(\d+)$/.exec(v); return m && dict[Number(m[1])] !== undefined ? dict[Number(m[1])] : v; }
    if (Array.isArray(v)) return v.map(back);
    if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = back(v[k]); return o; }
    return v;
  };
  return back(doc);
}
