"""HTTP transport seam. Adapters depend on this tiny interface, so tests can inject a fake."""
from __future__ import annotations

from typing import Any, Optional, Protocol

from ..errors import TransientProviderError, UnknownOutcomeError


class Transport(Protocol):
    async def request(self, method: str, url: str, *, params: Optional[dict] = None,
                      json: Optional[dict] = None, data: Optional[dict] = None,
                      headers: Optional[dict] = None, write: bool = False) -> tuple: ...
    """Returns (status_code, parsed_json_or_text). `write=True` marks calls that may change venue state."""


class HttpxTransport:
    """Default transport. httpx is imported lazily so unit tests need no network stack."""

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout

    async def request(self, method, url, *, params=None, json=None, data=None, headers=None, write=False):
        import httpx  # lazy
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.request(method, url, params=params, json=json, data=data, headers=headers)
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError) as e:
            # A write that times out may still have been accepted by the venue.
            err = UnknownOutcomeError if write else TransientProviderError
            raise err(f"{type(e).__name__} calling {httpx.URL(url).host}") from None
        try:
            body: Any = r.json()
        except ValueError:
            body = r.text[:500]
        return r.status_code, body
