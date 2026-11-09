"""Track whether open mispricing alerts converge, using fresh scanner prices only."""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.quant import db_models as m
from app.quant.scanner import GlobalScanner
from app.quant.service import QuantStore


def track_open_alerts(db: Session, scanner: GlobalScanner) -> dict:
    store = QuantStore(db)
    symbols = [r[0] for r in db.query(m.MispricingAlert.symbol).filter_by(status="open").distinct()]
    checked = converged = skipped_stale = 0
    for sym in symbols:
        cov = scanner.coverage.get(sym)
        if cov is None or cov.price is None or cov.status != "ACTIVE":
            skipped_stale += 1          # never judge convergence on stale/unavailable prices
            continue
        checked += 1
        converged += store.track_convergence(sym, cov.price)
    return {"open_symbols": len(symbols), "checked": checked, "converged": converged,
            "skipped_stale_or_unavailable": skipped_stale}
