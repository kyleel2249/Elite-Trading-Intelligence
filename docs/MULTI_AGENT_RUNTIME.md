# ETI Multi-Agent Runtime

## Existing council

ETI already contains twelve structured specialist modules: Commander, Quantitative,
Technical, Fundamental, Macro, Crypto, News, Researcher, Risk, Execution, Auditor,
and Security. They exchange schema-validated reports through the council message bus.
The Commander consolidates directional evidence; the Risk Manager has a binding veto.
Decision snapshots are persisted to D1, with a compact KV fallback where configured.

The specialist modules are deterministic statistical and rule-based components. They
are not twelve independent language-model instances. An optional Anthropic-backed
briefing route provides advisory review; it does not control orders or override risk.

## Execution boundaries

The scheduled agent autopilot is restricted to ETI INTERNAL PAPER. It runs every five
minutes, applies council confidence and agreement gates, evaluates the FVG and strategy
consensus gates, and submits only through the existing order gateway. It does not submit
Bitget live orders.

The Bitget order gateway is a separate, fail-closed integration. It requires explicit
live enablement, verified Worker egress, server-side API credentials, an audit KV
binding, and an inactive kill switch. The agent council is not yet wired to that
gateway; the runtime endpoint reports this rather than implying that live agent
execution is active.

## Bitget data path

Bitget public market data is browser-direct because Bitget may block Cloudflare Worker
egress. The scheduled server-side autopilot cannot consume a browser-only feed. Its
market analysis uses the Worker provider order configured in wrangler.jsonc
(currently Bybit). Changing the Worker priority to Bitget without verified egress
would make scheduled analysis unreliable, so the configuration must remain honest.

## Runtime diagnostics

- GET /api/agents/runtime reports agent registration, deterministic/LLM modes,
  persistence bindings, market-data transport, autopilot mode and Bitget readiness.
- GET /api/agents includes the same runtime inventory for dashboard clients.
- No credentials, raw secret values, account balances or private exchange responses
  are returned by the runtime inventory.

## Safe progression to live Bitget execution

Before connecting the council to live Bitget orders, implement and verify a signed
server-side account/equity/positions loader, contract-specific quantity/price filters,
position-mode and margin-mode validation, idempotent order submission, order/fill
reconciliation, and protective-order verification. The agent route must pass its
own approved decision and the independent risk gate before calling the Bitget
gateway. If any of these checks fail, it must abstain. Live execution must remain
disabled until the complete path is tested against a non-live environment and
production egress is verified.
