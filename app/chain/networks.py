"""Supported EVM networks and operator-controlled limits (all read from the environment at call time).

Safety defaults: testnets only unless the operator explicitly enables mainnet sending; allowlist required; small caps.
"""
from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse


@dataclass(frozen=True)
class Network:
    key: str
    label: str
    chain_id: int
    native: str
    mainnet: bool
    explorer: str
    default_rpc: Optional[str] = None
    infura: Optional[str] = None  # Infura host, used with INFURA_API_KEY


NETWORKS: dict[str, Network] = {n.key: n for n in (
    Network("sepolia", "Ethereum Sepolia (testnet)", 11155111, "ETH", False, "https://sepolia.etherscan.io",
            "https://ethereum-sepolia-rpc.publicnode.com", "sepolia.infura.io"),
    Network("base-sepolia", "Base Sepolia (testnet)", 84532, "ETH", False, "https://sepolia.basescan.org", None, "base-sepolia.infura.io"),
    Network("bsc-testnet", "BNB Chain testnet", 97, "BNB", False, "https://testnet.bscscan.com", None, "bsc-testnet.infura.io"),
    Network("polygon-amoy", "Polygon Amoy (testnet)", 80002, "POL", False, "https://amoy.polygonscan.com", None, "polygon-amoy.infura.io"),
    Network("ethereum", "Ethereum mainnet", 1, "ETH", True, "https://etherscan.io", None, "mainnet.infura.io"),
    Network("base", "Base mainnet", 8453, "ETH", True, "https://basescan.org", None, "base-mainnet.infura.io"),
    Network("bsc", "BNB Chain mainnet", 56, "BNB", True, "https://bscscan.com", None, "bsc-mainnet.infura.io"),
    Network("polygon", "Polygon mainnet", 137, "POL", True, "https://polygonscan.com", None, "polygon-mainnet.infura.io"),
)}


@dataclass(frozen=True)
class Limits:
    max_slippage_bps: int
    require_allowlist: bool
    mainnet_send_enabled: bool


def _env(key: str) -> str:
    return key.upper().replace("-", "_")


_INFURA_KEY = re.compile(r"^[0-9a-fA-F]{32}$")


def _infura_key() -> str:
    k = (os.getenv("INFURA_API_KEY") or "").strip()
    return k if _INFURA_KEY.match(k) else ""


def rpc_url(network: str) -> Optional[str]:
    """Explicit CHAIN_RPC_<NETWORK> first, then Infura (INFURA_API_KEY secret), then the built-in public default.
    The URL may contain a key: never log it or return it to a client."""
    explicit = os.getenv("CHAIN_RPC_" + _env(network))
    if explicit:
        return explicit
    net, key = NETWORKS[network], _infura_key()
    if key and net.infura:
        return f"https://{net.infura}/v3/{key}"
    return net.default_rpc


def rpc_headers(url: str) -> dict[str, str]:
    """INFURA_API_SECRET is sent only to *.infura.io, as HTTP Basic with an empty user name."""
    secret = (os.getenv("INFURA_API_SECRET") or "").strip()
    host = (urlparse(url).hostname or "")
    if not secret or not host.endswith(".infura.io"):
        return {}
    return {"Authorization": "Basic " + base64.b64encode((":" + secret).encode()).decode()}


def dex_config(network: str) -> tuple[Optional[str], Optional[str]]:
    """(UniswapV2-style router, wrapped-native token). Never hard-coded: the operator must verify and supply them."""
    return os.getenv("CHAIN_DEX_ROUTER_" + _env(network)), os.getenv("CHAIN_WRAPPED_NATIVE_" + _env(network))


def _flag(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


def load_limits() -> Limits:
    try:
        bps = int(os.getenv("CHAIN_MAX_SLIPPAGE_BPS", "100"))
    except ValueError:
        bps = 100
    return Limits(max_slippage_bps=max(1, min(bps, 1000)), require_allowlist=_flag("CHAIN_REQUIRE_ALLOWLIST", True),
                  mainnet_send_enabled=_flag("CHAIN_MAINNET_SEND_ENABLED", False))


def chain_enabled() -> bool:
    return _flag("CHAIN_ENABLED", True)
