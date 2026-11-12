"""ETI persistent memory & learning system.

Durable, structured memory for trader profiles, documented methodologies, market
observations, strategy configurations (versioned), backtests, signals, signal outcomes,
executed trades, market conditions, prediction accuracy, preferences, risk limits,
strategy failures and lessons learned.

This package is intentionally import-light: heavy submodules are imported explicitly by
their users so that importing ``app.memory.models`` never pulls in the trading stack.

Governance (enforced in code, covered by tests):
- The learning pipeline never activates, edits or replaces a validated strategy. It can only
  create *proposed*, risk-reducing versions that a human must validate and approve.
- Original analysis is immutable and hash-verified when a trade closes.
- Train / validation / live evaluation data are kept apart and audited for look-ahead,
  survivorship and leakage problems.
"""

MEMORY_SCHEMA_VERSION = 1
