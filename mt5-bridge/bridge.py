"""Local Windows MetaTrader 5 bridge for ETI.

The bridge binds only to loopback. Broker credentials are accepted only by
/login, passed directly to the local MT5 terminal, and never logged or saved.
Live order placement is disabled unless ETI_MT5_LIVE_TRADING=true is set.
"""
from __future__ import annotations

import hmac
import math
import os
import secrets
import threading
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse
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
try:
    _configured_risk = float(os.environ.get("ETI_MT5_MAX_RISK_PERCENT", "0.5"))
except (TypeError, ValueError):
    _configured_risk = 0.5
_MAX_RISK_PERCENT = min(5.0, max(0.05, _configured_risk)) if math.isfinite(_configured_risk) else 0.5
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


@APP.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    return r"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETI · MT5 Local Trading Terminal</title><style>
:root{color-scheme:dark;--bg:#080e18;--panel:#111c2c;--line:#26364d;--muted:#93a7c1;--blue:#54a8ff;--green:#22d69b;--red:#ff6b80}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 50% 0,#172944,#080e18 55%);color:#edf4ff;font:14px Inter,Segoe UI,Arial,sans-serif}
header{padding:18px 4vw;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
h1{font-size:20px;margin:0}main{max-width:1500px;margin:auto;padding:22px 4vw}.muted,small{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.panel{background:linear-gradient(145deg,#142238,#0e1726);border:1px solid var(--line);border-radius:13px;padding:16px;min-width:0;margin-bottom:14px}
.panel h2{font-size:14px;margin:0 0 14px}.metric{font-size:23px;font-weight:700;margin-top:8px}
input,select,button{background:#091423;color:#edf4ff;border:1px solid var(--line);border-radius:8px;padding:10px;width:100%;min-width:0}
button{cursor:pointer;font-weight:650}button.primary{background:#14518c;border-color:#267bc4}button.buy{background:#075c45;border-color:#158a67}button.sell{background:#722c40;border-color:#b94d67}
form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}label{display:grid;gap:6px;color:var(--muted);font-size:12px}.wide{grid-column:1/-1}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row>*{flex:1}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted)}
.scroll{overflow:auto}.status{padding:6px 10px;border-radius:30px;border:1px solid var(--line);font-size:12px}.ok{color:var(--green)}.bad{color:var(--red)}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:520px){main{padding:14px}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}form{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body><header><div><h1>ETI · MT5 Trading Terminal</h1><small>Local Windows connector · Broker credentials remain on this PC</small></div><span id="state" class="status bad">Disconnected</span></header><main>
<section class="panel"><h2>Secure bridge access</h2><form id="tokenForm"><label class="wide">Bridge bearer token<input id="token" type="password" autocomplete="off" required placeholder="Paste the token printed by the PowerShell launcher"></label><button class="primary wide">Unlock local terminal</button></form></section>
<section class="panel"><h2>Connect trading account</h2><form id="loginForm">
<label>MT5 account number<input id="login" type="number" min="1" required></label><label>Broker server<input id="server" required placeholder="Broker-Demo or Broker-Live"></label>
<label class="wide">Trading password<input id="password" type="password" autocomplete="off" required></label>
<label class="wide">Terminal path (optional)<input id="path" placeholder="C:\Program Files\Broker MT5\terminal64.exe"></label>
<button class="primary wide">Connect account</button></form><div id="message" class="muted" role="status"></div></section>
<div class="grid"><div class="panel"><small>Balance</small><div class="metric" id="balance">—</div></div><div class="panel"><small>Equity</small><div class="metric" id="equity">—</div></div><div class="panel"><small>Free margin</small><div class="metric" id="margin">—</div></div><div class="panel"><small>Floating P/L</small><div class="metric" id="profit">—</div></div></div>
<section class="panel"><div class="row"><h2>Market Watch</h2><input id="search" placeholder="Search symbol" style="max-width:220px"><button id="refresh" class="primary" style="max-width:120px">Refresh</button><button id="logout" style="max-width:120px">Disconnect</button></div><div class="scroll"><table><thead><tr><th>Symbol</th><th>Bid</th><th>Ask</th><th>Spread</th><th>Digits</th></tr></thead><tbody id="symbols"></tbody></table></div></section>
<section class="panel"><h2>Order ticket</h2><form id="orderForm">
<label>Symbol<input id="symbol" required placeholder="EURUSD"></label><label>Direction<select id="side"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
<label>Order type<select id="type"><option value="market">Market</option><option value="buy_limit">Buy Limit</option><option value="sell_limit">Sell Limit</option><option value="buy_stop">Buy Stop</option><option value="sell_stop">Sell Stop</option></select></label><label>Volume (lots)<input id="volume" type="number" min="0.001" step="0.001" value="0.01" required></label>
<label>Pending price (pending only)<input id="price" type="number" step="any"></label><label>Stop Loss<input id="sl" type="number" step="any" required></label><label>Take Profit<input id="tp" type="number" step="any" required></label>
<button class="buy" type="submit">Submit guarded order</button><button id="quote" type="button">Get selected symbol tick</button></form><p class="muted">Every order requires SL and TP, broker volume validation, calculated stop-loss risk and broker order_check. Live execution remains disabled unless explicitly enabled on this PC.</p></section>
<section class="panel"><h2>Open positions</h2><div class="scroll"><table><thead><tr><th>Ticket</th><th>Symbol</th><th>Side</th><th>Volume</th><th>Open price</th><th>SL</th><th>TP</th><th>Profit</th><th>Action</th></tr></thead><tbody id="positions"></tbody></table></div></section>
<section class="panel"><h2>Pending orders</h2><div class="scroll"><table><thead><tr><th>Ticket</th><th>Symbol</th><th>Type</th><th>Volume</th><th>Price</th><th>SL</th><th>TP</th></tr></thead><tbody id="orders"></tbody></table></div></section>
</main><script>
let token=sessionStorage.getItem("eti_mt5_token")||"";const $=id=>document.getElementById(id);$("token").value=token;
function auth(){return token?{"Authorization":"Bearer "+token,"Content-Type":"application/json"}:{"Content-Type":"application/json"}}
async function api(path,options={}){const r=await fetch(path,{...options,headers:{...auth(),...(options.headers||{})}});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.detail?JSON.stringify(d.detail):d.message||d.error||("HTTP "+r.status));return d}
function esc(v){return String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]))}function money(v,c){return Number(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+(c?" "+esc(c):"")}
function msg(t,bad=false){$("message").textContent=t;$("message").className=bad?"bad":"muted"}
$("tokenForm").onsubmit=e=>{e.preventDefault();token=$("token").value.trim();sessionStorage.setItem("eti_mt5_token",token);load().catch(e=>msg(e.message,true))};
$("loginForm").onsubmit=async e=>{e.preventDefault();try{const d=await api("/login",{method:"POST",body:JSON.stringify({login:Number($("login").value),server:$("server").value,password:$("password").value,terminal_path:$("path").value||null})});$("password").value="";msg("Connected to account "+d.account.login+" · "+d.account.server);await load()}catch(e){msg(e.message,true)}};
$("logout").onclick=async()=>{try{await api("/logout",{method:"POST"});msg("Account disconnected");await load()}catch(e){msg(e.message,true)}};
$("refresh").onclick=()=>load().catch(e=>msg(e.message,true));
async function load(){if(!token)throw Error("Enter the bridge token first");const a=await api("/account");$("state").textContent="Connected · "+a.login;$("state").className="status ok";$("balance").textContent=money(a.balance,a.currency);$("equity").textContent=money(a.equity,a.currency);$("margin").textContent=money(a.margin_free,a.currency);$("profit").textContent=money(a.profit,a.currency);
const [s,p,o]=await Promise.all([api("/symbols?search="+encodeURIComponent($("search").value)),api("/positions"),api("/orders")]);
$("symbols").innerHTML=s.symbols.slice(0,80).map(x=>"<tr><td>"+esc(x.name)+"</td><td>"+(x.bid||"—")+"</td><td>"+(x.ask||"—")+"</td><td>"+(x.spread||"—")+"</td><td>"+x.digits+"</td></tr>").join("");
$("positions").innerHTML=p.positions.map(x=>"<tr><td>"+x.ticket+"</td><td>"+esc(x.symbol)+"</td><td>"+(x.type===0?"BUY":"SELL")+"</td><td>"+x.volume+"</td><td>"+x.price_open+"</td><td>"+x.sl+"</td><td>"+x.tp+"</td><td>"+money(x.profit,a.currency)+"</td><td><button data-close='"+x.ticket+"'>Close</button></td></tr>").join("")||"<tr><td colspan='9'>No open positions</td></tr>";
$("orders").innerHTML=o.orders.map(x=>"<tr><td>"+x.ticket+"</td><td>"+x.symbol+"</td><td>"+x.type+"</td><td>"+x.volume_current+"</td><td>"+x.price_open+"</td><td>"+x.sl+"</td><td>"+x.tp+"</td></tr>").join("")||"<tr><td colspan='7'>No pending orders</td></tr>";
}
$("search").onchange=()=>load().catch(e=>msg(e.message,true));
$("positions").onclick=async e=>{const t=e.target.dataset.close;if(!t)return;if(!confirm("Close position "+t+"?"))return;try{await api("/positions/close",{method:"POST",body:JSON.stringify({ticket:Number(t)})});await load()}catch(err){msg(err.message,true)}};
$("quote").onclick=async()=>{try{const t=await api("/tick/"+encodeURIComponent($("symbol").value));msg("Bid "+t.bid+" · Ask "+t.ask)}catch(e){msg(e.message,true)}};
$("orderForm").onsubmit=async e=>{e.preventDefault();const type=$("type").value;const body={symbol:$("symbol").value.trim(),side:$("side").value,order_type:type,volume:Number($("volume").value),sl:Number($("sl").value),tp:Number($("tp").value)};if(type!=="market")body.price=Number($("price").value);if(!confirm("Send "+body.side.toUpperCase()+" "+body.volume+" "+body.symbol+" order with SL/TP?"))return;try{const d=await api("/orders",{method:"POST",body:JSON.stringify(body)});msg("Order accepted · risk "+d.risk_percent+"%");await load()}catch(err){msg(err.message,true)}};
if(token)load().catch(e=>msg(e.message,true));
</script></body></html>"""


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
    pending_sides = {"buy_limit": "buy", "buy_stop": "buy", "sell_limit": "sell", "sell_stop": "sell"}
    if not market and pending_sides[body.order_type] != body.side:
        raise HTTPException(400, "Order side does not match pending order type")
    order_type = (package.ORDER_TYPE_BUY if is_buy else package.ORDER_TYPE_SELL) if market else {
        "buy_limit": package.ORDER_TYPE_BUY_LIMIT, "sell_limit": package.ORDER_TYPE_SELL_LIMIT,
        "buy_stop": package.ORDER_TYPE_BUY_STOP, "sell_stop": package.ORDER_TYPE_SELL_STOP,
    }[body.order_type]
    price = (tick_data.ask if is_buy else tick_data.bid) if market else body.price
    if price is None:
        raise HTTPException(400, "Pending orders require a limit/stop price")
    if body.order_type == "buy_limit" and price >= tick_data.ask:
        raise HTTPException(400, "Buy Limit price must be below the current ask")
    if body.order_type == "buy_stop" and price <= tick_data.ask:
        raise HTTPException(400, "Buy Stop price must be above the current ask")
    if body.order_type == "sell_limit" and price <= tick_data.bid:
        raise HTTPException(400, "Sell Limit price must be above the current bid")
    if body.order_type == "sell_stop" and price >= tick_data.bid:
        raise HTTPException(400, "Sell Stop price must be below the current bid")
    if body.sl is None or body.tp is None:
        raise HTTPException(400, "ETI requires explicit Stop Loss and Take Profit")
    if is_buy and not (body.sl < price < body.tp):
        raise HTTPException(400, "Buy order requires SL < price < TP")
    if not is_buy and not (body.tp < price < body.sl):
        raise HTTPException(400, "Sell order requires TP < price < SL")
    # Estimate cash risk using broker-calculated P/L for the stop distance.
    calc_type = package.ORDER_TYPE_BUY if is_buy else package.ORDER_TYPE_SELL
    pnl = package.order_calc_profit(calc_type, body.symbol, body.volume, price, body.sl)
    if pnl is None or abs(float(pnl)) <= 0:
        raise HTTPException(400, "Unable to calculate stop-loss risk; order rejected")
    risk_pct = abs(float(pnl)) / float(account_info.equity) * 100 if account_info.equity else 999
    if risk_pct > _MAX_RISK_PERCENT:
        raise HTTPException(403, f"Risk {risk_pct:.3f}% exceeds bridge limit {_MAX_RISK_PERCENT:.3f}%")
    filling = package.ORDER_FILLING_RETURN if not market else (
        package.ORDER_FILLING_IOC if info.filling_mode & package.SYMBOL_FILLING_IOC
        else package.ORDER_FILLING_FOK
    )
    request = {"action": package.TRADE_ACTION_DEAL if market else package.TRADE_ACTION_PENDING,
               "symbol": body.symbol, "volume": body.volume, "type": order_type, "price": float(price),
               "sl": body.sl, "tp": body.tp, "deviation": body.deviation,
               "magic": 611050, "comment": body.comment,
               "type_time": package.ORDER_TIME_GTC, "type_filling": filling}
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
