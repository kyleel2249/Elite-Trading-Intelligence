"""Etherscan-compatible explorer client (read-only). Needs a key and base URL
supplied by the operator; ETI does not assume a particular chain's endpoint."""
from __future__ import annotations

from typing import Any, Optional

import httpx


class ExplorerClient:
    def __init__(self, base_url: Optional[str], api_key: Optional[str], client: Optional[httpx.AsyncClient] = None):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key
        self._client = client

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.api_key)

    async def token_transfers(self, contract: str, page: int = 1, offset: int = 200) -> list[dict[str, Any]]:
        if not self.configured:
            return []
        params = {"module": "account", "action": "tokentx", "contractaddress": contract, "page": page,
                  "offset": offset, "sort": "desc", "apikey": self.api_key}
        try:
            if self._client is not None:
                r = await self._client.get(self.base_url, params=params)
            else:
                async with httpx.AsyncClient(timeout=20.0) as c:
                    r = await c.get(self.base_url, params=params)
            r.raise_for_status()
            body = r.json()
        except httpx.HTTPStatusError as exc:  # the request URL carries the api key; never propagate it
            raise RuntimeError(f"explorer HTTP {exc.response.status_code}") from None
        except (httpx.HTTPError, ValueError) as exc:
            raise RuntimeError(f"explorer request failed: {type(exc).__name__}") from None
        res = body.get("result")
        if body.get("status") != "1" or not isinstance(res, list):
            return []
        return res
