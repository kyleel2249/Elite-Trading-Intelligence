from app.backtest.signals import vcp_signals, wyckoff_signals, breakout_signals


def test_vcp_runs():
    # contracting ranges then break
    closes = []
    px = 100.0
    for i in range(40):
        if i < 15:
            px += 1.0
        elif i < 30:
            px += 0.2 if i % 2 == 0 else -0.15
        else:
            px += 0.05 if i % 2 == 0 else -0.04
        closes.append(px)
    closes.append(max(closes) + 1)
    sig = vcp_signals(closes, lookback=30)
    assert len(sig) == len(closes)


def test_wyckoff_runs():
    closes = [100 + (i % 5) for i in range(50)]
    closes.append(90)
    closes.append(101)
    sig = wyckoff_signals(closes, lookback=40)
    assert len(sig) == len(closes)


def test_breakout_runs():
    closes = list(range(100, 130))
    sig = breakout_signals(closes, 10)
    assert any(s == 1 for s in sig)
