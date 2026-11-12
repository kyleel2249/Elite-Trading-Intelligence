"""Supported EVM networks and operator-controlled limits (all read from the environment at call time).

Safety defaults: testnets only unless the operator explicitly enables mainnet sending; allowlist required; small caps.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional


@dataclass(frozen=True)
class Network:
    key: str
    label: str
    chain_id: int
    native: str
    mainnet: bool
    explorer: str
    default_rpc: Optional[str] = None


NETWORKS: dict[str, Network] = {n.key: n for n in (
    Network("sepolia", "Ethereum Sepolia (testnet)", 11155111, "ETH", False, "https://sepolia.etherscan.io",
            "https://ethereum-sepolia-rpc.publicnode.com"),
    Network("base-sepolia", "Base Sepolia (testnet)", 84532, "ETH", False, "https://sepolia.basescan.org"),
    Network("bsc-testnet", "BNB Chain testnet", 97, "BNB", False, "https://testnet.bscscan.com"),
    Network("polygon-amoy", "Polygon Amoy (testnet)", 80002, "POL", False, "https://amoy.polygonscan.com"),
    Network("ethereum", "Ethereum mainnet", 1, "ETH", True, "https://etherscan.io"),
    Network("base", "Base mainnet", 8453, "ETH", True, "https://basescan.org"),
    Network("bsc", "BNB Chain mainnet", 56, "BNB", True, "https://bscscan.com"),
    Network("polygon", "Polygon mainnet", 137, "POL", True, "https://polygonscan.com"),
)}


@dataclass(frozen=True)
class Limits:
    max_tx_wei: int
    max_daily_wei: int
    max_slippage_bps: int
    require_allowlist: bool
    mainnet_send_enabled: bool


def _env(key: str) -> str:
    return key.upper().replace("-", "_")


def rpc_url(network: str) -> Optional[str]:
    return os.getenv("CHAIN_RPC_" + _env(network)) or NETWORKS[network].default_rpc


def dex_config(network: str) -> tuple[Optional[str], Optional[str]]:
    """(UniswapV2-style router, wrapped-native token). Never hard-coded: the operator must verify and supply them."""
    return os.getenv("CHAIN_DEX_ROUTER_" + _env(network)), os.getenv("CHAIN_WRAPPED_NATIVE_" + _env(network))


def _flag(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def _wei(name: str, default: str) -> int:
    try:
        d = Decimal(os.getenv(name, default))
    except Exception:
        d = Decimal(default)
    return int(d * Decimal(10) ** 18) if d > 0 else 0


def load_limits() -> Limits:
    try:
        bps = int(os.getenv("CHAIN_MAX_SLIPPAGE_BPS", "100"))
    except ValueError:
        bps = 100
    return Limits(max_tx_wei=_wei("CHAIN_MAX_TX_NATIVE", "0.05"), max_daily_wei=_wei("CHAIN_MAX_DAILY_NATIVE", "0.2"),
                  max_slippage_bps=max(1, min(bps, 1000)), require_allowlist=_flag("CHAIN_REQUIRE_ALLOWLIST", True),
                  mainnet_send_enabled=_flag("CHAIN_MAINNET_SEND_ENABLED", False))


def chain_enabled() -> bool:
    return _flag("CHAIN_ENABLED", True)
