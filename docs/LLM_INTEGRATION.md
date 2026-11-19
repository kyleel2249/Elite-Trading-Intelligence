# ETI LLM Evidence Reviewer

ETI's optional LLM integration is an **advisory evidence-review layer** over the deterministic 12-agent council. It receives a bounded, structured snapshot of a fresh ETI analysis and returns a schema-validated second opinion: summary, agent notes, contradictions, weak evidence, verification steps and evidence-strength label.

## Enable the integration

1. Create an Anthropic API key for the account that will pay for model usage.
2. Set the key as a Cloudflare Worker secret (do not put the key in Git, `wrangler.jsonc`, browser code or a public variable):

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   ```

3. Configure optional non-secret Worker variables as needed:

   ```sh
   npx wrangler secret put ETI_LLM_MODEL
   ```

   Prefer setting `ETI_LLM_MODEL` with `wrangler.jsonc` vars or the Cloudflare dashboard's Variables and Secrets UI (it is a non-secret setting). The default model is `claude-sonnet-5-5`; use a model ID enabled for the Anthropic API account.

4. Ensure the existing `ETI_EXECUTION_LOG` KV binding and `ETI_EXECUTION_TOKEN` secret are configured. KV is required for response caching, usage accounting and the hourly spend cap.
5. Deploy the Worker, open **AI Agents** at `/agents`, enter the execution/audit bearer token, then choose **Run LLM evidence review**. The **LLM usage** control reports the last seven days.

For local development, copy `.dev.vars.example` to `.dev.vars` and set the Anthropic key locally. Never commit `.dev.vars`.

## API

- `POST /api/agents/brief` — authenticated, metered fresh market analysis plus advisory LLM review. JSON body accepts `symbol`, `interval`, and optional `providers: false`.
- `GET /api/llm/usage` — authenticated seven-day usage and cache statistics.

Both endpoints require `Authorization: Bearer <ETI_EXECUTION_TOKEN>`. The review route also requires `ANTHROPIC_API_KEY`, the KV binding, and remaining hourly quota. The default hourly cap is 20; override with `ETI_LLM_MAX_PER_HOUR`. Input budget and cache TTL are controlled by `ETI_LLM_MAX_INPUT_TOKENS` and `ETI_LLM_CACHE_TTL`.

## Safety and operational behaviour

- The LLM has no tools and receives analysis as untrusted data. Prompt instructions explicitly prevent following instructions embedded in news/headlines or recommending trades.
- Its output is parsed against a strict schema; unknown agent IDs and unknown keys are discarded. Invalid output, provider errors and timeouts fail closed as an unavailable review.
- The LLM result is not merged into the Commander decision, Risk Manager, sizing, autopilot or execution ticket. It cannot create, modify or submit orders.
- Deterministic analysis remains available when the Anthropic key is absent or the provider is unavailable.
- Usage records and response cache are best-effort KV records; the hourly cap is the request-spend guard. KV does not provide atomic increments, so simultaneous requests can race. Use provider-side billing limits/alerts as an additional cost control.
- A configured API key alone does not prove the model is enabled, funded or reachable. Validate by running a live review and checking its response and usage record.

The LLM is not a source of guaranteed profitable trades. Evaluate any strategy using out-of-sample backtests and paper trading with realistic fees, slippage and funding before considering execution changes.
