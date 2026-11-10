"""Execution-mode resolution. The mode is always explicit in responses; nothing is switched silently and live is never simulated."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Optional

INTERNAL_PAPER = "INTERNAL_PAPER"
EXCHANGE_TESTNET = "EXCHANGE_TESTNET"
EXCHANGE_LIVE = "EXCHANGE_LIVE"
REJECT = "REJECT"

LABELS = {
    INTERNAL_PAPER: "INTERNAL PAPER - simulated by ETI, no exchange involved, no real money",
    EXCHANGE_TESTNET: "EXCHANGE TESTNET - sandbox orders sent to the exchange's test environment (needs testnet credentials)",
    EXCHANGE_LIVE: "LIVE TRADING - real money (disabled unless explicitly enabled and risk-gated)",
}


@dataclass
class ModeDecision:
    mode: str
    requested_environment: str
    reason: str
    downgraded: bool = False
    warning: Optional[str] = None

    @property
    def label(self) -> str:
        return LABELS.get(self.mode, "REJECTED")

    def to_dict(self) -> dict:
        d = asdict(self); d["label"] = self.label
        return d


def resolve_mode(provider: str, environment: str, *, creds_configured: bool, live_enabled: bool) -> ModeDecision:
    env = (environment or "").strip().lower()
    if env == "paper":
        return ModeDecision(INTERNAL_PAPER, env, "paper environment is always simulated internally")
    if env == "testnet":
        if creds_configured:
            return ModeDecision(EXCHANGE_TESTNET, env, "testnet credentials present: exchange sandbox")
        return ModeDecision(
            INTERNAL_PAPER, env, "no exchange credentials", downgraded=True,
            warning=f"No {provider} testnet credentials are configured, so this order was executed by ETI's INTERNAL PAPER engine. "
                    "It was NOT sent to any exchange or testnet.")
    if env == "live":
        if not live_enabled:
            return ModeDecision(REJECT, env, "live_trading_disabled")
        if not creds_configured:
            return ModeDecision(REJECT, env, "live_credentials_missing")
        return ModeDecision(EXCHANGE_LIVE, env, "live enabled and credentials present (risk gateway applies)")
    return ModeDecision(REJECT, env, "unknown_environment")
