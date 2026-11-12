"""Analytics API: scanning, ranking, regime, risk simulation, walk-forward, reporting and research.

Compute endpoints are stateless and work on supplied data or on candles fetched server-side through
``MarketService``. Nothing here places orders; execution stays behind the in-process RiskEngine.
"""
import asyncio
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.analytics import correlation, detectors, montecarlo, regime, reporting, research, stats, stress, walkforward
from app.config import Settings, get_settings
from app.market.service import MarketService

logger = logging.getLogger("eti.api.analytics")
router = APIRouter(prefix="/api/analytics", tags=["analytics"])

_INTERVAL = r"^[0-9]{1,2}[smhdwM]$"
MAX_SYMBOLS = 20
MAX_MC_STEPS = 2_000_000   # paths x horizon; keeps one request to a couple of seconds of CPU
MAX_GRID = 60              # walk-forward parameter combinations accepted over the API


async def _candles(settings: Settings, provider: str, symbol: str, interval: str, limit: int) -> list[dict[str, Any]]:
    try:
        return await MarketService(settings).get_history(provider, symbol, interval=interval, limit=limit)
    except Exception:
        logger.warning("candle fetch failed for %s %s", provider, symbol, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Market data for {symbol} failed upstream")


async def _candles_many(settings: Settings, provider: str, symbols: list[str], interval: str, limit: int) -> tuple[dict[str, list], dict[str, str]]:
    res = await asyncio.gather(*(MarketService(settings).get_history(provider, s, interval=interval, limit=limit) for s in symbols),
                               return_exceptions=True)
    ok, failed = {}, {}
    for s, r in zip(symbols, res):
        if isinstance(r, Exception):
            logger.warning("candle fetch failed for %s %s: %s", provider, s, type(r).__name__)
            failed[s] = "market data unavailable"
        else:
            ok[s] = r
    return ok, failed


def _symbols(csv: str) -> list[str]:
    out = list(dict.fromkeys(s.strip().upper() for s in csv.split(",") if s.strip()))
    if not out or len(out) > MAX_SYMBOLS:
        raise HTTPException(status_code=422, detail=f"provide 1-{MAX_SYMBOLS} comma-separated symbols")
    return out


def _value_error(e: ValueError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(e))


@router.get("/regime")
async def regime_endpoint(symbol: str = "BTCUSDT", provider: str = "binance", interval: str = Query("1h", pattern=_INTERVAL),
                          limit: int = Query(300, ge=60, le=1000), settings: Settings = Depends(get_settings)):
    return {"symbol": symbol.upper(), **regime.detect_regime(await _candles(settings, provider, symbol, interval, limit))}


@router.get("/unusual-volume")
async def unusual_volume_endpoint(symbol: str = "BTCUSDT", provider: str = "binance", interval: str = Query("1h", pattern=_INTERVAL),
                                  limit: int = Query(100, ge=30, le=1000), settings: Settings = Depends(get_settings)):
    return {"symbol": symbol.upper(), **detectors.unusual_volume(await _candles(settings, provider, symbol, interval, limit))}


@router.get("/volatility-breakout")
async def volatility_breakout_endpoint(symbol: str = "BTCUSDT", provider: str = "binance", interval: str = Query("1h", pattern=_INTERVAL),
                                       limit: int = Query(200, ge=60, le=1000), settings: Settings = Depends(get_settings)):
    return {"symbol": symbol.upper(), **detectors.volatility_breakout(await _candles(settings, provider, symbol, interval, limit))}


@router.get("/scan")
async def scan_endpoint(symbols: str = "BTCUSDT,ETHUSDT,SOLUSDT", provider: str = "binance",
                        interval: str = Query("1h", pattern=_INTERVAL), limit: int = Query(200, ge=60, le=1000),
                        settings: Settings = Depends(get_settings)):
    """Multi-symbol scan -> ranked opportunities -> generated watchlist. Failed symbols are reported, never faked."""
    syms = _symbols(symbols)
    data, failed = await _candles_many(settings, provider, syms, interval, limit)
    scans = [research.scan_symbol(s, k) for s, k in data.items()]
    ranked = research.rank_opportunities(scans)
    return {"provider": provider, "interval": interval, "scanned": len(scans), "failed": failed, "scans": scans,
            "ranked": ranked, "watchlist": research.build_watchlist(ranked),
            "notes": ["Scores rank where to look first; they are not probabilities and not trade signals."]}


@router.get("/correlation")
async def correlation_endpoint(symbols: str = "BTCUSDT,ETHUSDT,SOLUSDT", provider: str = "binance",
                               interval: str = Query("1d", pattern=_INTERVAL), limit: int = Query(200, ge=40, le=1000),
                               settings: Settings = Depends(get_settings)):
    syms = _symbols(symbols)
    if len(syms) < 2:
        raise HTTPException(status_code=422, detail="at least 2 symbols required")
    data, failed = await _candles_many(settings, provider, syms, interval, limit)
    out = correlation.correlation_matrix({s: stats.closes_of(k) for s, k in data.items()}) if len(data) >= 2 else {"status": "insufficient_data"}
    return {**out, "failed": failed}


@router.get("/monte-carlo")
async def monte_carlo_endpoint(symbol: str = "BTCUSDT", provider: str = "binance", interval: str = Query("1d", pattern=_INTERVAL),
                               limit: int = Query(365, ge=60, le=1000), horizon: int = Query(90, ge=1, le=2000),
                               paths: int = Query(2000, ge=100, le=10000), block_size: int = Query(5, ge=1, le=50),
                               seed: Optional[int] = 42, settings: Settings = Depends(get_settings)):
    if paths * horizon > MAX_MC_STEPS:
        raise HTTPException(status_code=422, detail=f"paths x horizon must be <= {MAX_MC_STEPS}")
    rets = stats.pct_returns(stats.closes_of(await _candles(settings, provider, symbol, interval, limit)))
    try:
        res = await asyncio.to_thread(montecarlo.monte_carlo, rets, horizon=horizon, n_paths=paths, block_size=block_size, seed=seed)
        return {"symbol": symbol.upper(), **res}
    except ValueError as e:
        raise _value_error(e)


class Position(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=32)
    market_value: float = Field(..., allow_inf_nan=False)
    asset_class: Literal["stock", "index", "crypto", "commodity", "forex", "metal", "cash"] = "stock"


class StressRequest(BaseModel):
    positions: list[Position] = Field(..., min_length=1, max_length=500)
    scenarios: Optional[dict[str, dict[str, float]]] = None


class ScenarioItem(BaseModel):
    name: str
    probability: float = Field(..., ge=0, le=1)
    shocks: dict[str, float]


class ScenarioRequest(BaseModel):
    positions: list[Position] = Field(..., min_length=1, max_length=500)
    scenarios: list[ScenarioItem] = Field(..., min_length=1, max_length=50)


@router.get("/stress/scenarios")
async def stress_catalog():
    return {"hypothetical_scenarios": stress.HYPOTHETICAL_SCENARIOS, "note": "Hypothetical shocks, not historical events."}


@router.post("/stress")
async def stress_endpoint(body: StressRequest):
    return stress.stress_test([p.model_dump() for p in body.positions], body.scenarios)


@router.post("/scenario")
async def scenario_endpoint(body: ScenarioRequest):
    try:
        return stress.scenario_analysis([p.model_dump() for p in body.positions], [s.model_dump() for s in body.scenarios])
    except ValueError as e:
        raise _value_error(e)


class WalkForwardRequest(BaseModel):
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    interval: str = Field("1h", pattern=_INTERVAL)
    limit: int = Field(1000, ge=200, le=1000)
    strategy: Literal["sma_cross", "channel_breakout"] = "sma_cross"
    grid: dict[str, list[int]] = Field(default_factory=lambda: {"fast": [5, 10, 20], "slow": [30, 50, 100]})
    train_bars: int = Field(300, ge=50, le=900)
    test_bars: int = Field(100, ge=10, le=500)
    fee_bps: float = Field(5.0, ge=0, le=500)


class CompareRequest(BaseModel):
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    interval: str = Field("1h", pattern=_INTERVAL)
    limit: int = Field(500, ge=100, le=1000)
    candidates: list[dict[str, Any]] = Field(..., min_length=1, max_length=20)
    fee_bps: float = Field(5.0, ge=0, le=500)


@router.post("/walk-forward")
async def walk_forward_endpoint(body: WalkForwardRequest, settings: Settings = Depends(get_settings)):
    combos = 1
    for values in body.grid.values():
        combos *= max(len(values), 1)
    if combos > MAX_GRID:
        raise HTTPException(status_code=422, detail=f"parameter grid must have at most {MAX_GRID} combinations (got {combos})")
    closes = stats.closes_of(await _candles(settings, body.provider, body.symbol, body.interval, body.limit))
    try:
        res = await asyncio.to_thread(walkforward.walk_forward, closes, body.strategy, body.grid, body.train_bars, body.test_bars, body.fee_bps)
        return {"symbol": body.symbol.upper(), **res}
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=422, detail=f"invalid walk-forward request: {e}")


@router.post("/strategy-lab/compare")
async def compare_endpoint(body: CompareRequest, settings: Settings = Depends(get_settings)):
    closes = stats.closes_of(await _candles(settings, body.provider, body.symbol, body.interval, body.limit))
    try:
        res = await asyncio.to_thread(walkforward.compare_strategies, closes, body.candidates, body.fee_bps)
        return {"symbol": body.symbol.upper(), **res}
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(status_code=422, detail=f"invalid candidate: {e}")


class TaxRequest(BaseModel):
    transactions: list[dict[str, Any]] = Field(..., min_length=1, max_length=20000)
    method: Literal["FIFO", "LIFO", "HIFO"] = "FIFO"
    csv: bool = False


@router.post("/tax/realized-gains")
async def tax_endpoint(body: TaxRequest):
    try:
        res = reporting.realized_gains(body.transactions, body.method)
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=422, detail=f"invalid transaction data: {e}")
    if body.csv:
        res["csv"] = reporting.transactions_csv(res["rows"])
    return res


class FxRequest(BaseModel):
    holdings: list[dict[str, Any]] = Field(..., min_length=1, max_length=5000)
    base_currency: str = Field(..., min_length=3, max_length=3)
    fx_rates: dict[str, float]


@router.post("/portfolio/multi-currency")
async def fx_endpoint(body: FxRequest):
    try:
        return reporting.convert_portfolio(body.holdings, body.base_currency, body.fx_rates)
    except (ValueError, KeyError) as e:
        raise HTTPException(status_code=422, detail=f"invalid holdings: {e}")


class LiveVsBacktestRequest(BaseModel):
    live_returns: list[float] = Field(..., max_length=100000)
    backtest_returns: list[float] = Field(..., max_length=100000)


@router.post("/live-vs-backtest")
async def live_vs_backtest_endpoint(body: LiveVsBacktestRequest):
    return reporting.live_vs_backtest(body.live_returns, body.backtest_returns)


class RiskAlertRequest(BaseModel):
    snapshot: dict[str, Any]
    limits: Optional[dict[str, float]] = None


@router.post("/risk-alerts")
async def risk_alerts_endpoint(body: RiskAlertRequest):
    try:
        return {"alerts": research.risk_alerts(body.snapshot, body.limits)}
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(status_code=422, detail=f"invalid snapshot: {e}")


class ResearchRequest(BaseModel):
    asset: str = Field(..., min_length=1, max_length=40)
    asset_class: Literal["stock", "crypto", "commodity", "currency"]
    evidence: dict[str, Any] = Field(default_factory=dict)
    provider: str = "binance"
    symbol: Optional[str] = None
    interval: str = Field("1d", pattern=_INTERVAL)


@router.post("/research")
async def research_endpoint(body: ResearchRequest, settings: Settings = Depends(get_settings)):
    klines = None
    if body.symbol:
        klines = await _candles(settings, body.provider, body.symbol, body.interval, 300)
    return research.research_dossier(body.asset, body.asset_class, body.evidence, klines)


class QueryRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=500)


@router.post("/query")
async def nlq_endpoint(body: QueryRequest):
    try:
        return research.parse_query(body.text)
    except ValueError as e:
        raise _value_error(e)


from app.api.intel import router as intel_router  # noqa: E402  (mounted at /api/analytics/intel)

router.include_router(intel_router)
