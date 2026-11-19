"""Local Windows MetaTrader 5 bridge for ETI.

The bridge binds only to loopback. Broker credentials are accepted only by
/login, passed directly to the local MT5 terminal, and never logged or saved.
Live order placement is disabled unless ETI_MT5_LIVE_TRADING=true is set.
"""
from __future__ import annotations

import hmac
import os
import secrets
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, SecretStr, field_validator

APP = FastAPI(title="ETI MT5 Local Bridge", version="1.0.0")
APP.add_middleware(
    CORSMiddleware,
    allow_origins=["https://elite-trading-intelligence-eti.workers.dev", "https://eti.cintexa.com"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)
_LOCK = threading.RLock()
_MT5: Any = None
_SESSION_TOKEN = os.environ.get("ETI_MT5_BRIDGE_TOKEN") or secrets.token_urlsafe(32)
_LIVE_ENABLED = os.environ.get("ETI_MT5_LIVE_TRADING", "false").lower() == "true"
_MAX_RISK_PERCENT = float(os.environ.get("ETI_MT5_MAX_RISK_PERCENT", "1.0"))
_CONNECTED = False
_ACCOUNT_LOGIN: Optional[int] = None


def mt5() -> Any:
    global _MT5
    if _MT5 is None:
        try:
            import MetaTrader5 as package
        except ImportError as exc:
            raise HTTPException(503, "MetaTrader5 Python package is not installed. Run install.ps1 on Windows.") from exc
        _MT5 = package
    return _MT5


def auth(authorization: Optional[str] = Header(default=None)) -> None:
    supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied, _SESSION_TOKEN):
        raise HTTPException(401, "Bridge authentication required")


def connected() -> Any:
    if not _CONNECTED:
        raise HTTPException(409, "No MT5 account is connected")
    return mt5()


def plain(value: Any) -> Any:
    if hasattr(value, "_asdict"):
        return {k: plain(v) for k, v in value._asdict().items()}
    if isinstance(value, (tuple, list)):
        return [plain(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


class LoginRequest(BaseModel):
    login: int = Field(gt=0)
    password: SecretStr
    server: str = Field(min_length=1, max_length=128)
    terminal_path: Optional[str] = Field(default=None, max_length=500)


class OrderRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    side: str
    volume: float = Field(gt=0)
    order_type: str = "market"
    price: Optional[float] = Field(default=None, gt=0)
    sl: Optional[float] = Field(default=None, gt=0)
    tp: Optional[float] = Field(default=None, gt=0)
    deviation: int = Field(default=20, ge=0, le=500)
    comment: str = Field(default="ETI", max_length=24)

    @field_validator("side")
    @classmethod
    def valid_side(cls, value: str) -> str:
        if value.lower() not in {"buy", "sell"}:
            raise ValueError("side must be buy or sell")
        return value.lower()

    @field_validator("order_type")
    @classmethod
    def valid_type(cls, value: str) -> str:
        if value.lower() not in {"market", "buy_limit", "sell_limit", "buy_stop", "sell_stop"}:
            raise ValueError("unsupported order type")
        return value.lower()


class CloseRequest(BaseModel):
    ticket: int = Field(gt=0)
    volume: Optional[float] = Field(default=None, gt=0)


@APP.get("/health")
def health() -> dict:
    return {"service": "ETI MT5 Bridge", "status": "ok", "connected": _CONNECTED,
            "live_trading_enabled": _LIVE_ENABLED, "host_scope": "loopback-only"}


@APP.get("/bootstrap")
def bootstrap(_: None = Depends(auth)) -> dict:
    # Token is printed once by the launcher, never returned by the API.
    return {"connected": _CONNECTED, "live_trading_enabled": _LIVE_ENABLED,
            "max_risk_percent": _MAX_RISK_PERCENT, "server_time": datetime.now(timezone.utc).isoformat()}


@APP.post("/login")
def login(body: LoginRequest, _: None = Depends(auth)) -> dict:
    global _CONNECTED, _ACCOUNT_LOGIN
    package = mt5()
    with _LOCK:
        package.shutdown()
        args = {"login": body.login, "password": body.password.get_secret_value(), "server": body.server}
        if body.terminal_path:
            args["path"] = body.terminal_path
        ok = package.initialize(**args)
        if not ok:
            code, message = package.last_error()
            package.shutdown()
            raise HTTPException(502, f"MT5 initialization failed ({code}): {message}")
        account = package.account_info()
        if account is None:
            package.shutdown()
            raise HTTPException(502, "MT5 connected but account information is unavailable")
        _CONNECTED, _ACCOUNT_LOGIN = True, int(account.login)
        return {"connected": True, "account": plain(account), "terminal": plain(package.terminal_info())}


@APP.post("/logout")
def logout(_: None = Depends(auth)) -> dict:
    global _CONNECTED, _ACCOUNT_LOGIN
    with _LOCK:
        if _MT5 is not None:
            _MT5.shutdown()
        _CONNECTED, _ACCOUNT_LOGIN = False, None
    return {"connected": False}


@APP.get("/account")
def account(_: None = Depends(auth)) -> dict:
    package = connected()
    info = package.account_info()
    if info is None:
        raise HTTPException(502, "Account snapshot unavailable")
    return plain(info)


@APP.get("/symbols")
def symbols(search: str = "", _: None = Depends(auth)) -> dict:
    package = connected()
    rows = package.symbols_get()
    if rows is None:
        raise HTTPException(502, "Symbol list unavailable")
    needle = search.casefold().strip()
    data = [plain(x) for x in rows if not needle or needle in x.name.casefold()]
    return {"count": len(data), "symbols": data[:1000]}


@APP.get("/tick/{symbol}")
def tick(symbol: str, _: None = Depends(auth)) -> dict:
    package = connected()
    if not package.symbol_select(symbol, True):
        raise HTTPException(404, f"Symbol unavailable: {symbol}")
    value = package.symbol_info_tick(symbol)
    if value is None:
        raise HTTPException(502, "Tick unavailable")
    return plain(value)


@APP.get("/positions")
def positions(_: None = Depends(auth)) -> dict:
    rows = connected().positions_get()
    if rows is None:
        raise HTTPException(502, "Positions unavailable")
    return {"count": len(rows), "positions": [plain(x) for x in rows]}


@APP.get("/orders")
def orders(_: None = Depends(auth)) -> dict:
    rows = connected().orders_get()
    if rows is None:
        raise HTTPException(502, "Orders unavailable")
    return {"count": len(rows), "orders": [plain(x) for x in rows]}


@APP.get("/history/deals")
def deals(days: int = 30, _: None = Depends(auth)) -> dict:
    if not 1 <= days <= 365:
        raise HTTPException(400, "days must be between 1 and 365")
    package = connected()
    from datetime import timedelta
    rows = package.history_deals_get(datetime.now() - timedelta(days=days), datetime.now())
    if rows is None:
        raise HTTPException(502, "Deal history unavailable")
    return {"count": len(rows), "deals": [plain(x) for x in rows]}


def validate_volume(info: Any, volume: float) -> None:
    if volume < info.volume_min or volume > info.volume_max:
        raise HTTPException(400, f"Volume must be between {info.volume_min} and {info.volume_max}")
    steps = round((volume - info.volume_min) / info.volume_step)
    aligned = info.volume_min + steps * info.volume_step
    if abs(aligned - volume) > 1e-8:
        raise HTTPException(400, f"Volume must align with step {info.volume_step}")


@APP.post("/orders")
def place_order(body: OrderRequest, _: None = Depends(auth)) -> dict:
    package = connected()
    account_info = package.account_info()
    if account_info is None:
        raise HTTPException(502, "Account state unavailable")
    if not account_info.trade_allowed or not account_info.trade_expert:
        raise HTTPException(403, "Broker account or terminal has disabled trading")
    if not account_info.trade_mode == package.ACCOUNT_TRADE_MODE_DEMO and not _LIVE_ENABLED:
        raise HTTPException(403, "Live trading is disabled. Set ETI_MT5_LIVE_TRADING=true on the Windows host only after testing.")
    if not package.symbol_select(body.symbol, True):
        raise HTTPException(404, "Symbol unavailable")
    info, tick_data = package.symbol_info(body.symbol), package.symbol_info_tick(body.symbol)
    if info is None or tick_data is None:
        raise HTTPException(502, "Symbol specification or tick unavailable")
    validate_volume(info, body.volume)
    is_buy = body.side == "buy"
    market = body.order_type == "market"
    order_type = (package.ORDER_TYPE_BUY if is_buy else package.ORDER_TYPE_SELL) if market else {
        "buy_limit": package.ORDER_TYPE_BUY_LIMIT, "sell_limit": package.ORDER_TYPE_SELL_LIMIT,
        "buy_stop": package.ORDER_TYPE_BUY_STOP, "sell_stop": package.ORDER_TYPE_SELL_STOP,
    }[body.order_type]
    price = (tick_data.ask if is_buy else tick_data.bid) if market else body.price
    if price is None:
        raise HTTPException(400, "Pending orders require a limit/stop price")
    if body.sl is None or body.tp is None:
        raise HTTPException(400, "ETI requires explicit Stop Loss and Take Profit")
    if is_buy and not (body.sl < price < body.tp):
        raise HTTPException(400, "Buy order requires SL < price < TP")
    if not is_buy and not (body.tp < price < body.sl):
        raise HTTPException(400, "Sell order requires TP < price < SL")
    # Estimate cash risk using broker-calculated P/L for the stop distance.
    pnl = package.order_calc_profit(order_type, body.symbol, body.volume, price, body.sl)
    if pnl is None or abs(float(pnl)) <= 0:
        raise HTTPException(400, "Unable to calculate stop-loss risk; order rejected")
    risk_pct = abs(float(pnl)) / float(account_info.equity) * 100 if account_info.equity else 999
    if risk_pct > _MAX_RISK_PERCENT:
        raise HTTPException(403, f"Risk {risk_pct:.3f}% exceeds bridge limit {_MAX_RISK_PERCENT:.3f}%")
    request = {"action": package.TRADE_ACTION_DEAL if market else package.TRADE_ACTION_PENDING,
               "symbol": body.symbol, "volume": body.volume, "type": order_type, "price": float(price),
               "sl": body.sl, "tp": body.tp, "deviation": body.deviation,
               "magic": 611050, "comment": body.comment,
               "type_time": package.ORDER_TIME_GTC, "type_filling": info.filling_mode}
    checked = package.order_check(request)
    if checked is None or checked.retcode != 0:
        raise HTTPException(400, {"message": "Broker order_check rejected the request", "check": plain(checked)})
    result = package.order_send(request)
    if result is None:
        raise HTTPException(502, "Broker returned no order result")
    if result.retcode not in {package.TRADE_RETCODE_DONE, package.TRADE_RETCODE_PLACED, package.TRADE_RETCODE_DONE_PARTIAL}:
        raise HTTPException(502, {"message": "Broker rejected order", "result": plain(result)})
    return {"accepted": True, "result": plain(result), "risk_percent": round(risk_pct, 4),
            "account_login": _ACCOUNT_LOGIN}


@APP.post("/positions/close")
def close_position(body: CloseRequest, _: None = Depends(auth)) -> dict:
    package = connected()
    rows = package.positions_get(ticket=body.ticket)
    if not rows:
        raise HTTPException(404, "Position not found")
    position = rows[0]
    volume = body.volume or position.volume
    if volume > position.volume:
        raise HTTPException(400, "Close volume exceeds open position volume")
    tick_data = package.symbol_info_tick(position.symbol)
    if tick_data is None:
        raise HTTPException(502, "Current tick unavailable")
    is_buy = position.type == package.POSITION_TYPE_BUY
    request = {"action": package.TRADE_ACTION_DEAL, "position": position.ticket,
               "symbol": position.symbol, "volume": volume,
               "type": package.ORDER_TYPE_SELL if is_buy else package.ORDER_TYPE_BUY,
               "price": tick_data.bid if is_buy else tick_data.ask,
               "deviation": 20, "magic": 611050, "comment": "ETI close",
               "type_time": package.ORDER_TIME_GTC,
               "type_filling": package.symbol_info(position.symbol).filling_mode}
    check = package.order_check(request)
    if check is None or check.retcode != 0:
        raise HTTPException(400, {"message": "Close check rejected", "check": plain(check)})
    result = package.order_send(request)
    if result is None or result.retcode not in {package.TRADE_RETCODE_DONE, package.TRADE_RETCODE_DONE_PARTIAL}:
        raise HTTPException(502, {"message": "Close request failed", "result": plain(result)})
    return {"closed": True, "result": plain(result)}


# Explicit loopback binding is enforced by start-mt5-bridge.ps1.
