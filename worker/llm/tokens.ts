/**
 * Token estimation. There is no tokenizer in a Worker, so this is a calibrated ESTIMATE (chars per token differ for prose, JSON and digits);
 * the real figure is always the `usage` block the provider returns, which the usage tracker records next to the estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let digits = 0, punct = 0, other = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++; else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32 || c === 10) other++; else punct++;
  }
  // Words ~4.2 chars/token, digits ~2.2 chars/token, punctuation/JSON syntax ~1.4 chars/token; non-ASCII counted as punctuation (conservative).
  return Math.max(1, Math.ceil(other / 4.2 + digits / 2.2 + punct / 1.4));
}
