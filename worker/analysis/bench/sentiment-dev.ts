// DEV sentiment set (tuning allowed). Originally written as a held-out set, but its items were studied while the v2 model's rules were designed, so it is
// CONTAMINATED for evaluation. The honest generalisation measure is sentiment-heldout.ts, written AFTER the model was frozen.
// The old lexicon scored 53.3% (32/60) on these rows, measured before any v2 work began.
// Label = likely direction of impact on the asset the headline concerns: p (positive), n (negative), 0 (neutral/uninformative).
// FX rows carry the currency whose perspective applies. These are hand-written headlines by the engine's author: a regression guard, NOT an independent evaluation.
export type Label = "p" | "n" | "0";
export interface Row { text: string; label: Label; cls: "equity" | "crypto" | "fx" | "macro"; ccy?: string }
const r = (cls: Row["cls"], label: Label, text: string, ccy?: string): Row => ({ text, label, cls, ccy });
export const DEV: Row[] = [
  r("equity", "p", "Apple posts record quarterly revenue, lifts dividend"), r("equity", "n", "Boeing shares tumble after regulator grounds 737 fleet"),
  r("equity", "n", "Tesla recalls 400,000 vehicles over braking software defect"), r("equity", "p", "Nvidia tops earnings estimates and guides above consensus"),
  r("equity", "n", "Retailer cuts full-year outlook as consumer spending softens"), r("equity", "p", "Pfizer wins FDA approval for new cancer therapy"),
  r("equity", "0", "Company announces CFO transition, no change to guidance"), r("equity", "n", "Bank discloses $2 billion loss tied to bad loans, shares slump"),
  r("equity", "0", "Microsoft to hold annual shareholder meeting on Dec. 10"), r("equity", "p", "Activist investor takes stake in struggling chipmaker, pushes for buyback"),
  r("equity", "n", "Regulators open probe into accounting practices at energy group"), r("equity", "p", "Airline raises profit forecast on strong summer travel demand"),
  r("equity", "n", "Merger talks collapse, target shares plunge 18%"), r("equity", "0", "Firm reports earnings roughly in line with analyst expectations"),
  r("equity", "p", "Semiconductor maker announces $10 billion share repurchase program"), r("equity", "n", "Auto supplier files for bankruptcy protection"),
  r("equity", "p", "Quarterly profit more than doubles as cloud demand accelerates"), r("equity", "n", "CEO resigns amid fraud allegations"),
  r("equity", "0", "Utility completes routine maintenance at nuclear plant"), r("equity", "n", "Grocer's same-store sales miss forecasts for third straight quarter"),
  r("crypto", "p", "SEC approves spot Ether ETF applications"), r("crypto", "n", "Major exchange halts withdrawals amid liquidity concerns"),
  r("crypto", "p", "Bitcoin hash rate hits all-time high"), r("crypto", "n", "Hackers drain $120 million from lending protocol"),
  r("crypto", "0", "Stablecoin issuer completes quarterly attestation"), r("crypto", "n", "Court rules against token issuer in unregistered securities case"),
  r("crypto", "p", "Large asset manager adds Bitcoin to treasury reserves"), r("crypto", "0", "Network upgrade scheduled for next month"),
  r("crypto", "n", "Token unlock of 15% of supply set for Friday"), r("crypto", "p", "Exchange lists new token, trading volume jumps"),
  r("crypto", "n", "Founder of DeFi project charged with market manipulation"), r("crypto", "n", "Layer-2 network suffers six-hour outage"),
  r("crypto", "p", "ETF inflows total $1.2 billion in a week"), r("crypto", "n", "Crypto lender files for Chapter 11"), r("crypto", "0", "Developers release routine security patch"),
  r("fx", "p", "Fed signals more rate hikes as inflation stays hot; dollar climbs", "USD"), r("fx", "n", "ECB cuts rates by 25 basis points; euro slides", "EUR"),
  r("fx", "p", "US payrolls beat forecasts, dollar rallies", "USD"), r("fx", "0", "Bank of Japan holds policy steady, yen little changed", "JPY"),
  r("fx", "n", "UK inflation falls more than expected, sterling drops on rate-cut bets", "GBP"), r("fx", "p", "Eurozone growth surprises to the upside, euro gains", "EUR"),
  r("fx", "n", "Australian unemployment jumps, Aussie dollar weakens", "AUD"), r("fx", "p", "Swiss franc strengthens as investors seek safety", "CHF"),
  r("fx", "0", "Central bank governor to speak at conference on Thursday", "USD"), r("fx", "n", "Canada's economy shrinks unexpectedly, loonie falls", "CAD"),
  r("equity", "p", "Shares rise despite weak earnings as outlook improves"), r("equity", "p", "Profit warning not as bad as feared; stock jumps"),
  r("equity", "p", "Probe ends with no charges against firm"), r("equity", "0", "Analysts say stock could surge if approval is granted"),
  r("crypto", "0", "Will bitcoin crash below $50,000?"), r("equity", "0", "Rumor: company may be acquired"),
  r("equity", "p", "Layoffs of 10% of workforce announced to cut costs; shares rise"), r("equity", "n", "Shares fall after company beats earnings estimates on weak guidance"),
  r("macro", "n", "Bond yields spike, equities sell off"), r("macro", "p", "Inflation cools to two-year low, stocks rally"),
  r("macro", "p", "Gold hits record high as geopolitical tensions escalate"), r("fx", "n", "Dollar index slips as traders bet on Fed cuts", "USD"),
  r("macro", "p", "Strong demand lifts copper to six-month high"), r("macro", "n", "Retail sales fall sharply in October, raising recession worries"),
  r("equity", "0", "Company to present at investor conference next week"),

  // extra dev rows with different wording and structures
  r("equity", "n", "Chipmaker warns of weak demand, cuts annual revenue guidance"), r("equity", "p", "Oil major lifts payout after profit tops forecasts"), r("equity", "n", "Insurer hit by $900 million catastrophe losses"),
  r("equity", "p", "Biotech stock soars after trial meets main goal"), r("equity", "0", "Retailer schedules earnings call for Nov. 18"), r("equity", "n", "Software firm slashes jobs as sales slow"),
  r("equity", "p", "Regulator clears merger, deal expected to close this quarter"), r("equity", "n", "Shares sink as CFO quits unexpectedly"), r("equity", "0", "Company says it may consider strategic options"),
  r("crypto", "p", "Bitcoin climbs as institutional buyers return"), r("crypto", "n", "Stablecoin loses peg after reserve doubts"), r("crypto", "n", "Exploit drains bridge, token plunges 30%"),
  r("crypto", "p", "Major bank launches crypto custody service"), r("crypto", "0", "Foundation publishes governance update"), r("crypto", "n", "Regulator sues exchange over unregistered trading"),
  r("fx", "p", "Pound rises after Bank of England signals higher rates", "GBP"), r("fx", "n", "Yen weakens as Bank of Japan keeps ultra-loose policy", "JPY"), r("fx", "p", "Dollar firms on hawkish Fed minutes", "USD"),
  r("fx", "n", "Euro slips as German factory output falls", "EUR"), r("fx", "0", "Swiss National Bank publishes quarterly bulletin", "CHF"), r("fx", "n", "Kiwi dollar tumbles after rate cut", "NZD"),
  r("macro", "n", "Jobless claims jump to highest level in a year"), r("macro", "p", "Unemployment falls to lowest since 2019"), r("macro", "n", "Oil slumps on demand worries"),
  r("macro", "p", "Consumer confidence improves for third month"), r("macro", "n", "Mortgage rates surge to 20-year high"), r("macro", "p", "Housing starts beat expectations"),
];
