"""Guards .env.example, which operators copy verbatim to .env.

A duplicated key is a silent bug: the loader keeps the last value, so a later line quietly overrides an earlier one.
That once made a copied file start in APP_ENV=development, which opens the mutating routes when API_KEY is unset.
"""
from __future__ import annotations

import re
from collections import Counter
from pathlib import Path

ENV_EXAMPLE = Path(__file__).resolve().parents[1] / ".env.example"
ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def _assignments() -> list[tuple[str, str]]:
    out = []
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        m = ASSIGNMENT.match(line.strip())
        if m:  # commented-out examples (leading #) are documentation, not assignments
            out.append((m.group(1), m.group(2).strip()))
    return out


def test_no_duplicate_keys():
    counts = Counter(k for k, _ in _assignments())
    assert [k for k, n in counts.items() if n > 1] == []


def test_copied_file_defaults_to_fail_closed_production():
    assert dict(_assignments())["APP_ENV"] == "production"


def test_no_real_secret_values_committed():
    secret_name = re.compile(r"(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSPHRASE)$")  # suffixes only: TOKENOMIST_CREDIT_RESERVE is a number
    leaked = [k for k, v in _assignments() if secret_name.search(k) and v and not v.lower().startswith(("change-me", "your-"))]
    assert leaked == []
