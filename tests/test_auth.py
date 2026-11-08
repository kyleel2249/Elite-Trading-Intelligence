"""API-key auth: fail closed in production, constant-time match everywhere."""
import pytest
from fastapi import HTTPException

import app.security.auth as auth
from app.config import Settings


def _use(monkeypatch, **kwargs):
    settings = Settings(**kwargs)
    monkeypatch.setattr(auth, "get_settings", lambda: settings)


@pytest.mark.asyncio
async def test_dev_without_key_is_allowed(monkeypatch):
    _use(monkeypatch, app_env="development", api_key=None)
    assert await auth.require_api_key(x_api_key=None) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("env", ["production", "prod", "staging", "Production "])
async def test_protected_env_without_key_fails_closed(monkeypatch, env):
    _use(monkeypatch, app_env=env, api_key=None)
    with pytest.raises(HTTPException) as exc:
        await auth.require_api_key(x_api_key=None)
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_missing_or_wrong_key_rejected(monkeypatch):
    _use(monkeypatch, app_env="production", api_key="s3cret")
    for supplied in (None, "", "wrong", "s3cret "):
        with pytest.raises(HTTPException) as exc:
            await auth.require_api_key(x_api_key=supplied)
        assert exc.value.status_code == 401


@pytest.mark.asyncio
async def test_correct_key_accepted(monkeypatch):
    _use(monkeypatch, app_env="production", api_key="s3cret")
    assert await auth.require_api_key(x_api_key="s3cret") is None
