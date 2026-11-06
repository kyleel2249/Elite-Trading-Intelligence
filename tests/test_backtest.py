from app.backtest.engine import BacktestParams, run_backtest, walk_forward


def _klines(n=120):
    out = []
    px = 100.0
    for i in range(n):
        px *= 1.01 if i % 7 != 0 else 0.99
        out.append({"close": px})
    return out


def test_turtle_backtest_runs():
    res = run_backtest(_klines(), BacktestParams(module_id="turtle_trend", symbol="BTCUSDT"))
    assert res.bars > 50
    assert res.module_name
    assert "Helena Frost" in " ".join(res.notes) or res.notes


def test_walk_forward_folds():
    wf = walk_forward(_klines(150), BacktestParams(module_id="seykota_mechanical"), train_bars=60, test_bars=20)
    assert wf.module_id == "seykota_mechanical"
    assert isinstance(wf.folds, list)
