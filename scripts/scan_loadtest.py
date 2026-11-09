"""Real-provider scan benchmark. Run from the repo root:

    python scripts/scan_loadtest.py --top 1000 [--equities AAPL,MSFT,...]

It scans live Binance (public, no key) and optionally Alpaca (needs keys in .env), then prints the
measured duration, completion, staleness and per-provider request counts. Nothing here is simulated;
the numbers are only meaningful for the machine/network/universe you run it on. Binance spot has
roughly 400-700 liquid USDT pairs, so a 1,000-2,000 universe requires adding equities/other providers.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.quant.providers import AlpacaSnapshotProvider, BinanceBulkProvider, build_equity_universe  # noqa: E402
from app.quant.scanner import GlobalScanner  # noqa: E402


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=1000)
    ap.add_argument("--equities", default="")
    ap.add_argument("--runs", type=int, default=2)
    a = ap.parse_args()
    s = get_settings()
    sc = GlobalScanner({"binance": BinanceBulkProvider(), "alpaca": AlpacaSnapshotProvider(s)},
                       max_age_seconds=s.data_max_age_seconds, interval_seconds=s.scan_interval_seconds)
    entries = await sc.providers["binance"].load_universe(limit=a.top)
    if a.equities:
        entries += build_equity_universe(a.equities.split(","))
    sc.set_universe(entries)
    print(f"universe: {len(entries)} instruments")
    for i in range(a.runs):
        m = await sc.scan_once()
        print(f"run {i + 1}: {json.dumps(m.to_dict(), indent=2)}")
    print("provider health:", json.dumps(sc.provider_health, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
