"""LOCAL_ENVS / PROTECTED_ENVS must partition every environment Settings accepts.

Several modules use PROTECTED_ENVS from app.security.auth while require_api_key uses the LOCAL_ENVS
allowlist. If a new environment is added to Settings.app_env without being classified here, one side
would silently treat it as the other, so this test fails instead.
"""
from typing import get_args

import pytest

import app.security.auth as auth
from app.config import Settings


def test_env_sets_are_disjoint_and_cover_settings_literal():
    valid = set(get_args(Settings.model_fields["app_env"].annotation))
    assert auth.LOCAL_ENVS.isdisjoint(auth.PROTECTED_ENVS)
    assert auth.LOCAL_ENVS | auth.PROTECTED_ENVS == valid


@pytest.mark.parametrize("name", ["PROTECTED_ENVS", "LOCAL_ENVS"])
def test_env_constants_are_immutable(name):
    assert isinstance(getattr(auth, name), frozenset)


def test_every_module_that_uses_protected_envs_shares_the_one_definition():
    # app.main and app.api.intel import the name; app.alpha.access reads it through the auth module.
    import app.alpha.access as access
    import app.api.intel as intel
    import app.main as main

    assert main.PROTECTED_ENVS is auth.PROTECTED_ENVS
    assert intel.PROTECTED_ENVS is auth.PROTECTED_ENVS
    assert access.auth is auth
