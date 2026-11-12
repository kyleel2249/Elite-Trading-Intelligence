# LLM Evidence Reviewer (advisory)

`POST /api/agents/brief` (bearer token) runs the deterministic agent analysis and then asks an LLM to review it. It is **advisory only**: the model's output is returned beside the Commander decision and is never merged into it, never reaches the Risk Manager or the execution handlers, and the reviewer has no tools. It cannot place or change an order.

**What it returns** (schema-validated; anything else is rejected): a short summary, per-agent notes, contradictions between agents, weak or missing evidence, things to verify next, and an overall `evidenceStrength`.

**Safeguards**
* The analysis document is passed as untrusted data (headlines, event names and labels can contain injected text); the system prompt tells the model to ignore any instructions inside it and never to recommend buying or selling.
* Requests are bearer-authenticated and counted per hour in KV (`ETI_LLM_MAX_PER_HOUR`, default 20) before any call is made.
* Errors never echo the provider's response; the API key is only sent in the request header.

**Setup:** set the `ANTHROPIC_API_KEY` Worker secret. Optional `ETI_LLM_MODEL` (default `claude-sonnet-5-5`) and `ETI_LLM_MAX_PER_HOUR`. Without the key the endpoint answers `503 llm_not_configured`.

**Not built:** LLM-driven agent debate, LLM sentiment inside the News agent, historical-memory retrieval, and any LLM influence on decisions. Those need a design that keeps the deterministic Risk Manager as the final authority and a measured evaluation before the model is trusted with more than review.
