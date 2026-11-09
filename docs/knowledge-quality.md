# Trader knowledge: data quality

The elite-trader registry (`app/knowledge/`) is the single source of truth. The Worker serves it from
`worker/knowledge.generated.json`, which `scripts/build-knowledge.mjs` builds from the Python registry.

## What "complete" means

Each profile must cover 25 fields (biography, philosophy, entry/exit/stop/sizing rules, indicators, returns,
drawdowns, win rates, net worth, famous trades, predictions, strengths/weaknesses, lessons for ETI, and more).

`/api/intelligence/traders` reports `completeness` per profile:

| Key | Meaning |
| --- | --- |
| `fieldsPresent` | Fields holding real content (template filler does not count) |
| `fieldsStructural` | Fields holding any text at all |
| `placeholder` | Fields holding only template filler |
| `missing` | Fields that are empty |

`fieldsPresent + placeholder + missing = 25` for every profile.

`GET /api/intelligence/coverage` summarizes the registry: how many profiles are fully populated, which ones
still need work, net-worth status and freshness. If it reports `built-in-fallback`, the generated registry is
empty (usually Python missing at build time) and only the short built-in profiles are served.

## Evidence labels

Every return, drawdown, win-rate and net-worth note carries one label: `verified`, `reported`, `estimate`,
`speculation` or `not_documented`. Self-reported figures are labelled as such. Net-worth estimates must name a
dated source; `app/knowledge/research_2026.py` holds the dated overlay and the weekly refresh updates it.

## Adding or deepening a trader

1. Add a `TraderKnowledgeProfile` to a `profiles_deep*.py` file and load it in `registry.py` (later files win).
2. Fill all 25 fields with documented, high-level facts. Do not invent private strategies, win rates or returns.
3. Add the trader's id to exactly one of `NET_WORTH`, `DECEASED` or `NO_ESTIMATE` in `research_2026.py`
   (`tests/test_knowledge_research.py` enforces this).
4. Add the id to `DEEPENED_IDS` in `tests/test_knowledge_depth.py` and `worker/knowledge.test.ts`.
5. Run `npm test` (rebuilds the generated data first) and `pytest tests/test_knowledge*.py`.
