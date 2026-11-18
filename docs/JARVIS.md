# JARVIS — ETI Agent Intelligence Layer

JARVIS is the authenticated command and orchestration layer over ETI's existing twelve-agent council. It does not replace agents or make itself a directional voter. It delegates to the existing Commander, analysts, Risk Manager, Security Analyst, Execution Specialist and Performance Auditor.

## Institutional JARVIS Command Centre

Open `/jarvis` for the integrated institutional trading workspace. It uses the existing authenticated JARVIS API and live ETI agent, runtime, autopilot, provider, audit and memory endpoints; it does not create a parallel market-data or execution service. The dashboard includes a natural-language command console, live agent roster, Commander decision and dissent view, Risk Manager and security status, provider health, autopilot readiness, performance audit and bounded operational memory. Its bearer token is held in tab-scoped `sessionStorage` only and is cleared when the tab session ends or the operator clears it. The screen is read-only: it cannot submit, prepare or approve orders.

## API

All endpoints require the existing ETI execution bearer token. Do not send exchange API keys to JARVIS.

- `GET /api/agents/jarvis` — capability and safety status.
- `POST /api/agents/jarvis` — natural-language command.
- `GET /api/agents/jarvis/memory` — recent operational command summaries.

Example:

```sh
curl -X POST https://<your-worker>/api/agents/jarvis \
  -H "Authorization: Bearer $ETI_EXECUTION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Analyse BTCUSDT on 15m"}'
```

Supported command classes:

- Market analysis: `Analyse ETHUSDT on 1h`
- System awareness: `Check system status and autopilot`
- Performance: `Show performance audit`
- Explicit advisory review: `Run a deep review on BTCUSDT 4h`

The deep-review command calls ETI's existing advisory LLM review endpoint. It is optional, requires `ANTHROPIC_API_KEY`, consumes the existing hourly usage allowance, and cannot alter the deterministic decision.

## Advanced capabilities

- **Council orchestration:** routes analysis through the existing agents and returns their individual reports, consensus, dissent, risk checks, security flags and data-quality status.
- **Situational awareness:** combines agent runtime, roster and autopilot readiness into one system-status response.
- **Operational memory:** stores at most 20 command summaries for 30 days in the existing KV namespace. It does not store raw prompts, credentials, API keys, balances or exchange secrets.
- **Performance feedback:** retrieves the existing auditor's measured outcomes and agent-accuracy summary.
- **Advisory reasoning:** can request the existing LLM reviewer only when explicitly asked; its output remains advisory.
- **Tool allow-list:** JARVIS exposes only analysis, status, audit, advisory review and help through this route.

## Safety model

- JARVIS analysis is read-only. This route does not call the order endpoint.
- JARVIS cannot prepare or submit an order, change a decision, or override the Commander or Risk Manager.
- The Risk Manager's veto remains binding; security failures continue to fail closed.
- Live execution remains disabled in the multi-agent system.
- Bearer authentication is required; exchange credentials must remain in server-side secret storage and are never accepted in JARVIS command bodies.
- Missing market/provider inputs remain explicit; JARVIS does not fabricate news, macro, fundamentals or on-chain data.

## Current boundaries

This first integration provides authenticated text-command orchestration and bounded operational memory. Voice wake-word support, speech synthesis, live visual/screen understanding, multi-user identity-scoped memory and autonomous external-app control are not enabled by this change. Real-time market feeds and scheduled paper autopilot remain owned by their existing ETI services.
