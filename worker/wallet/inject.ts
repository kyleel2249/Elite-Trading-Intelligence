import { WALLET_CSS, WALLET_HTML, WALLET_JS } from "../portfolio/wallet-ui.ts";

const GRID_MARKER = '<div class="grid"><section class="panel"><h2>Live Market Chart';
const NAV_MARKER = '<a href="/alpha" style="color:var(--blue)">';

/**
 * Adds the Wallet section, its styles, script and a header link to the dashboard HTML. Never throws: when the dashboard
 * markup no longer contains the expected markers, the section is placed before the Portfolio panel or at the top of <main>.
 */
export function injectWallet(html: string): string {
  if (html.includes('id="walletPanel"')) return html;
  let out = html;
  if (out.includes(GRID_MARKER)) out = out.replace(GRID_MARKER, () => WALLET_HTML + "\n" + GRID_MARKER);
  else if (out.includes('<section class="panel pf" id="portfolioPanel"')) out = out.replace('<section class="panel pf" id="portfolioPanel"', () => WALLET_HTML + '\n<section class="panel pf" id="portfolioPanel"');
  else if (out.includes("<main>")) out = out.replace("<main>", () => "<main>\n" + WALLET_HTML);
  else return html;
  out = out.includes("</style>") ? out.replace("</style>", () => WALLET_CSS + "\n</style>") : out;
  if (out.includes(NAV_MARKER)) out = out.replace(NAV_MARKER, () => '<a href="#walletPanel" style="color:var(--blue)">Wallet</a>' + NAV_MARKER);
  const script = "<script>" + WALLET_JS + "\nwalletInit();</script>";
  return out.includes("</body>") ? out.replace("</body>", () => script + "\n</body>") : out + script;
}
