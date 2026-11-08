"""Test isolation: every run uses a fresh temporary database and paper-safe flags."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

# Ensure repo root is on sys.path so `import app` works under pytest/CI
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_tmp = tempfile.mkdtemp(prefix="eti-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/eti-test.db"
os.environ["LIVE_TRADING_ENABLED"] = "false"
os.environ["BINANCE_LIVE_TRADING_ENABLED"] = "false"
os.environ["ALPACA_PAPER"] = "true"
os.environ["BINANCE_TESTNET_ENABLED"] = "true"
