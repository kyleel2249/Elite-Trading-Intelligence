"""On-chain whale / smart-money analysis.

Attribution rules: a public address is 'unattributed' unless a labelled record with a
source exists. Unverified labels are capped at 0.5 confidence and can never name an
individual. ETI ships NO hard-coded exchange or fund addresses; labels are supplied
by the operator from verifiable sources.
"""
from __future__ import annotations

from typing import Any, Optional

from sqlalchemy.orm import Session

from app.alpha.db_models import WalletLabel

ENTITY_TYPES = ("exchange", "fund", "treasury", "protocol", "individual", "unknown")
ZERO = "0x0000000000000000000000000000000000000000"


def add_wallet_label(db: Session, chain: str, address: str, label: str, entity_type: str, source: str,
                     confidence: float, verified: bool = False) -> WalletLabel:
    if not source or not source.strip():
        raise ValueError("a wallet label requires a source")
    if entity_type not in ENTITY_TYPES:
        raise ValueError(f"entity_type must be one of {ENTITY_TYPES}")
    if not 0 < confidence <= 1:
        raise ValueError("confidence must be in (0,1]")
    address = address.lower()
    if not verified:
        confidence = min(confidence, 0.5)
        if entity_type == "individual":
            raise ValueError("an individual cannot be attributed to an address without a verified source")
    row = db.query(WalletLabel).filter_by(chain=chain, address=address).one_or_none()
    if row is None:
        row = WalletLabel(chain=chain, address=address, label=label, entity_type=entity_type, source=source, confidence=confidence, verified=verified)
        db.add(row)
    else:
        row.label, row.entity_type, row.source, row.confidence, row.verified = label, entity_type, source, confidence, verified
    db.commit()
    return row


def attribute(db: Session, chain: str, address: str) -> dict[str, Any]:
    row = db.query(WalletLabel).filter_by(chain=chain, address=address.lower()).one_or_none()
    if row is None:
        return {"address": address.lower(), "label": None, "entity_type": "unknown", "confidence": 0.0, "verified": False,
                "note": "unattributed public address; no identity is claimed"}
    return {"address": row.address, "label": row.label, "entity_type": row.entity_type, "confidence": row.confidence,
            "verified": row.verified, "source": row.source}


def analyze_transfers(transfers: list[dict[str, Any]], *, price_usd: Optional[float], threshold_usd: float,
                      labels: dict[str, dict[str, Any]], total_supply_tokens: Optional[float] = None) -> dict[str, Any]:
    """transfers: explorer tokentx rows. labels: address->attribution dict (from attribute())."""
    if not transfers:
        return {"status": "no_data", "component": None}
    if not price_usd or price_usd <= 0:
        return {"status": "no_price", "component": None, "note": "USD sizing needs a reference price"}
    net: dict[str, float] = {}
    large = []
    ex_in = ex_out = 0.0
    for t in transfers:
        try:
            dec = int(t.get("tokenDecimal") or 18)
            amt = float(t["value"]) / (10 ** dec)
            frm, to = str(t["from"]).lower(), str(t["to"]).lower()
        except (KeyError, ValueError, TypeError):
            continue
        usd = amt * price_usd
        net[to] = net.get(to, 0.0) + amt
        net[frm] = net.get(frm, 0.0) - amt
        to_ex = (labels.get(to) or {}).get("entity_type") == "exchange"
        fr_ex = (labels.get(frm) or {}).get("entity_type") == "exchange"
        if to_ex:
            ex_in += usd
        if fr_ex:
            ex_out += usd
        if usd >= threshold_usd:
            large.append({"hash": t.get("hash"), "from": frm, "to": to, "usd": round(usd, 2), "ts": t.get("timeStamp"),
                          "to_exchange": to_ex, "from_exchange": fr_ex})
    skip = {ZERO}
    holders = {a: v for a, v in net.items() if a not in skip and (labels.get(a) or {}).get("entity_type") not in ("exchange", "protocol")}
    top_acc = sorted(((a, v) for a, v in holders.items() if v > 0), key=lambda x: -x[1])[:10]
    top_dist = sorted(((a, v) for a, v in holders.items() if v < 0), key=lambda x: x[1])[:10]
    labelled_ex = sum(1 for a in labels.values() if a.get("entity_type") == "exchange")
    flow_known = labelled_ex > 0
    comp = None
    if flow_known and (ex_in + ex_out) > 0:
        comp = max(0.0, min(100.0, 50 + (ex_out - ex_in) / (ex_in + ex_out) * 50))
    return {"status": "ok", "transfers_analysed": len(transfers), "large_transfers": large[:25],
            "exchange_inflow_usd": round(ex_in, 2), "exchange_outflow_usd": round(ex_out, 2),
            "net_exchange_flow_usd": round(ex_in - ex_out, 2) if flow_known else None,
            "top_net_accumulators": [{"address": a, "net_tokens": v, "attribution": labels.get(a) or {"label": None, "confidence": 0.0, "note": "unattributed"}} for a, v in top_acc],
            "top_net_distributors": [{"address": a, "net_tokens": v, "attribution": labels.get(a) or {"label": None, "confidence": 0.0, "note": "unattributed"}} for a, v in top_dist],
            "exchange_flow_measurable": flow_known,
            "component": round(comp, 1) if comp is not None else None,
            "limits": ["window is the most recent transfers returned by the explorer, not full history",
                       "exchange flows count only addresses labelled as exchanges in ETI's label table",
                       "dormant-wallet activation needs per-address history and is not computed here"]}
