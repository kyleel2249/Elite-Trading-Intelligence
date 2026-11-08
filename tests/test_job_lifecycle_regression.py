import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
import app.main as main
from app.jobs.investor_monitor import InvestorMonitorJob
from app.jobs.mark_to_market import MarkToMarketJob
from app.jobs.reconcile import ReconcileJob


@pytest.mark.asyncio
@pytest.mark.parametrize("job_type", [InvestorMonitorJob, MarkToMarketJob, ReconcileJob])
async def test_stop_cancels_and_releases_task_and_can_restart(job_type, monkeypatch):
    job = job_type()
    monkeypatch.setattr(job, "run_once", AsyncMock())
    for _ in range(2):
        await job.start()
        task = job._task
        await asyncio.sleep(0)
        await job.stop()
        assert task.done()
        assert job._task is None
        assert job._running is False
        await job.stop()


@pytest.mark.asyncio
async def test_lifespan_cleans_all_components_after_exception(monkeypatch):
    monkeypatch.setattr(main, "init_db", lambda: None)
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(mtm_interval_seconds=1,
        reconcile_interval_seconds=1, investor_monitor_interval_seconds=1, quiver_configured=True))
    components = []
    for name in ("stream_hub", "mtm_job", "reconcile_job", "investor_monitor_job"):
        component = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
        monkeypatch.setattr(main, name, component)
        components.append(component)
    components[-1].stop.side_effect = RuntimeError("simulated stop failure")
    with pytest.raises(ValueError, match="body failure"):
        async with main.lifespan(main.app):
            raise ValueError("body failure")
    for component in components:
        component.stop.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("job_type", [InvestorMonitorJob, MarkToMarketJob, ReconcileJob])
async def test_stop_releases_already_failed_task(job_type):
    job = job_type()
    async def fail():
        raise RuntimeError("simulated task failure")
    job._task = asyncio.create_task(fail())
    await asyncio.sleep(0)
    with pytest.raises(RuntimeError, match="simulated task failure"):
        await job.stop()
    assert job._task is None
    assert not job._running
