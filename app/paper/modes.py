"""Execution-mode resolution. Three environments, never mixed, never switched silently.

INTERNAL PAPER   simulated by ETI, no credentials, no exchange involved.
EXCHANGE TESTNET orders go to an exchange sandbox through a registered execution account (credentials supplied).
LIVE             real money. Not available through this paper path; requesting it is an error, not a fallback.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

INTERNAL_PAPER = "internal_paper"
EXCHANGE_TESTNET = "exchange_testnet"
LIVE = "live"

LABELS = {INTERNAL_PAPER: "INTERNAL PAPER (simulated, no exchange)",
          EXCHANGE_TESTNET: "EXCHANGE TESTNET (sandbox orders)",
          LIVE: "LIVE TRADING (disabled)"}


class LiveTradingDisabled(Exception):
    pass


class UnknownMode(ValueError):
    pass


@dataclass(frozen=True)
class ModeResolution:
    mode: str
    requested: str
    downgraded: bool
    reason: str

    @property
    def label(self) -> str:
        return LABELS[self.mode]

    def to_dict(self) -> dict:
        return {"mode": self.mode, "label": self.label, "requested": self.requested,
                "downgraded": self.downgraded, "reason": self.reason}


def resolve_mode(requested: Optional[str], *, testnet_account_available: bool, provider: str = "binance",
                 env_credentials_present: bool = False) -> ModeResolution:
    """Pick the mode. A missing-credentials request for testnet falls back to INTERNAL PAPER and says so."""
    req = (requested or "auto").strip().lower()
    if req == LIVE:
        raise LiveTradingDisabled("Live trading is disabled. The paper API never places real-money orders.")
    if req in ("auto", INTERNAL_PAPER, "internal", "paper"):
        return ModeResolution(INTERNAL_PAPER, req, False, "Simulated by ETI; no exchange credentials are used.")
    if req in (EXCHANGE_TESTNET, "testnet"):
        if testnet_account_available:
            return ModeResolution(EXCHANGE_TESTNET, req, False, f"Routing to a registered {provider} testnet account.")
        hint = (" Credentials exist in the environment but no execution account is registered for them;"
                " register one to enable connected mode." if env_credentials_present else "")
        return ModeResolution(INTERNAL_PAPER, req, True,
                              f"No {provider} testnet credentials/execution account available, so ETI is using "
                              f"INTERNAL PAPER instead. Nothing was sent to an exchange.{hint}")
    raise UnknownMode(f"Unknown mode '{requested}'. Use internal_paper or exchange_testnet.")
