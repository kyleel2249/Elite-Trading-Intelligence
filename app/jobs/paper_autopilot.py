"""Compatibility shim. app.main drives `paper_job`; the work is done by the internal paper exchange's own tick job
(app.paper.service.PaperTickJob via app.paper.runtime), which advances resting limit/stop/take-profit orders.

An earlier council-driven paper autopilot that lived in this module was removed because it was built against a
parallel paper engine that collided with the internal paper exchange (see git history).
"""
from __future__ import annotations

from typing import Any


class _PaperJobAdapter:
    def configure(self, settings: Any) -> None:
        from app.paper.runtime import get_tick_job
        interval = getattr(settings, "paper_tick_interval_seconds", None)
        if interval:
            get_tick_job().interval_seconds = max(1.0, float(interval))

    async def start(self) -> None:
        from app.paper.runtime import get_tick_job
        await get_tick_job().start()

    async def stop(self) -> None:
        from app.paper.runtime import get_tick_job
        await get_tick_job().stop()

    def status(self) -> dict:
        from app.paper.runtime import get_tick_job
        return {**get_tick_job().status(), "mode": "internal_paper"}


paper_job = _PaperJobAdapter()
