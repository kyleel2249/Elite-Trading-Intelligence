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

import pytest
from app.backtest import engine, runner


def _bars(prices):
    return [{"close": price} for price in prices]


def _fixed_signals(monkeypatch, signals):
    monkeypatch.setattr(engine, "_signals_for_module", lambda *args: (signals, "test", []))


def test_signals_fill_at_next_close_not_signal_close(monkeypatch):
    _fixed_signals(monkeypatch, [1, 0, -1, 0])
    res = run_backtest(_bars([10, 100, 200, 50]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=0))
    # Buy 100 at index 1, sell 50 at index 3, not buy 10 / sell 200.
    assert res.total_return_pct == -50
    assert res.trades == 1
    assert res.win_rate == 0


def test_final_signal_cannot_execute_without_next_bar(monkeypatch):
    _fixed_signals(monkeypatch, [0, 0, 1])
    res = run_backtest(_bars([10, 20, 30]), BacktestParams("turtle_trend"))
    assert res.trades == 0
    assert res.total_return_pct == 0
    assert res.win_rate is None


def test_open_loss_marks_equity_and_drawdown_before_recovery(monkeypatch):
    _fixed_signals(monkeypatch, [1, 0, 0, 0])
    res = run_backtest(_bars([100, 100, 50, 100]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=0))
    assert res.equity_curve == [10000, 10000, 10000, 5000, 10000]
    assert res.max_drawdown_pct == 50
    assert res.total_return_pct == 0
    assert res.trades == 1  # forced final liquidation closes the trade


def test_allocation_has_no_ten_times_multiplier(monkeypatch):
    _fixed_signals(monkeypatch, [1, 0, 0])
    res = run_backtest(_bars([100, 100, 200]), BacktestParams("turtle_trend", risk_per_trade_pct=1, fee_bps=0))
    assert res.total_return_pct == 1
    assert res.equity_curve[-1] == 10100


def test_final_liquidation_includes_both_fees_and_closed_win_denominator(monkeypatch):
    _fixed_signals(monkeypatch, [1, -1, 1, 0, 0])
    res = run_backtest(_bars([100, 100, 200, 100, 100]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=100))
    expected = 10000 * (200 * .99 / (100 * 1.01)) * (.99 / 1.01)
    assert res.equity_curve[-1] == pytest.approx(expected)
    assert res.trades == 2
    assert res.win_rate == .5


def test_warmup_bars_do_not_score_or_hold_positions(monkeypatch):
    _fixed_signals(monkeypatch, [1, 0, 0, 0, 0])
    res = run_backtest(_bars([100, 100, 200, 400, 800]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=0), scoring_start_index=3)
    assert res.bars == 2
    assert res.trades == 0
    assert res.equity_curve == [10000, 10000, 10000]
    assert res.total_return_pct == 0


def test_first_test_bar_can_execute_last_training_signal(monkeypatch):
    _fixed_signals(monkeypatch, [0, 1, 0, 0])
    res = run_backtest(_bars([1, 1, 100, 110]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=0), scoring_start_index=2)
    assert res.total_return_pct == 10
    assert res.trades == 1


def test_walk_forward_test_only_and_compounds(monkeypatch):
    # Training prices rise enormously but must not affect test returns.
    _fixed_signals(monkeypatch, [0, 1, 0, 0])
    wf = walk_forward(_bars([1, 10, 100, 110, 200, 220]), BacktestParams("turtle_trend", risk_per_trade_pct=100, fee_bps=0), train_bars=2, test_bars=2)
    assert [f["return_pct"] for f in wf.folds] == [10, 10]
    assert [(f["start_index"], f["end_index"]) for f in wf.folds] == [(2, 4), (4, 6)]
    assert wf.aggregate_return_pct == 21


@pytest.mark.parametrize("field,value", [("lookback", 0), ("lookback", -1), ("lookback", 1.5), ("lookback", True), ("fee_bps", -1), ("fee_bps", 10000), ("fee_bps", float("nan")), ("fee_bps", float("inf")), ("risk_per_trade_pct", 0), ("risk_per_trade_pct", 101), ("risk_per_trade_pct", float("inf"))])
def test_invalid_params_rejected(field, value):
    params = BacktestParams("turtle_trend", **{field: value})
    with pytest.raises(ValueError):
        run_backtest(_klines(), params)
    with pytest.raises(ValueError):
        walk_forward(_klines(), params)


@pytest.mark.parametrize("field,value", [("test_bars", 0), ("test_bars", -1), ("test_bars", 1.5), ("test_bars", True), ("train_bars", 0), ("train_bars", float("inf"))])
def test_invalid_fold_lengths_rejected(field, value):
    with pytest.raises(ValueError):
        walk_forward(_klines(), BacktestParams("turtle_trend"), **{field: value})


@pytest.mark.parametrize("bars", [[], [{}], [{"close": None}], _bars([0]), _bars([-1]), _bars([float("nan")]), _bars([float("inf")]), [{"close": 1, "volume": float("nan")}], [{"close": 1, "volume": 3}, {"close": 2}]])
def test_invalid_bars_rejected(bars):
    with pytest.raises(ValueError):
        run_backtest(bars, BacktestParams("turtle_trend"))


@pytest.mark.parametrize("start", [-1, 2, 1.5, True])
def test_invalid_scoring_start_rejected(start):
    with pytest.raises(ValueError):
        run_backtest(_bars([1, 2]), BacktestParams("turtle_trend"), scoring_start_index=start)


def test_vcp_volume_forwarded_in_engine_and_runner(monkeypatch):
    calls = []
    def capture(closes, lookback=30, volumes=None):
        calls.append((closes, lookback, volumes))
        return [0] * (len(closes) - 1) + [1]
    monkeypatch.setattr(engine, "vcp_signals", capture)
    monkeypatch.setattr(runner, "vcp_signals", capture)
    bars = [{"close": 100 + i, "volume": i + 1} for i in range(40)]
    run_backtest(bars, BacktestParams("minervini_vcp"))
    instance = runner.StrategyRunner.__new__(runner.StrategyRunner)
    assert instance._latest_signal("minervini_vcp", [b["close"] for b in bars], [b["volume"] for b in bars]) == "long"
    assert len(calls) == 2
    assert all(call[2] == list(range(1, 41)) for call in calls)
