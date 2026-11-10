"""Process-wide PaperService built from application settings (the only paper module that imports config/db)."""
from __future__ import annotations

from typing import Optional

from app.config import get_settings
from app.database import SessionLocal

from .market import BinancePublicBook
from .service import PaperService, PaperSettings
from .store import SqlPaperStore

_service: Optional[PaperService] = None


def get_paper_service() -> PaperService:
    global _service
    if _service is None:
        s = get_settings()
        _service = PaperService(
            SqlPaperStore(SessionLocal), BinancePublicBook(),
            PaperSettings(starting_cash=s.paper_starting_equity, taker_fee_bps=s.paper_taker_fee_bps,
                          maker_fee_bps=s.paper_maker_fee_bps, extra_slippage_bps=s.paper_extra_slippage_bps,
                          max_position_notional_pct=s.paper_max_position_notional_pct),
            kill_switch=lambda: bool(get_settings().kill_switch))
    return _service
