# Infrastructure: token management, Redis, task queue, models, 3D view

What was built, what it is verified against, and what it is not.

## LLM token management (`worker/llm/`, used by `worker/agents/llm.ts`)
The only LLM call is the advisory Evidence Reviewer (`POST /api/agents/brief`). Around it:

* **Versioned prompt templates** (`templates.ts`): a global security policy plus a per-role contract, rendered and compressed losslessly (whitespace, exact duplicate sentences). Rendering **proves every critical instruction survived** (untrusted-data rule, no orders, no invented numbers, JSON-only contract, encoding legend) and falls back to the uncompressed text if one is missing. The version string is part of the cache key and of the usage records.
* **Document compaction** (`compress.ts`): omits null/empty values, trims floats to 7 significant digits and replaces repeated long strings with `§n` references listed once under `$d`. The system prompt tells the model how to read it. `expandJson` reverses it exactly, and tests assert the round trip equals the original except for the documented empties and float trimming. A document that already contains `§` or `$d` is never rewritten.
* **Context selection** (`selectContext`): three tiers (full, no evidence, lean). The fullest tier that fits `ETI_LLM_MAX_INPUT_TOKENS` (default 8000) is sent; nothing is trimmed unless the budget forces it, and every agent stays represented even in the leanest tier.
* **Provider prompt caching:** the system block is sent with `cache_control: ephemeral`. The provider applies it only above its minimum cacheable size and reports `cache_read_input_tokens` / `cache_creation_input_tokens`, which are recorded as-is.
* **Response cache** (KV, `ETI_LLM_CACHE_TTL`, default 900 s): an unchanged analysis (same model, prompt version and content, ignoring timestamps and ids) is answered without a second API call.
* **Usage tracking:** `GET /api/llm/usage` (bearer) returns seven days of calls, cache hits, estimated tokens before/after compression, and the provider's actual input/output/cache tokens. KV has no atomic increment, so these are for cost visibility, not enforcement; the hourly cap remains the guard.

**Measured:** on a real 12-agent analysis the prompt compression alone saves about 5.6% of estimated input tokens (2712 to 2561). The large saving is the response cache: a repeated review costs zero tokens. Token counts are heuristic estimates (no tokenizer in a Worker); the provider's `usage` block is the truth and is recorded next to them. Accuracy is protected by construction: no instruction is removed, and evidence is trimmed only when the budget is exceeded.

Not applicable here: conversation summarisation (there are no multi-turn LLM conversations) and cross-agent prompt de-duplication (there is one LLM caller).

## Redis, cache, locks, rate limits (`app/infra/`)
`redis_client.py` is a dependency-free RESP2 client (the `redis` package cannot be installed here). `cache.py` adds a JSON cache that degrades to "miss" on outage, token-checked distributed locks, and a fixed-window rate limiter (fail-open). Set `REDIS_URL` to enable; nothing changes when it is blank. Tests run against a real `redis-server` started on a free port.

## Task queue (`app/infra/taskqueue.py`, `app/tasks/`)
Celery-style semantics without the Celery package: `@task`, `.delay()`, `countdown`/`eta`, retries with exponential backoff, dead-letter list, stored results, crash recovery of messages whose worker died, and a `Beat` scheduler (one enqueue per period even with several schedulers). **At-least-once delivery: tasks must be idempotent.** Run a worker with `REDIS_URL=redis://host:6379/0 python -m app.infra.worker --queues default --beat`; `docker compose --profile queue up` starts Redis and a worker. Tasks: `research.forecast`, `research.vector_index` (serialised by a Redis lock), `system.ping`.

## Models and vector storage (`app/research/`)
* `neural.py`: a numpy MLP forecaster (PyTorch is not installable here), backprop verified against finite differences, judged by the same leak-free walk-forward MASE as every other model. On a random walk it correctly shows no edge. Opt in with `forecast(..., models=with_neural())` or `neural=True` on the task.
* `vector_store.py`: durable vector database on SQLite (WAL, transactional batch insert, multi-process safe) with the same interface as `VectorMemory`. Exact cosine search; suited to up to a few hundred thousand notes. pgvector/Qdrant are not included (no server available to verify against).

## 3D depth surface (`worker/viz3d/`)
A raw-WebGL surface of cumulative order-book depth over time (bids green, asks red), rotate/zoom by mouse, touch or keyboard, with a clear message when WebGL is unavailable. It replaces React Three Fiber for this one view; no build step.

## Not built
* **Next.js / React / Tailwind frontend:** needs `npm install` and a build, which this environment cannot do; code that cannot be compiled or run here would be unverified. The Worker-served dashboard remains the UI.
* **docker-compose queue profile:** written but not run here (no Docker); the worker command itself is tested as a subprocess against a real Redis.
* **Celery, PyTorch, pgvector** as packages/servers, for the same reason; the equivalents above are tested substitutes, not those products.
