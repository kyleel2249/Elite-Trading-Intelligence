/**
 * Guards that keep simulated activity out of the actual environment.
 *
 * A profit batch recorded in the "actual" environment must describe real, settled funds. A source or description that names a paper,
 * testnet, sandbox, demo, mock, back-test or other simulated venue is refused before it reaches the ledger. This is a safety net on top of
 * the human settlement and reconciliation steps, not a replacement for them.
 */
const SIMULATED = /(^|[^a-z])(paper|testnet|sandbox|simulat[a-z]*|demo|mock|fake|back-?test[a-z]*|dry[-_ ]?run|test[-_ ]?net|virtual|play[-_ ]?money)([^a-z]|$)/i;

export function isSimulatedSource(text: unknown): boolean {
  return typeof text === "string" && SIMULATED.test(text);
}
