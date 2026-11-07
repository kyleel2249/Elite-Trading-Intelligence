"""Test isolation: every run uses a fresh temporary database and paper-safe flags."""
import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="eti-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/eti-test.db"
os.environ.setdefault("LIVE_TRADING_ENABLED", "false")
os.environ.setdefault("BINANCE_LIVE_TRADING_ENABLED", "false")
os.environ.setdefault("ALPACA_PAPER", "true")
os.environ.setdefault("BINANCE_TESTNET_ENABLED", "true")
