from app.intelligence.disclosure_learning import compute_forward_return


def test_forward_return():
    closes = [100.0, 101.0, 102.0, 110.0]
    r = compute_forward_return(closes, 0, 3)
    assert r is not None
    assert abs(r - 10.0) < 1e-6


def test_forward_return_insufficient():
    assert compute_forward_return([1.0, 2.0], 0, 5) is None
